import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workbench } from '../src/store.js';
import { buildV1, buildV2 } from '../src/protocol.js';

function hexOf(buf) { return Buffer.from(buf).toString('hex'); }

test('端到端：乱序补片后局部重组结果刷新，revision 单调递增', async () => {
  const wb = new Workbench();
  const sid = wb.createSession({ versions: ['v1'] });
  const f1 = buildV1({ seq: 1, cmd: 0x04 });
  const f2 = buildV1({ seq: 2, cmd: 0x05 });
  const all = Buffer.concat([f1, f2]);
  const mid = f1.length + 3; // 从 f2 帧头中间切开

  wb.importFragments(sid, { fragments: [{ direction: 0, offset: mid, data: all.subarray(mid) }] });
  const p1 = await wb.getProgress(sid);
  assert.equal(p1.revision, 1);
  assert.equal(p1.directions[0].watermark, 0);
  assert.deepEqual(p1.directions[0].gaps, [{ start: 0, end: mid, length: mid }]);

  const r = wb.importFragments(sid, { fragments: [{ direction: 0, offset: 0, data: all.subarray(0, mid) }] });
  assert.equal(r.revision, 2);
  assert.equal(r.affected.bytesChanged[0].watermarkDelta, all.length);

  const msgs = await wb.getMessages(sid, 0, 'v1');
  assert.equal(msgs.total, 2);
  assert.deepEqual(msgs.messages.map((m) => m.seq), [1, 2]);
});

test('并发查询不破坏状态：延迟查询返回旧快照，补丁后的状态不受其影响', async () => {
  const wb = new Workbench();
  const sid = wb.createSession({ versions: ['v1'] });
  const f1 = buildV1({ seq: 1, cmd: 0x01 });
  wb.importFragments(sid, { fragments: [{ direction: 0, offset: 0, data: f1 }] });

  // 发起一个 40ms 的慢查询（revision=1，1 条消息）
  const slow = wb.getMessages(sid, 0, 'v1', { delayMs: 40 });
  // 在它返回前补入新片段（revision=2，2 条消息）
  const f2 = buildV1({ seq: 2, cmd: 0x02 });
  wb.importFragments(sid, { fragments: [{ direction: 0, offset: f1.length, data: f2 }] });
  const fresh = await wb.getMessages(sid, 0, 'v1');
  const late = await slow;

  assert.equal(fresh.revision, 2);
  assert.equal(fresh.total, 2);
  assert.equal(late.revision, 1);          // 慢查询固定在它拍快照时的修订
  assert.equal(late.total, 1);             // 不被新补丁污染
  // 慢查询返回不改变当前状态
  const after = await wb.getProgress(sid);
  assert.equal(after.revision, 2);
  assert.equal(after.directions[0].watermark, f1.length + f2.length);
});

test('查询乱序返回：先发起后返回的旧响应不能覆盖新响应（快照内容不可变）', async () => {
  const wb = new Workbench();
  const sid = wb.createSession({ versions: ['v1'] });
  const f = buildV1({ seq: 1, cmd: 0x01 });
  wb.importFragments(sid, { fragments: [{ direction: 0, offset: 0, data: f }] });

  const q1 = wb.getProgress(sid, { delayMs: 50 });
  const f2 = buildV1({ seq: 2, cmd: 0x02 });
  wb.importFragments(sid, { fragments: [{ direction: 0, offset: f.length, data: f2 }] });
  const q2 = wb.getProgress(sid, { delayMs: 10 });

  const r2 = await q2;
  const r1 = await q1; // 后返回
  assert.equal(r2.revision, 2);
  assert.equal(r1.revision, 1);
  assert.ok(r1.directions[0].watermark < r2.directions[0].watermark);
});

test('重复片段经公开接口导入：去重统计、状态不变', async () => {
  const wb = new Workbench();
  const sid = wb.createSession({ versions: ['v1'] });
  const f = buildV1({ seq: 1, cmd: 0x01 });
  wb.importFragments(sid, { fragments: [{ direction: 0, offset: 0, data: f, id: 'cap1' }] });
  const again = wb.importFragments(sid, {
    fragments: [{ direction: 0, offset: 0, hex: hexOf(f) }] // 用 hex 重新导入同字节
  });
  assert.equal(again.duplicates, 1);
  assert.equal(again.accepted, 0);
  assert.equal(again.affected.directions.length, 0);
  assert.equal(again.revision, 1); // 无实质变化，不推进 revision

  const frags = await wb.getFragments(sid, 0);
  assert.ok(frags.fragments.some((x) => x.duplicate));
});

test('坏帧错误可分页读取原始字节，并准确回溯到输入片段', async () => {
  const wb = new Workbench();
  const sid = wb.createSession({ versions: ['v1'] });
  const good = buildV1({ seq: 1, cmd: 0x05 });
  // 垃圾 + 好帧，且垃圾与好帧来自不同片段
  const garbage = Buffer.from([0x01, 0x02, 0x03]);
  wb.importFragments(sid, { fragments: [{ direction: 0, offset: 0, data: garbage, id: 'bad-seg' }] });
  wb.importFragments(sid, { fragments: [{ direction: 0, offset: 3, data: good, id: 'good-seg' }] });

  const errs = await wb.getErrors(sid, 0, 'v1');
  assert.ok(errs.total >= 1);
  const bad = errs.errors.find((e) => e.code === 'BAD_MAGIC');
  assert.deepEqual([bad.start, bad.end], [0, 3]);

  const bytes = await wb.readErrorBytes(sid, 0, 'v1', bad.index, { limit: 64 });
  assert.equal(bytes.segments.length, 1);
  assert.equal(bytes.segments[0].hex, '010203');
  assert.equal(bytes.segments[0].fragmentId, 'bad-seg'); // 错误位置回到输入片段
  assert.equal(bytes.segments[0].fragmentOffset, 0);

  // 后续好帧仍被消费，证明坏帧没有吞掉后续消息
  const msgs = await wb.getMessages(sid, 0, 'v1');
  assert.equal(msgs.total, 1);
  assert.equal(msgs.messages[0].seq, 1);
});

test('错误字节分页：长坏帧按窗口读取，hasMore 与偏移正确', async () => {
  const wb = new Workbench();
  const sid = wb.createSession({ versions: ['v1'] });
  // 长度字段声明巨大 -> BAD_LENGTH，整块无候选魔数的垃圾被记为坏字节
  const garbage = Buffer.alloc(10, 0x11);
  wb.importFragments(sid, { fragments: [{ direction: 0, data: garbage }] });
  const errs = await wb.getErrors(sid, 0, 'v1');
  const idx = errs.errors[0].index;
  const page1 = await wb.readErrorBytes(sid, 0, 'v1', idx, { limit: 4 });
  assert.equal(page1.hasMore, true);
  assert.deepEqual(page1.window, [0, 4]);
  const page2 = await wb.readErrorBytes(sid, 0, 'v1', idx, { offset: 4, limit: 4 });
  assert.deepEqual(page2.window, [4, 8]);
});

test('字节范围查询：分页 + 缺口标记 + 不整体复制', async () => {
  const wb = new Workbench();
  const sid = wb.createSession({ versions: ['v1'] });
  wb.importFragments(sid, { fragments: [{ direction: 0, offset: 0, data: Buffer.alloc(10, 0xab), id: 'a' }] });
  wb.importFragments(sid, { fragments: [{ direction: 0, offset: 20, data: Buffer.alloc(10, 0xcd), id: 'b' }] });

  const r = await wb.readRange(sid, 0, { start: 0, end: 30, limit: 30 });
  assert.equal(r.segments[0].hex, 'ab'.repeat(10));
  assert.equal(r.segments[1].covered, false);
  assert.deepEqual([r.segments[1].start, r.segments[1].end], [10, 20]);
  assert.equal(r.segments[2].hex, 'cd'.repeat(10));

  // format=none 不回传任何字节，只给来源结构
  const meta = await wb.readRange(sid, 0, { start: 0, end: 30, limit: 30, format: 'none' });
  assert.ok(!('hex' in meta.segments[0]));
  assert.equal(meta.segments[0].fragmentId, 'a');
});

test('消费边界跳转与字节定位：locate 正确区分 message/error/gap', async () => {
  const wb = new Workbench();
  const sid = wb.createSession({ versions: ['v1'] });
  const f1 = buildV1({ seq: 1, cmd: 0x04 });
  wb.importFragments(sid, { fragments: [{ direction: 0, offset: 0, data: f1 }] });
  wb.importFragments(sid, { fragments: [{ direction: 0, offset: 100, data: Buffer.from([0xff]) }] });

  const inMsg = await wb.locate(sid, 0, 'v1', 2);
  assert.equal(inMsg.zone, 'message');
  assert.equal(inMsg.messageIndex, 0);
  assert.equal(inMsg.provenance[0].covered, true);

  const gap = await wb.locate(sid, 0, 'v1', 50);
  assert.equal(gap.zone, 'gap');

  const unseen = await wb.locate(sid, 0, 'v1', 200);
  assert.equal(unseen.zone, 'unseen');

  const bounds = await wb.getBoundaries(sid, 0, 'v1');
  assert.equal(bounds.items[0].kind, 'message');
  assert.equal(bounds.items[0].offset, f1.length); // 跳到第一条消息消费之后
});

test('版本对比：同一份原始片段下各版本结果独立且差异可量化', async () => {
  const wb = new Workbench();
  const sid = wb.createSession({ versions: ['v1', 'v2'] });
  const f1 = buildV1({ seq: 1, cmd: 0x04 });
  const f2 = buildV1({ seq: 2, cmd: 0x05 });
  wb.importFragments(sid, { fragments: [{ direction: 0, data: Buffer.concat([f1, f2]) }] });

  const cmp = await wb.compare(sid, 0, ['v1', 'v2']);
  assert.equal(cmp.views.v1.stats.messageCount, 2);
  assert.equal(cmp.views.v2.stats.messageCount, 0);
  assert.ok(cmp.views.v2.stats.errorCount >= 1);
  assert.equal(cmp.differences.boundariesAligned, false);

  // 切换版本视图不串结果：默认版本 v1 的消息接口看不到 v2 的错误
  const v1msgs = await wb.getMessages(sid, 0, 'v1');
  assert.equal(v1msgs.version, 'v1');
  assert.equal(v1msgs.total, 2);
  const v2errs = await wb.getErrors(sid, 0, 'v2');
  assert.equal(v2errs.version, 'v2');
  assert.ok(v2errs.total >= 1);
});

test('一记录多消息 + 两个方向同时独立重组', async () => {
  const wb = new Workbench();
  const sid = wb.createSession({ versions: ['v1'] });
  const d0 = Buffer.concat([buildV1({ seq: 1 }), buildV1({ seq: 2 })]);
  const d1 = buildV2({ seq: 9, cmd: 0x03 }); // 用 v1 视角看方向1：会是坏流
  wb.importFragments(sid, {
    fragments: [
      { direction: 0, data: d0 },
      { direction: 1, data: buildV1({ seq: 10, cmd: 0x03 }) }
    ]
  });
  const m0 = await wb.getMessages(sid, 0, 'v1');
  const m1 = await wb.getMessages(sid, 1, 'v1');
  assert.equal(m0.total, 2);
  assert.equal(m1.total, 1);
  assert.equal(m1.messages[0].seq, 10);
});

test('结构化字段：消息详情含按逻辑绝对偏移的字段表，字段范围可回溯', async () => {
  const wb = new Workbench();
  const sid = wb.createSession({ versions: ['v1'] });
  const f = buildV1({ seq: 5, cmd: 0x02, payload: Buffer.from([0x0a, 0x0b]) });
  wb.importFragments(sid, { fragments: [{ direction: 0, offset: 3, data: f }] }); // 先悬空
  wb.importFragments(sid, { fragments: [{ direction: 0, offset: 0, data: Buffer.alloc(3) }] }); // 填前缀洞
  const detail = await wb.getMessage(sid, 0, 'v1', 0);
  const fields = Object.fromEntries(detail.message.fields.map((x) => [x.name, x]));
  assert.equal(fields.seq.value, 5);
  // 逻辑绝对偏移 = 3 + 帧内偏移
  assert.equal(fields.seq.start, 3 + 4);
  assert.deepEqual(detail.message.payloadRange, [3 + 6, 3 + 8]);
});
