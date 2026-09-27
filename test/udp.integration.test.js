'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workbench } from '../src/index.js';
import { buildFrame, corruptFrame } from '../src/protocol.js';

test('UDP 一个数据报包含多条消息时逐条确认，数据报之间不跨帧', async () => {
  const wb = new Workbench();
  const s = wb.createSession({ transport: 'udp' });
  const v = wb.createView(s.id, {});
  const vid = v.viewId;

  const f1 = buildFrame({ cmd: 0x01 }, 'v1');
  const f2 = buildFrame({ cmd: 0x20, payload: Buffer.from([0, 1, 2]) }, 'v1');
  // 数据报 0：两个完整消息 + 2 字节尾巴（不属于任何帧 -> orphanData，不跨数据报）
  const tail = Buffer.from([0x33, 0x44]);
  // 数据报 1：一个完整消息
  const dg0 = Buffer.concat([f1, f2, tail]);
  const dg1 = f1;

  await wb.importSegments(s.id, [
    { direction: 'c2s', index: 0, data: dg0 },
    { direction: 'c2s', index: 1, data: dg1 }
  ]);

  const p = wb.progress(vid, 'c2s');
  assert.equal(p.datagrams, 2);
  assert.equal(p.messagesConfirmed, 3);
  // 每个数据报的尾巴各产生一个 orphan
  assert.equal(p.parseErrors, 1);

  const msgs = wb.messages(vid, 'c2s', {}).messages;
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs.map((m) => m.datagramIndex), [0, 0, 1]);
  assert.equal(msgs[0].id, 'c2s#0:0');
  // 第二个数据报的偏移从 0 重新开始（不承接 dg0）
  assert.deepEqual(msgs[2].raw, { start: 0, end: f1.length });

  const errs = wb.errors(vid, 'c2s', {}).errors;
  assert.equal(errs[0].code, 'orphanData');
  assert.deepEqual(errs[0].raw, { start: f1.length + f2.length, end: dg0.length });
  assert.equal(errs[0].datagramIndex, 0);
});

test('UDP 缺失数据报在进度中可见，迟到补入后该数据报独立解析', async () => {
  const wb = new Workbench();
  const s = wb.createSession({ transport: 'udp' });
  const v = wb.createView(s.id, {});
  const vid = v.viewId;
  const f = buildFrame({ cmd: 0x01 }, 'v1');

  await wb.importSegments(s.id, [{ direction: 's2c', index: 2, data: f }]);
  let p = wb.progress(vid, 's2c');
  assert.deepEqual(p.missingDatagrams, [0, 1]);
  assert.equal(p.messagesConfirmed, 1);

  await wb.importSegments(s.id, [
    { direction: 's2c', index: 0, data: f },
    { direction: 's2c', index: 1, data: f }
  ]);
  p = wb.progress(vid, 's2c');
  assert.deepEqual(p.missingDatagrams, []);
  assert.equal(p.datagrams, 3);
  assert.equal(p.messagesConfirmed, 3);

  // 数据报内字节定位
  const loc = wb.locateDatagram(vid, 's2c', 2, 0);
  assert.equal(loc.covered, true);
  assert.equal(loc.byteHex, 'a5');
  // 数据报重组
  const rr = wb.reassembleDatagram(vid, 's2c', 1, 0, f.length);
  assert.equal(rr.complete, true);
  assert.equal(rr.hex, f.toString('hex'));
});

test('UDP 重复数据报幂等；冲突数据报按 first/last 视图策略分别处理', async () => {
  const wb = new Workbench();
  const s = wb.createSession({ transport: 'udp' });
  const vFirst = wb.createView(s.id, { overlapPolicy: 'first' });
  const vLast = wb.createView(s.id, { overlapPolicy: 'last' });

  const good = buildFrame({ cmd: 0x01 }, 'v1');
  const bad = (() => {
    const b = Buffer.from(good);
    b[b.length - 1] ^= 0xff;
    return b;
  })();

  await wb.importSegments(s.id, [{ segId: 'dg0', direction: 'c2s', index: 0, data: good }]);
  // 完全重复（同一 segId 重发）
  const r = await wb.importSegments(s.id, [{ segId: 'dg0', direction: 'c2s', index: 0, data: good }]);
  assert.equal(r.accepted[0].duplicate, true);
  // 不同 segId 但内容一致的同序号数据报：视图层同样识别为 duplicate，不产生新解析
  await wb.importSegments(s.id, [{ segId: 'dg0-copy', direction: 'c2s', index: 0, data: good }]);
  assert.equal(wb.progress(vFirst.viewId, 'c2s').messagesConfirmed, 1);
  assert.equal(wb.progress(vFirst.viewId, 'c2s').datagrams, 1);

  // 冲突数据报
  await wb.importSegments(s.id, [{ direction: 'c2s', index: 1, data: bad }]);
  // first 视图：不替换（但坏数据报本身解析为 1 错误 0 消息，记录冲突）
  assert.equal(wb.progress(vFirst.viewId, 'c2s').parseErrors, 1);
  // last 视图：同样是坏数据报 -> 也是 1 错误（本例两视图对坏包结论一致）
  assert.equal(wb.progress(vLast.viewId, 'c2s').parseErrors, 1);

  // 再用 last 策略验证“好包被冲突坏包替换”的差异
  const wb2 = new Workbench();
  const s2 = wb2.createSession({ transport: 'udp' });
  const f = wb2.createView(s2.id, { overlapPolicy: 'first' });
  const l = wb2.createView(s2.id, { overlapPolicy: 'last' });
  await wb2.importSegments(s2.id, [{ direction: 'c2s', index: 0, data: good }]);
  await wb2.importSegments(s2.id, [{ direction: 'c2s', index: 0, data: bad }]);
  assert.equal(wb2.progress(f.viewId, 'c2s').messagesConfirmed, 1, 'first 保留好包');
  assert.equal(wb2.progress(l.viewId, 'c2s').messagesConfirmed, 0, 'last 被坏包替换');
  assert.equal(wb2.progress(l.viewId, 'c2s').parseErrors, 1);
});

test('UDP 坏帧不吞同数据报后续消息，错误字节可单独读取并溯源', async () => {
  const wb = new Workbench();
  const s = wb.createSession({ transport: 'udp' });
  const v = wb.createView(s.id, {});
  const vid = v.viewId;

  const bad = corruptFrame(buildFrame({ cmd: 0x01 }, 'v1'), 4, 0x77);
  const good = buildFrame({ cmd: 0x01 }, 'v1');
  await wb.importSegments(s.id, [
    { segId: 'dg', direction: 'c2s', index: 0, data: Buffer.concat([bad, good]) }
  ]);
  assert.equal(wb.messages(vid, 'c2s', {}).total, 1);
  const errs = wb.errors(vid, 'c2s', {});
  assert.equal(errs.errors[0].code, 'checksumMismatch');
  const eb = wb.errorBytes(vid, 'c2s', 0, { datagramIndex: 0 });
  assert.equal(eb.hex, bad.toString('hex'));
  assert.deepEqual(eb.provenance, [{ segId: 'dg', start: 0, end: bad.length }]);
});
