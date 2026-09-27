'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workbench } from '../src/index.js';
import { buildFrame, corruptFrame } from '../src/protocol.js';

function setup({ transport = 'tcp', initialSeq = { c2s: 1000 }, viewOptions = [{}] } = {}) {
  const wb = new Workbench();
  const session = wb.createSession({ transport, initialSeq });
  const views = viewOptions.map((o) => wb.createView(session.id, o));
  return { wb, sessionId: session.id, views };
}

test('TCP 乱序补片：先到后段产生缺口，迟到前段只局部续算，消息最终按序确认', async () => {
  const { wb, sessionId, views } = setup();
  const vid = views[0].viewId;

  const f1 = buildFrame({ cmd: 0x01 }, 'v1');
  const f2 = buildFrame({ cmd: 0x20, payload: Buffer.from([0, 7, 2]) }, 'v1');
  const f3 = buildFrame({ cmd: 0x10, payload: Buffer.from([0, 0, 0, 99, 0xaa]) }, 'v1');
  const stream = Buffer.concat([f1, f2, f3]);

  const cut1 = f1.length;
  const cut2 = cut1 + f2.length;
  const seg = (seq, a, b) => ({ direction: 'c2s', seq: 1000 + seq, data: stream.subarray(a, b) });

  // 1) 只给第二帧
  await wb.importSegments(sessionId, [seg(cut1, cut1, cut2)]);
  let p = wb.progress(vid, 'c2s');
  assert.equal(p.frontier, 0, '没有连续前缀，frontier 仍为 0');
  assert.equal(p.gaps.length, 1);
  assert.equal(p.messagesConfirmed, 0);

  // 2) 给第三帧，仍然缺第一帧
  await wb.importSegments(sessionId, [seg(cut2, cut2, stream.length)]);
  p = wb.progress(vid, 'c2s');
  assert.equal(p.frontier, 0);

  // 3) 迟到的第一帧补入 -> 全部连通，局部续算确认 3 帧
  await wb.importSegments(sessionId, [seg(0, 0, cut1)]);
  p = wb.progress(vid, 'c2s');
  assert.equal(p.frontier, stream.length);
  assert.equal(p.gaps.length, 0);
  assert.equal(p.messagesConfirmed, 3);
  assert.equal(p.parseErrors, 0);

  const msgs = wb.messages(vid, 'c2s', {}).messages;
  assert.deepEqual(msgs.map((m) => m.cmdHex), ['0x01', '0x20', '0x10']);
  assert.deepEqual(msgs.map((m) => m.raw.start), [0, cut1, cut2]);
});

test('重复片段（完全重传与部分重叠）不改变已确认消息，重复导入幂等', async () => {
  const { wb, sessionId, views } = setup();
  const vid = views[0].viewId;
  const f1 = buildFrame({ cmd: 0x01 }, 'v1');
  const f2 = buildFrame({ cmd: 0x01 }, 'v1');
  const stream = Buffer.concat([f1, f2]);

  const first = await wb.importSegments(sessionId, [
    { direction: 'c2s', seq: 1000, data: stream }
  ]);
  assert.equal(first.revision, 1);

  // 同一 segId 重发
  const segId = first.accepted[0].segId;
  const retry = await wb.importSegments(sessionId, [
    { segId, direction: 'c2s', seq: 1000, data: stream }
  ]);
  assert.equal(retry.revision, 1, '幂等重发不产生新修订');
  assert.equal(retry.accepted[0].duplicate, true);

  // 无 segId 的同字节重叠覆盖
  const overlap = await wb.importSegments(sessionId, [
    { direction: 'c2s', seq: 1001, data: stream.subarray(1, f1.length + 2) }
  ]);
  const p = wb.progress(vid, 'c2s');
  assert.equal(p.messagesConfirmed, 2);
  assert.equal(p.frontier, stream.length);
});

test('跨边界帧：一个片段包含多条消息，边界逐条确认', async () => {
  const { wb, sessionId, views } = setup();
  const vid = views[0].viewId;
  const frames = [0x01, 0x20, 0x10].map((cmd, i) =>
    buildFrame({ cmd, payload: cmd === 0x10 ? Buffer.from([0, 0, 0, i, 0]) : cmd === 0x20 ? Buffer.from([0, i, 1]) : Buffer.alloc(0) }, 'v1')
  );
  const blob = Buffer.concat(frames);
  await wb.importSegments(sessionId, [{ direction: 's2c', seq: 5000, data: blob }]);

  // 初始 seq 只给了 c2s，s2c 第一片段自建立基准
  const msgs = wb.messages(vid, 's2c', {}).messages;
  assert.equal(msgs.length, 3);
  // 跳到第二个消费边界
  const b = wb.boundary(vid, 's2c', { ordinal: 1 });
  assert.equal(b.found, true);
  assert.equal(b.consumeFrom, msgs[1].raw.start);
  assert.equal(b.consumeAfter, msgs[1].raw.end);
  // 按原始偏移定位
  const b2 = wb.boundary(vid, 's2c', { atOffset: msgs[2].raw.start + 1 });
  assert.equal(b2.message.id, msgs[2].id);
});

test('坏帧不吞后续：错误带原始范围且能读出坏帧字节并回溯片段', async () => {
  const { wb, sessionId, views } = setup();
  const vid = views[0].viewId;
  const bad = corruptFrame(buildFrame({ cmd: 0x01 }, 'v1'), 2, 0xff);
  const good = buildFrame({ cmd: 0x20, payload: Buffer.from([0, 9, 3]) }, 'v1');
  const stream = Buffer.concat([bad, good]);
  await wb.importSegments(sessionId, [
    { segId: 'cap-1', direction: 'c2s', seq: 1000, data: stream.subarray(0, bad.length) },
    { segId: 'cap-2', direction: 'c2s', seq: 1000 + bad.length, data: stream.subarray(bad.length) }
  ]);

  const errs = wb.errors(vid, 'c2s', {});
  assert.equal(errs.total, 1);
  assert.equal(errs.errors[0].code, 'checksumMismatch');
  assert.deepEqual(errs.errors[0].raw, { start: 0, end: bad.length });

  const msgs = wb.messages(vid, 'c2s', {}).messages;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].cmd, 0x20);

  // 错误位置的原始字节
  const eb = wb.errorBytes(vid, 'c2s', 0);
  assert.equal(eb.hex, bad.toString('hex'));
  assert.deepEqual(eb.provenance, [{ segId: 'cap-1', start: 0, end: bad.length }]);

  // 任意字节可定位到来源片段
  const loc = wb.locate(vid, 'c2s', bad.length + 1);
  assert.equal(loc.covered, true);
  assert.equal(loc.provenance[0].segId, 'cap-2');
});

test('字节范围查询不复制全部数据：缺口区间返回分段 hex + provenance', async () => {
  const { wb, sessionId, views } = setup();
  const vid = views[0].viewId;
  const f = buildFrame({ cmd: 0x10, payload: Buffer.from([0, 0, 0, 5, 1, 2, 3, 4]) }, 'v1');
  await wb.importSegments(sessionId, [
    { direction: 'c2s', seq: 1000, data: f.subarray(0, 4) },
    { direction: 'c2s', seq: 1010, data: f.subarray(10) }
  ]);
  const r = wb.reassemble(vid, 'c2s', 0, f.length);
  assert.equal(r.complete, false);
  assert.ok(r.gaps.length >= 1);
  assert.equal(r.hex, f.subarray(0, 4).toString('hex') + f.subarray(10).toString('hex'));
  assert.equal(r.assembledRanges.length, 2);
});

test('协议版本隔离：v1/v2 两个视图对同一字节流给出各自独立结论', async () => {
  const { wb, sessionId, views } = setup({
    viewOptions: [{ protocolVersion: 'v1' }, { protocolVersion: 'v2' }]
  });
  const v1 = views[0].viewId;
  const v2 = views[1].viewId;
  // v1 合法帧 -> v2 校验必然不同
  const frame = buildFrame({ cmd: 0x01 }, 'v1');
  await wb.importSegments(sessionId, [{ direction: 'c2s', seq: 1000, data: frame }]);

  assert.equal(wb.progress(v1, 'c2s').messagesConfirmed, 1);
  assert.equal(wb.progress(v1, 'c2s').parseErrors, 0);
  assert.equal(wb.progress(v2, 'c2s').messagesConfirmed, 0);
  assert.equal(wb.progress(v2, 'c2s').parseErrors, 1);
  assert.equal(wb.errors(v2, 'c2s', {}).errors[0].detail.version, 'v2');

  // 在 v2 视图下补一个 v2 合法帧（紧邻第一帧），不影响 v1 视图
  const frame2v2 = buildFrame({ cmd: 0x01 }, 'v2');
  await wb.importSegments(sessionId, [
    { direction: 'c2s', seq: 1000 + frame.length, data: frame2v2 }
  ]);
  const e1 = wb.errors(v1, 'c2s', {});
  assert.equal(e1.errors.length, 1, 'v1 视图把 v2 帧判坏，且不混入 v2 的成功结果');
  assert.equal(wb.messages(v1, 'c2s', {}).total, 1);
  // v2 视图：第一帧坏 + 第二帧好
  assert.equal(wb.messages(v2, 'c2s', {}).total, 1);
  assert.equal(wb.errors(v2, 'c2s', {}).total, 1);
});

test('重叠假设比较：first 与 last 视图结果独立，last 视图在覆盖后从受影响边界局部重算', async () => {
  const { wb, sessionId, views } = setup({
    viewOptions: [
      { protocolVersion: 'v1', overlapPolicy: 'first' },
      { protocolVersion: 'v1', overlapPolicy: 'last' }
    ]
  });
  const first = views[0].viewId;
  const last = views[1].viewId;

  const good = buildFrame({ cmd: 0x01 }, 'v1');
  await wb.importSegments(sessionId, [{ segId: 'orig', direction: 'c2s', seq: 1000, data: good }]);
  // 用内容冲突的“重传”覆盖中间字节（偏移 2）
  const modified = Buffer.from(good);
  modified[2] ^= 0xff;
  await wb.importSegments(sessionId, [{ segId: 'overlap', direction: 'c2s', seq: 1002, data: modified.subarray(2, 4) }]);

  // first：旧字节为准 -> 帧仍有效
  assert.equal(wb.progress(first, 'c2s').messagesConfirmed, 1);
  assert.equal(wb.progress(first, 'c2s').parseErrors, 0);
  // last：新字节为准 -> 校验失败，且之前确认的帧被作废重算
  assert.equal(wb.progress(last, 'c2s').messagesConfirmed, 0);
  assert.equal(wb.progress(last, 'c2s').parseErrors, 1);
});

test('并发查询与补片交错不会破坏状态（串行导入 + 只读快照）', async () => {
  const { wb, sessionId, views } = setup();
  const vid = views[0].viewId;

  const frame = buildFrame({ cmd: 0x01 }, 'v1'); // PING 长度固定 5
  const N = 20;
  const offsets = [...Array(N).keys()];
  // 打乱写入顺序：20 个帧区间乱序补入，同时穿插查询
  for (let i = offsets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [offsets[i], offsets[j]] = [offsets[j], offsets[i]];
  }
  const jobs = [];
  for (const i of offsets) {
    jobs.push(
      wb.importSegments(sessionId, [
        { segId: `f-${i}`, direction: 'c2s', seq: 1000 + i * frame.length, data: frame }
      ])
    );
    if (i % 3 === 0) {
      jobs.push(
        Promise.resolve().then(() => {
          const p = wb.progress(vid, 'c2s');
          const m = wb.messages(vid, 'c2s', { limit: 1000 });
          // 不变式：报告的消息数与列表一致，且已确认字节不超过连续前缀
          assert.equal(p.messagesConfirmed, m.messages.length);
          assert.ok(m.messages.every((x) => x.raw.end <= p.frontier));
        })
      );
    }
  }
  await Promise.all(jobs);
  const p = wb.progress(vid, 'c2s');
  assert.equal(p.frontier, N * frame.length);
  assert.equal(p.gaps.length, 0);
  assert.equal(p.messagesConfirmed, N);
  assert.equal(p.parseErrors, 0);
  // ordinal 连续且原始偏移有序
  const msgs = wb.messages(vid, 'c2s', { limit: 1000 }).messages;
  assert.deepEqual(msgs.map((m) => m.ordinal), [...Array(N).keys()]);
  assert.deepEqual(
    msgs.map((m) => m.raw.start),
    [...Array(N).keys()].map((i) => i * frame.length)
  );
});

test('补片响应带修订号，视图之间的追赶结果互不串台', async () => {
  const { wb, sessionId, views } = setup({ viewOptions: [{}, { protocolVersion: 'v2' }] });
  const frame = buildFrame({ cmd: 0x01 }, 'v1');
  const r = await wb.importSegments(sessionId, [{ direction: 'c2s', seq: 1000, data: frame }]);
  assert.equal(r.revision, 1);
  assert.equal(r.views.length, 2);
  const byView = Object.fromEntries(r.views.map((v) => [v.viewId, v]));
  assert.equal(byView[views[0].viewId].after.messages, 1);
  assert.equal(byView[views[1].viewId].after.messages, 0);
});
