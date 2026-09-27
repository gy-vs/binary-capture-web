'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coverage } from '../src/coverage.js';
import { parseDirection } from '../src/framer.js';
import { buildFrame, corruptFrame, SOF, ESC } from '../src/protocol.js';

function feed(coverage, chunks, version = 'v1') {
  for (const c of chunks) coverage.insert(c.segId, c.data, c.at, 'first');
  return parseDirection(version, coverage, coverage.frontier(), 0, 'c2s');
}

test('字段跨片段边界：长度/命令/校验和落在片段缝隙上仍能成帧', () => {
  const frame = buildFrame({ cmd: 0x10, payload: Buffer.from([0, 0, 0, 42, 9, 9]) }, 'v1');
  // 在每个可能的切点都切一遍
  for (let cut = 1; cut < frame.length - 1; cut++) {
    const cov = new Coverage();
    feed(cov, [
      { segId: 'x', data: frame.subarray(0, cut), at: 0 },
      { segId: 'y', data: frame.subarray(cut), at: cut }
    ]);
    const r = parseDirection('v1', cov, cov.frontier(), 0, 'c2s');
    assert.equal(r.messages.length, 1, `切点 ${cut} 应恰好成一帧`);
    assert.equal(r.errors.length, 0);
    assert.equal(r.messages[0].cmd, 0x10);
    assert.equal(r.messages[0].decoded.fields.seq, 42);
  }
});

test('帧未到齐时停在 SOF（pending），补入迟到字节后从原处继续', () => {
  const frame = buildFrame({ cmd: 0x01 }, 'v1');
  const cov = new Coverage();
  cov.insert('a', frame.subarray(0, 3), 0, 'first');
  let r = parseDirection('v1', cov, cov.frontier(), 0, 'c2s');
  assert.equal(r.messages.length, 0);
  assert.equal(r.cursor, 0);
  assert.equal(r.pending.hasSof, true);

  cov.insert('b', frame.subarray(3), 3, 'first');
  r = parseDirection('v1', cov, cov.frontier(), r.cursor, 'c2s');
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].cmd, 0x01);
});

test('坏校验帧不会吞掉后续仍可识别的消息', () => {
  const f1 = buildFrame({ cmd: 0x01 }, 'v1');
  const bad = corruptFrame(f1, f1.length - 1, (f1[f1.length - 1] ^ 0xff) & 0xff);
  const f2 = buildFrame({ cmd: 0x20, payload: Buffer.from([0x00, 0x05, 0x01]) }, 'v1');
  const stream = Buffer.concat([bad, f2]);
  const cov = new Coverage();
  cov.insert('s', stream, 0, 'first');
  const r = parseDirection('v1', cov, cov.frontier(), 0, 'c2s');
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].cmd, 0x20);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, 'checksumMismatch');
  assert.deepEqual(r.errors[0].raw, { start: 0, end: bad.length });
});

test('非法长度字段（超过协议上限 200）报 badLength，回退狩猎后下一帧仍被确认', async () => {
  const { MAX_PAYLOAD } = await import('../src/protocol.js');
  assert.equal(MAX_PAYLOAD, 200);
  // SOF LEN=250(超限) CMD FLAGS，随后紧跟一个好帧
  const head = Buffer.from([SOF, 250, 0xaa, 0xbb]);
  const good = buildFrame({ cmd: 0x01 }, 'v1');
  const cov = new Coverage();
  cov.insert('s', Buffer.concat([head, good]), 0, 'first');
  const r = parseDirection('v1', cov, cov.frontier(), 0, 'c2s');
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].cmd, 0x01);
  assert.ok(r.errors.some((e) => e.code === 'badLength'));

  // buildFrame 对超上限负载直接拒绝（防御深度）
  assert.throws(() => buildFrame({ cmd: 0x10, payload: Buffer.alloc(MAX_PAYLOAD + 1) }, 'v1'));
});

test('非法转义序列报错，且其后的好帧仍被确认', () => {
  // SOF, LEN=1, CMD, 然后 ESC 0x55（非法目标），再补正常帧
  const head = Buffer.from([SOF, 0x01, 0x30, ESC, 0x55, 0x00]);
  const good = buildFrame({ cmd: 0x01 }, 'v1');
  const stream = Buffer.concat([head, good]);
  const cov = new Coverage();
  cov.insert('s', stream, 0, 'first');
  const r = parseDirection('v1', cov, cov.frontier(), 0, 'c2s');
  assert.equal(r.messages.length, 1);
  assert.ok(r.errors.some((e) => e.code === 'badEscape'));
});

test('帧体内被转义的 SOF 字节被还原成负载内容（不是新帧起始）', () => {
  const payload = Buffer.from([0, 0, 0, 1, SOF, ESC]);
  const frame = buildFrame({ cmd: 0x10, payload }, 'v1');
  const cov = new Coverage();
  cov.insert('s', frame, 0, 'first');
  const r = parseDirection('v1', cov, cov.frontier(), 0, 'c2s');
  assert.equal(r.messages.length, 1);
  assert.deepEqual([...r.messages[0].payload], [...payload]);
  // 逻辑长度 = SOF + 3 头 + 6 负载 + 1 校验；线上长度因为转义更长
  assert.ok(r.messages[0].rawLength > r.messages[0].logicalLength);
});

test('字段范围可回溯到具体输入片段（跨片段字段 provenance）', () => {
  const frame = buildFrame({ cmd: 0x01 }, 'v1');
  const cov = new Coverage();
  cov.insert('a', frame.subarray(0, 2), 0, 'first');
  cov.insert('b', frame.subarray(2), 2, 'first');
  const r = parseDirection('v1', cov, cov.frontier(), 0, 'c2s');
  const m = r.messages[0];
  const segs = new Set(m.segments.map((s) => s.segId));
  assert.deepEqual([...segs].sort(), ['a', 'b']);
  // checksum 字段落在片段 b
  const checkSegs = m.fields.checksum.segments.map((s) => s.segId);
  assert.deepEqual(checkSegs, ['b']);
});

test('孤儿字节（两帧之间的噪声）被标为错误且范围精确', () => {
  const f1 = buildFrame({ cmd: 0x01 }, 'v1');
  const f2 = buildFrame({ cmd: 0x01 }, 'v1');
  const noise = Buffer.from([0x00, 0x11]);
  const stream = Buffer.concat([f1, noise, f2]);
  const cov = new Coverage();
  cov.insert('s', stream, 0, 'first');
  const r = parseDirection('v1', cov, cov.frontier(), 0, 'c2s');
  assert.equal(r.messages.length, 2);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(r.errors[0].raw, { start: f1.length, end: f1.length + 2 });
});
