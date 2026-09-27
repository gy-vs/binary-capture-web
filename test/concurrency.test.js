import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workbench } from '../src/store.js';
import { buildV1 } from '../src/protocol.js';

// 并发压力：N 个补丁与 M 个随机延迟查询交错；快照内部必须自洽：
//   - watermark == 最后一条消息/错误边界（无缺口前提下）
//   - 同一 revision 的任意两次查询结果一致
//   - 最终状态等于把全部片段按偏移线性重组的结果
test('并发压力：乱序补丁与延迟查询交错，快照自洽且最终状态正确', async () => {
  const wb = new Workbench();
  const sid = wb.createSession({ versions: ['v1'] });
  const frames = [];
  for (let i = 0; i < 12; i++) frames.push(buildV1({ seq: i + 1, cmd: 0x02, payload: Buffer.from([i]) }));

  // 每帧随机切成 2~3 片，打乱顺序导入
  const pieces = [];
  let off = 0;
  for (const f of frames) {
    const cuts = [0];
    cuts.push(1 + Math.floor(Math.random() * (f.length - 2)));
    if (f.length > 4) cuts.push(1 + Math.floor(Math.random() * (f.length - 2)));
    cuts.push(f.length);
    const uniq = [...new Set(cuts)].sort((a, b) => a - b);
    for (let i = 0; i < uniq.length - 1; i++) {
      pieces.push({ offset: off + uniq[i], data: f.subarray(uniq[i], uniq[i + 1]) });
    }
    off += f.length;
  }
  for (let i = pieces.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
  }

  const inFlight = [];
  const byRevision = new Map();
  const checkSnapshot = async () => {
    const delay = Math.floor(Math.random() * 20);
    const [prog, msgs] = await Promise.all([
      wb.getProgress(sid, { delayMs: delay }),
      wb.getMessages(sid, 0, 'v1', { delayMs: delay, includeFields: false })
    ]);
    // 两个并发查询的 revision 必须一致（同时拍快照）
    assert.equal(prog.revision, msgs.revision);
    // 消息总长度不得超过水位；全部连续时 consumed == watermark
    let consumed = 0;
    for (const m of msgs.messages) {
      assert.equal(m.start, consumed, '消息边界必须连续');
      consumed = m.end;
    }
    assert.ok(consumed <= prog.directions[0].watermark);
    // 同 revision 结果幂等
    const key = prog.revision;
    const sig = JSON.stringify({ wm: prog.directions[0].watermark, total: msgs.total });
    if (byRevision.has(key)) assert.equal(byRevision.get(key), sig);
    else byRevision.set(key, sig);
  };

  for (let i = 0; i < pieces.length; i++) {
    wb.importFragments(sid, { fragments: [pieces[i]] });
    if (i % 2 === 0) inFlight.push(checkSnapshot());
  }
  // 再插入整体重传（重复）与额外查询
  inFlight.push(checkSnapshot());
  wb.importFragments(sid, { fragments: [{ offset: 0, data: Buffer.concat(frames) }] });
  for (let i = 0; i < 6; i++) inFlight.push(checkSnapshot());

  await Promise.all(inFlight);

  const finalMsgs = await wb.getMessages(sid, 0, 'v1');
  assert.equal(finalMsgs.total, 12);
  assert.deepEqual(finalMsgs.messages.map((m) => m.seq), frames.map((_, i) => i + 1));
  const prog = await wb.getProgress(sid);
  assert.equal(prog.directions[0].watermark, off);
  assert.deepEqual(prog.directions[0].gaps, []);
});
