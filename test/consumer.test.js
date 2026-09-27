import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DirectionAssembly } from '../src/assembly.js';
import { StreamConsumer } from '../src/consumer.js';
import { PROTOCOLS, buildV1, buildV2 } from '../src/protocol.js';

function feed(asm, chunks) {
  let off = 0;
  for (const ch of chunks) {
    asm.addFragment({ offset: off, data: Buffer.from(ch) });
    off += ch.length;
  }
}

function pump(asm, version = 'v1') {
  const c = new StreamConsumer(asm, PROTOCOLS[version]);
  c.pump();
  return c;
}

test('v1：跨片段字段（帧头/长度/校验各被切开）到达后仍能成帧', () => {
  const frame = buildV1({ seq: 7, cmd: 0x04, payload: Buffer.from([0xde, 0xad, 0xbe, 0xef]) });
  const asm = new DirectionAssembly(0);
  // 切在魔数中间、长度字段中间、载荷中间、校验字节前
  feed(asm, [frame.subarray(0, 1), frame.subarray(1, 3), frame.subarray(3, 5), frame.subarray(5, 9), frame.subarray(9)]);
  const c = pump(asm, 'v1');
  assert.equal(c.messages.length, 1);
  const m = c.messages[0];
  assert.equal(m.seq, 7);
  assert.equal(m.cmdName, 'PING');
  assert.equal(m.payloadLen, 4);
  assert.deepEqual(m.payloadRange, [6, 10]);
  assert.equal(c.errors.length, 0);
  // 中间过程：第一片段只有一个魔数字节时必须保持 incomplete，不能产生错误
});

test('v1：单条记录包含多个消息，全部识别且边界准确', () => {
  const frames = Buffer.concat([
    buildV1({ seq: 1, cmd: 0x01 }),
    buildV1({ seq: 2, cmd: 0x02, payload: Buffer.from('hi') }),
    buildV1({ seq: 3, cmd: 0x03 })
  ]);
  const asm = new DirectionAssembly(0);
  feed(asm, [frames]);
  const c = pump(asm, 'v1');
  assert.equal(c.messages.length, 3);
  assert.deepEqual(c.messages.map((m) => m.seq), [1, 2, 3]);
  assert.equal(c.messages[2].end, frames.length);
  assert.equal(c.errors.length, 0);
});

test('坏帧不能吞掉后续消息：魔数损坏后从下一帧恢复', () => {
  const f1 = buildV1({ seq: 1, cmd: 0x01 });
  const f2 = buildV1({ seq: 2, cmd: 0x02 });
  const f3 = buildV1({ seq: 3, cmd: 0x03 });
  const stream = Buffer.concat([f1, f2, f3]);
  stream[f1.length] = 0x00; // 破坏 f2 的魔数首字节
  stream[f1.length + 1] = 0x00;
  const asm = new DirectionAssembly(0);
  feed(asm, [stream]);
  const c = pump(asm, 'v1');
  assert.equal(c.messages.length, 2); // f1 和 f3 仍被识别
  assert.deepEqual(c.messages.map((m) => m.seq), [1, 3]);
  assert.ok(c.errors.length >= 1);
  assert.equal(c.errors[0].code, 'BAD_MAGIC');
  // 错误区间精确夹在 f1.end 与 f3.start 之间
  assert.ok(c.errors[0].start >= f1.length && c.errors[0].end <= f1.length + f2.length);
});

test('校验和错误：记录精确坏帧区间，下一条消息继续被消费', () => {
  const f1 = buildV1({ seq: 1, cmd: 0x02, payload: Buffer.from('abc') });
  const f2 = buildV1({ seq: 2, cmd: 0x05 });
  const stream = Buffer.concat([f1, f2]);
  stream[f1.length - 1] ^= 0xff; // 破坏 f1 校验字节
  const asm = new DirectionAssembly(0);
  feed(asm, [stream]);
  const c = pump(asm, 'v1');
  const err = c.errors.find((e) => e.code === 'BAD_CHECKSUM');
  assert.ok(err, '应当报告 BAD_CHECKSUM');
  assert.equal(c.messages.length, 1);
  assert.equal(c.messages[0].seq, 2);
});

test('迟到片段：前半帧悬停为 pending，补齐后局部增量消费完成', () => {
  const f1 = buildV1({ seq: 9, cmd: 0x04 });
  const asm = new DirectionAssembly(0);
  asm.addFragment({ offset: 0, data: f1.subarray(0, 4) }); // 只有魔数+长度
  let c = new StreamConsumer(asm, PROTOCOLS.v1);
  c.pump();
  assert.equal(c.messages.length, 0);
  assert.equal(c.consumed, 0); // 不猜测、不前推

  asm.addFragment({ offset: 4, data: f1.subarray(4) }); // 迟到补片
  c.pump();
  assert.equal(c.messages.length, 1);
  assert.equal(c.messages[0].seq, 9);
  assert.equal(c.consumed, f1.length);
});

test('v2：SLIP 转义（载荷含 7E/7D）跨片段时字段偏移仍准确', () => {
  // 载荷里放入 0x7e / 0x7d，强制走转义
  const frame = buildV2({ seq: 0x10, payload: Buffer.from([0x7e, 0x7d, 0x01, 0x02]) });
  assert.ok(frame.includes(0x7d)); // 线上确实发生转义
  const asm = new DirectionAssembly(0);
  // 从转义序列中间切开
  const cut = frame.indexOf(0x7d) + 1;
  feed(asm, [frame.subarray(0, cut), frame.subarray(cut)]);
  const c = pump(asm, 'v2');
  assert.equal(c.messages.length, 1);
  assert.equal(c.errors.length, 0);
  const m = c.messages[0];
  assert.deepEqual(m.payloadRange[0] < m.payloadRange[1], true);
  // 字段范围都是线上绝对偏移，且落在帧内
  for (const f of m.fields) {
    assert.ok(f.start >= m.start && f.end <= m.end, `字段 ${f.name} 越界`);
  }
});

test('v2：非法转义序列只废掉当前帧，后续帧正常', () => {
  const f1 = buildV2({ seq: 1, cmd: 2 });
  const f2 = buildV2({ seq: 2, cmd: 5 });
  // 在 f1 的起始 flag 后塞入 7D 00（非法转义）
  const corrupted = Buffer.concat([
    f1.subarray(0, 1), Buffer.from([0x7d, 0x00]), f1.subarray(1), f2
  ]);
  const asm = new DirectionAssembly(0);
  feed(asm, [corrupted]);
  const c = pump(asm, 'v2');
  const escErr = c.errors.find((e) => e.code === 'BAD_ESCAPE');
  assert.ok(escErr, '应报告 BAD_ESCAPE');
  assert.ok(c.messages.some((m) => m.seq === 2), '后续帧必须仍被识别');
});

test('v2：相邻标志字节(7E7E)是线路空闲，不计错误', () => {
  const frame = buildV2({ seq: 1, cmd: 4 });
  const stream = Buffer.concat([Buffer.from([0x7e]), frame]);
  const asm = new DirectionAssembly(0);
  feed(asm, [stream]);
  const c = pump(asm, 'v2');
  assert.equal(c.messages.length, 1);
  assert.equal(c.errors.length, 0);
  assert.ok(c.idleBytes >= 1);
});

test('版本隔离：同一片段流在 v1/v2 下结果各自独立、互不串扰', () => {
  const v1frame = buildV1({ seq: 1, cmd: 0x02, payload: Buffer.from('xy') });
  const asm = new DirectionAssembly(0);
  feed(asm, [v1frame]);
  const c1 = pump(asm, 'v1');
  const c2 = pump(asm, 'v2');
  assert.equal(c1.messages.length, 1); // v1 能识别自己的帧
  // v2 没有起始 0x7e：要么报 BAD_FLAG 错误，要么无法识别为消息
  assert.equal(c2.messages.length, 0);
  assert.ok(c2.errors.length >= 1 || c2.consumed === 0);
  // 再驱动一次 v1，结果不被 v2 的推进影响
  c1.pump();
  assert.equal(c1.messages.length, 1);
  assert.equal(c1.consumed, v1frame.length);
});

test('UDP：帧不得跨数据报边界，残余字节按坏帧记录且不影响下一报', () => {
  const asm = new DirectionAssembly(0, { transport: 'udp' });
  const good = buildV1({ seq: 1, cmd: 0x05 });
  // 第一个数据报：一个好帧 + 半帧垃圾；第二个数据报：一个好帧
  const partial = buildV1({ seq: 2, cmd: 0x02 }).subarray(0, 3);
  const dg1 = Buffer.concat([good, partial]);
  const dg2 = buildV1({ seq: 3, cmd: 0x03 });
  feed(asm, [dg1, dg2]);
  const c = new StreamConsumer(asm, PROTOCOLS.v1);
  c.pump();
  assert.ok(c.messages.some((m) => m.seq === 1));
  assert.ok(c.messages.some((m) => m.seq === 3));
  const boundaryErr = c.errors.find((e) => e.code === 'DATAGRAM_BOUNDARY');
  assert.ok(boundaryErr, '半帧应在数据报边界处被截为坏帧');
  assert.deepEqual([boundaryErr.start, boundaryErr.end], [good.length, dg1.length]);
});
