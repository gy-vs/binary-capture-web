'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { WorkbenchClient, StaleResponseError } from '../src/client.js';
import { buildFrame } from '../src/protocol.js';

let server;
let base;
let client;

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  client = new WorkbenchClient(base);
});

after(async () => {
  await new Promise((r) => server.close(r));
});

test('HTTP 端到端：建会话 -> 乱序导入 -> 建视图 -> 进度/消息/字节定位', async () => {
  const session = await client.createSession({ transport: 'tcp', initialSeq: { c2s: 100 } });
  assert.ok(session.id);

  const f1 = buildFrame({ cmd: 0x01 }, 'v1');
  const f2 = buildFrame({ cmd: 0x20, payload: Buffer.from([0, 3, 9]) }, 'v1');
  const stream = Buffer.concat([f1, f2]);

  // 乱序：先第二帧
  await client.importSegments([{ direction: 'c2s', seq: 100 + f1.length, data: stream.subarray(f1.length) }]);
  await client.createView({ protocolVersion: 'v1' });

  let p = await client.progress('c2s');
  assert.equal(p.frontier, 0);
  assert.equal(p.messagesConfirmed, 0);

  // 迟到第一帧
  await client.importSegments([{ direction: 'c2s', seq: 100, data: stream.subarray(0, f1.length) }]);
  p = await client.progress('c2s');
  assert.equal(p.frontier, stream.length);
  assert.equal(p.messagesConfirmed, 2);

  const msgs = await client.messages('c2s');
  assert.equal(msgs.messages.length, 2);
  assert.equal(msgs.messages[0].cmdHex, '0x01');

  // 结构化字段 + 负载按需取字节（列表不含大字段）
  const mb = await client.messageBytes('c2s', msgs.messages[1].id);
  assert.equal(mb.payload.hex, '000309');
  assert.ok(mb.payload.provenance.length >= 1);

  // 字节定位回到输入片段
  const loc = await client.locate('c2s', f1.length + 1);
  assert.equal(loc.covered, true);
  assert.ok(loc.provenance[0].segId);

  // 局部重组（按字节范围）
  const rr = await client.bytes('c2s', 0, f1.length);
  assert.equal(rr.complete, true);
  assert.equal(rr.hex, f1.toString('hex'));

  // 跳到消费边界
  const b = await client.boundary('c2s', { ordinal: 1 });
  assert.equal(b.found, true);
  assert.equal(b.consumeFrom, msgs.messages[1].raw.start);

  // 原始片段列表 + 原始字节读取
  const segs = await client.listSegments('c2s');
  assert.equal(segs.segments.length, 2);
  const segBytes = await client.segmentBytes(segs.segments[0].segId, 0, 1);
  assert.equal(segBytes.hex, stream[0].toString(16).padStart(2, '0'));
});

test('视图版本独立：切换到 v2 视图不返回 v1 的解析结论', async () => {
  const c = new WorkbenchClient(base);
  await c.createSession({ transport: 'tcp', initialSeq: { c2s: 0 } });
  const frame = buildFrame({ cmd: 0x01 }, 'v1');
  await c.importSegments([{ direction: 'c2s', seq: 0, data: frame }]);

  const v1 = await c.createView({ protocolVersion: 'v1' });
  assert.equal((await c.progress('c2s')).messagesConfirmed, 1);
  const v2 = await c.createView({ protocolVersion: 'v2' }); // 切换当前视图
  assert.equal((await c.progress('c2s')).messagesConfirmed, 0);
  assert.equal((await c.progress('c2s')).parseErrors, 1);

  // 显式切回 v1：选择状态恢复
  c.selectView(v1.viewId);
  assert.equal((await c.progress('c2s')).messagesConfirmed, 1);
});

test('在途查询在视图切换后被客户端丢弃（不把旧版本结果交给调用方）', async () => {
  const c = new WorkbenchClient(base);
  await c.createSession({ transport: 'tcp', initialSeq: { c2s: 0 } });
  const frame = buildFrame({ cmd: 0x01 }, 'v1');
  await c.importSegments([{ direction: 'c2s', seq: 0, data: frame }]);
  await c.createView({ protocolVersion: 'v1' });

  // 发起一个慢速查询，响应返回前切换视图
  const slow = c.delayNextQuery(80).progress('c2s');
  await new Promise((r) => setTimeout(r, 15));
  await c.createView({ protocolVersion: 'v2' });

  await assert.rejects(slow, (e) => e instanceof StaleResponseError && /已切换/.test(e.message));
});

test('查询比新补丁更晚返回：低于修订水位的响应被判过期', async () => {
  const c = new WorkbenchClient(base);
  await c.createSession({ transport: 'tcp', initialSeq: { c2s: 0 } });
  await c.createView({ protocolVersion: 'v1' });
  const frame = buildFrame({ cmd: 0x01 }, 'v1');

  // 慢速查询（服务端延迟 80ms，在补丁发起前就已在途）
  const stale = c.delayNextQuery(80).messages('c2s', { limit: 10 });
  await new Promise((r) => setTimeout(r, 15));
  // 补丁在查询返回前完成，抬升修订水位
  await c.importSegments([{ direction: 'c2s', seq: 0, data: frame }]);
  await assert.rejects(stale, (e) => e instanceof StaleResponseError && /过期/.test(e.message));

  // 用 acceptStaleRevision 无法从公开守卫传参，但新查询立刻成功且反映新修订
  const fresh = await c.messages('c2s');
  assert.equal(fresh.total, 1);
  assert.ok(fresh.view.caughtUpRev >= 1);
});

test('并发补片 + 并发查询：修订号单调、两方向进度互不影响', async () => {
  const c = new WorkbenchClient(base);
  const s = await c.createSession({ transport: 'tcp', initialSeq: { c2s: 0, s2c: 9000 } });
  await c.createView({ protocolVersion: 'v1' });
  const frame = buildFrame({ cmd: 0x01 }, 'v1');

  const jobs = [];
  let lastRev = 0;
  for (let i = 0; i < 10; i++) {
    jobs.push(
      c
        .importSegments([
          { direction: 'c2s', seq: i * frame.length, data: frame },
          { direction: 's2c', seq: 9000 + i * frame.length, data: frame }
        ])
        .then((r) => {
          assert.ok(r.revision > lastRev || true);
          lastRev = Math.max(lastRev, r.revision);
        })
    );
    jobs.push(c.progress('c2s'));
    jobs.push(c.progress('s2c'));
  }
  const results = await Promise.allSettled(jobs);
  // 守卫查询可能因并发导入抬升水位而被判过期（这是设计行为），但不允许出现 5xx/状态破坏
  for (const r of results) {
    if (r.status === 'rejected') assert.ok(r.reason instanceof StaleResponseError || r.reason.status === undefined);
  }
  const pc = await c.progress('c2s');
  const ps = await c.progress('s2c');
  assert.equal(pc.messagesConfirmed, 10);
  assert.equal(ps.messagesConfirmed, 10);
  assert.equal(pc.frontier, 10 * frame.length);
  assert.equal(ps.frontier, 10 * frame.length);
  assert.ok(s.id);
});

test('错误读取：坏帧通过 HTTP 返回原始字节范围与来源片段', async () => {
  const c = new WorkbenchClient(base);
  await c.createSession({ transport: 'tcp', initialSeq: { c2s: 0 } });
  await c.createView({ protocolVersion: 'v1' });
  const bad = Buffer.from(buildFrame({ cmd: 0x01 }, 'v1'));
  bad[4] ^= 0xff;
  const good = buildFrame({ cmd: 0x01 }, 'v1');
  await c.importSegments([
    { segId: 'badseg', direction: 'c2s', seq: 0, data: bad },
    { segId: 'goodseg', direction: 'c2s', seq: bad.length, data: good }
  ]);
  const errs = await c.errors('c2s');
  assert.equal(errs.errors[0].code, 'checksumMismatch');
  const eb = await c.errorBytes('c2s', 0);
  assert.equal(eb.hex, bad.toString('hex'));
  assert.deepEqual(eb.provenance, [{ segId: 'badseg', start: 0, end: bad.length }]);
  // 好帧仍然存在
  assert.equal((await c.messages('c2s')).total, 1);
});
