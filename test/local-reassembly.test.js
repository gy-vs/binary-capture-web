'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workbench } from '../src/index.js';
import { buildFrame } from '../src/protocol.js';

test('单帧中间缺口：首尾先到（pending），中段迟到补齐后成帧且字段跨片段溯源', async () => {
  const wb = new Workbench();
  const s = wb.createSession({ transport: 'tcp', initialSeq: { c2s: 0 } });
  const v = wb.createView(s.id, { protocolVersion: 'v1' });
  const vid = v.viewId;

  // 一帧 DATA: seq=77 + 4 字节数据，帧较长便于制造中间缺口
  const frame = buildFrame({ cmd: 0x10, payload: Buffer.from([0, 0, 0, 77, 0xde, 0xad, 0xbe, 0xef]) }, 'v1');

  // 切成头（含 SOF/LEN/CMD）和尾（含校验和），中间留洞
  const head = frame.subarray(0, 3);
  const tail = frame.subarray(frame.length - 2);
  const midStart = head.length;
  const midEnd = frame.length - 2;

  await wb.importSegments(s.id, [
    { segId: 'head', direction: 'c2s', seq: 0, data: head },
    { segId: 'tail', direction: 'c2s', seq: frame.length - 2, data: tail }
  ]);

  let p = wb.progress(vid, 'c2s');
  assert.equal(p.frontier, head.length, '连续前缀只到头部');
  assert.equal(p.messagesConfirmed, 0);
  assert.ok(p.pending && p.pending.hasSof, '帧停在 SOF 等待中段');
  // span 内已有缺口报告
  assert.ok(p.gaps.some((g) => g.start === head.length));

  // 中段乱序迟到（甚至本身也乱序：先给后半个中段，再给前半个）
  await wb.importSegments(s.id, [
    { segId: 'mid2', direction: 'c2s', seq: midStart + 4, data: frame.subarray(midStart + 4, midEnd) }
  ]);
  p = wb.progress(vid, 'c2s');
  assert.equal(p.messagesConfirmed, 0, '中段仍有洞，不能成帧');
  assert.equal(p.frontier, head.length);

  await wb.importSegments(s.id, [
    { segId: 'mid1', direction: 'c2s', seq: midStart, data: frame.subarray(midStart, midStart + 4) }
  ]);
  p = wb.progress(vid, 'c2s');
  assert.equal(p.frontier, frame.length);
  assert.equal(p.gaps.length, 0);
  assert.equal(p.messagesConfirmed, 1);
  assert.equal(p.parseErrors, 0);

  const msg = wb.messages(vid, 'c2s', {}).messages[0];
  assert.equal(msg.decoded.fields.seq, 77);
  assert.equal(msg.decoded.fields.dataLength, 4);

  // 整帧 provenance 跨越四个输入片段
  const segIds = [...new Set(msg.segments.map((x) => x.segId))].sort();
  assert.deepEqual(segIds, ['head', 'mid1', 'mid2', 'tail']);

  // 长度字段来自 head；校验和字段来自 tail —— 跨片段字段由同一套消费语义解释
  assert.deepEqual(msg.fields.length.segments.map((x) => x.segId), ['head']);
  assert.deepEqual(msg.fields.checksum.segments.map((x) => x.segId), ['tail']);

  // 重组字节与原始帧完全一致
  const rr = wb.reassemble(vid, 'c2s', 0, frame.length);
  assert.equal(rr.complete, true);
  assert.equal(rr.hex, frame.toString('hex'));

  // 错误列表为空
  assert.equal(wb.errors(vid, 'c2s', {}).total, 0);
});

test('迟到片段只影响局部：已有多帧，补片落在后段，前段消息与 ordinal 不变', async () => {
  const wb = new Workbench();
  const s = wb.createSession({ transport: 'tcp', initialSeq: { c2s: 0 } });
  const v = wb.createView(s.id, {});
  const vid = v.viewId;

  const frames = [1, 2, 3, 4].map((i) =>
    buildFrame({ cmd: 0x10, payload: Buffer.from([0, 0, 0, i, 0x60 + i]) }, 'v1')
  );
  const offsets = [];
  let off = 0;
  for (const f of frames) {
    offsets.push(off);
    off += f.length;
  }

  // 先给第 1、2、4 帧（第 3 帧缺失）
  await wb.importSegments(s.id, [
    { segId: 'f1', direction: 'c2s', seq: offsets[0], data: frames[0] },
    { segId: 'f2', direction: 'c2s', seq: offsets[1], data: frames[1] },
    { segId: 'f4', direction: 'c2s', seq: offsets[3], data: frames[3] }
  ]);
  let p = wb.progress(vid, 'c2s');
  assert.equal(p.messagesConfirmed, 2);
  const before = wb.messages(vid, 'c2s', {}).messages;
  assert.deepEqual(before.map((m) => m.id), [`c2s:${offsets[0]}`, `c2s:${offsets[1]}`]);

  // 迟到的第 3 帧
  await wb.importSegments(s.id, [{ segId: 'f3', direction: 'c2s', seq: offsets[2], data: frames[2] }]);
  p = wb.progress(vid, 'c2s');
  assert.equal(p.messagesConfirmed, 4);
  const after = wb.messages(vid, 'c2s', {}).messages;
  // 前两帧身份（id）与顺序稳定，只是追加后两帧 —— 不是整流重算导致的重编号串台
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[1].id, before[1].id);
  assert.deepEqual(after.map((m) => m.ordinal), [0, 1, 2, 3]);
  assert.deepEqual(after.map((m) => m.decoded.fields.seq), [1, 2, 3, 4]);
});

test('last 策略覆盖前段字节：只从受影响帧重算，之后完好的帧重新确认', async () => {
  const wb = new Workbench();
  const s = wb.createSession({ transport: 'tcp', initialSeq: { c2s: 0 } });
  const v = wb.createView(s.id, { overlapPolicy: 'last' });
  const vid = v.viewId;

  const f1 = buildFrame({ cmd: 0x01 }, 'v1');
  const f2 = buildFrame({ cmd: 0x01 }, 'v1');
  const stream = Buffer.concat([f1, f2]);
  await wb.importSegments(s.id, [{ segId: 'all', direction: 'c2s', seq: 0, data: stream }]);
  assert.equal(wb.progress(vid, 'c2s').messagesConfirmed, 2);

  // 只覆盖第一帧的校验字节（偏移 4），第二帧完好
  const bad = Buffer.from([f1[4] ^ 0x55]);
  await wb.importSegments(s.id, [{ segId: 'patch', direction: 'c2s', seq: 4, data: bad }]);
  const p = wb.progress(vid, 'c2s');
  assert.equal(p.messagesConfirmed, 1, '第一帧作废，第二帧重新确认');
  assert.equal(p.parseErrors, 1);
  const msgs = wb.messages(vid, 'c2s', {}).messages;
  assert.deepEqual(msgs[0].raw, { start: f1.length, end: stream.length });
});
