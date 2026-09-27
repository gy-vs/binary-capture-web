import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { Workbench } from '../src/store.js';
import { WorkbenchClient } from '../src/client.js';
import { buildV1, buildV2 } from '../src/protocol.js';

let server;
let base;
let client;

before(async () => {
  const wb = new Workbench();
  server = createServer(wb);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  client = new WorkbenchClient(base);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json(), revision: res.headers.get('x-session-revision') };
}

async function getj(path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}

test('HTTP：健康检查与协议清单', async () => {
  const h = await getj('/health');
  assert.equal(h.body.ok, true);
  const p = await getj('/protocols');
  assert.deepEqual(Object.keys(p.body.protocols).sort(), ['v1', 'v2']);
});

test('HTTP：创建会话、hex 导入片段、消息与结构化字段', async () => {
  const { body: created } = await post('/sessions/create', { versions: ['v1'] });
  const sid = created.sessionId;
  const f1 = buildV1({ seq: 1, cmd: 0x04, payload: Buffer.from('Q') });
  const imp = await post(`/sessions/${sid}/fragments`, {
    fragments: [{ direction: 0, hex: f1.toString('hex') }]
  });
  assert.equal(imp.status, 200);
  assert.equal(imp.body.accepted, 1);
  assert.equal(imp.revision, '1'); // 修订号通过响应头回显

  const msgs = await getj(`/sessions/${sid}/directions/0/messages?fields=true`);
  assert.equal(msgs.body.total, 1);
  assert.equal(msgs.body.messages[0].cmdName, 'PING');
  const fieldNames = msgs.body.messages[0].fields.map((f) => f.name);
  assert.ok(fieldNames.includes('chk') && fieldNames.includes('payload'));
});

test('HTTP：乱序补片 + 重复片段经 REST 接口正确处理', async () => {
  const { body: created } = await post('/sessions/create', { versions: ['v1'] });
  const sid = created.sessionId;
  const all = Buffer.concat([buildV1({ seq: 1 }), buildV1({ seq: 2 })]);
  const cut = all.length - 2;

  let r = await post(`/sessions/${sid}/fragments`, { fragments: [{ direction: 0, offset: cut, hex: all.subarray(cut).toString('hex') }] });
  assert.equal(r.body.affected.bytesChanged[0].watermarkDelta, 0);
  let prog = await getj(`/sessions/${sid}`);
  assert.equal(prog.body.directions[0].watermark, 0);

  r = await post(`/sessions/${sid}/fragments`, { fragments: [{ direction: 0, offset: 0, hex: all.subarray(0, cut).toString('hex') }] });
  assert.equal(r.body.accepted, 1);
  prog = await getj(`/sessions/${sid}`);
  assert.equal(prog.body.directions[0].watermark, all.length);

  // 整体重传：重复
  r = await post(`/sessions/${sid}/fragments`, { fragments: [{ direction: 0, offset: 0, hex: all.toString('hex') }] });
  assert.equal(r.body.duplicates, 1);
  assert.equal(r.body.conflicts, 0);

  const msgs = await getj(`/sessions/${sid}/directions/0/messages`);
  assert.equal(msgs.body.total, 2);
});

test('HTTP：错误字节、范围分页、边界、定位接口联调', async () => {
  const { body: created } = await post('/sessions/create', { versions: ['v1'] });
  const sid = created.sessionId;
  await post(`/sessions/${sid}/fragments`, { fragments: [{ direction: 0, offset: 0, hex: '010203', id: 'g' }] });
  const good = buildV1({ seq: 8, cmd: 0x05 });
  await post(`/sessions/${sid}/fragments`, { fragments: [{ direction: 0, offset: 3, hex: good.toString('hex'), id: 'ok' }] });

  const errs = await getj(`/sessions/${sid}/directions/0/errors`);
  assert.ok(errs.body.total >= 1);
  const idx = errs.body.errors[0].index;
  const bytes = await getj(`/sessions/${sid}/directions/0/errors/${idx}/bytes`);
  assert.equal(bytes.body.segments[0].fragmentId, 'g');
  assert.equal(bytes.body.segments[0].hex, '010203');

  const range = await getj(`/sessions/${sid}/directions/0/range?start=0&limit=5&format=utf8`);
  assert.ok(range.body.segments[0].end <= 5);

  const loc = await getj(`/sessions/${sid}/directions/0/locate/4`);
  assert.equal(loc.body.zone, 'message');
  assert.equal(loc.body.messageIndex, 0);

  const bounds = await getj(`/sessions/${sid}/directions/0/boundaries`);
  assert.equal(bounds.body.items.at(-1).kind, 'message');
});

test('HTTP：版本切换视图隔离 + compare', async () => {
  const { body: created } = await post('/sessions/create', { versions: ['v1', 'v2'] });
  const sid = created.sessionId;
  const stream = Buffer.concat([buildV1({ seq: 1 }), buildV1({ seq: 2 })]);
  await post(`/sessions/${sid}/fragments`, { fragments: [{ direction: 0, hex: stream.toString('hex') }] });

  const v1 = await getj(`/sessions/${sid}/directions/0/messages?version=v1`);
  assert.equal(v1.body.version, 'v1');
  assert.equal(v1.body.total, 2);
  const v2 = await getj(`/sessions/${sid}/directions/0/messages?version=v2`);
  assert.equal(v2.body.version, 'v2');
  assert.equal(v2.body.total, 0);

  const cmp = await getj(`/sessions/${sid}/directions/0/compare?versions=v1,v2`);
  assert.equal(cmp.body.views.v1.stats.messageCount, 2);
  assert.equal(cmp.body.differences.boundariesAligned, false);
});

test('消费端：补丁晚于慢查询返回时，旧响应被标记 stale，不覆盖当前视图', async () => {
  const view = await client.createSession({ versions: ['v1'] });
  const f1 = buildV1({ seq: 1, cmd: 0x01 });
  await view.importFragments([{ direction: 0, data: f1 }]);

  // 发出慢查询后立刻补片
  const slow = view.messages({ delayMs: 60 });
  const f2 = buildV1({ seq: 2, cmd: 0x02 });
  await view.importFragments([{ direction: 0, offset: f1.length, data: f2 }]);
  const slowResult = await slow;

  assert.equal(slowResult.stale, true);
  assert.equal(slowResult.dropped.kind, 'messages');
  assert.ok(view.stale.length >= 1);

  // 当前视图反映最新状态
  const fresh = await view.messages();
  assert.equal(fresh.stale, false);
  assert.equal(fresh.total, 2);
});

test('消费端：切换方向后，旧方向的迟到响应不会污染新方向', async () => {
  const view = await client.createSession({ versions: ['v1'] });
  await view.importFragments([{ direction: 0, data: buildV1({ seq: 1 }) }]);
  await view.importFragments([{ direction: 1, data: Buffer.concat([buildV1({ seq: 10 }), buildV1({ seq: 11 })]) }]);

  view.select({ direction: 0 });
  const slow = view.messages({ delayMs: 60 });
  view.select({ direction: 1 });
  const result = await slow;
  assert.equal(result.stale, true);

  const cur = await view.messages();
  assert.equal(cur.total, 2);
  assert.deepEqual(cur.messages.map((m) => m.seq), [10, 11]); // 当前为方向1
});

test('HTTP：UDP 多消息数据报与片段清单查询', async () => {
  const { body: created } = await post('/sessions/create', { versions: ['v1'], transport: 'udp' });
  const sid = created.sessionId;
  const dg = Buffer.concat([buildV1({ seq: 1 }), buildV1({ seq: 2 })]);
  await post(`/sessions/${sid}/fragments`, { fragments: [{ direction: 0, hex: dg.toString('hex') }] });
  const msgs = await getj(`/sessions/${sid}/directions/0/messages`);
  assert.equal(msgs.body.total, 2);
  const frags = await getj(`/sessions/${sid}/directions/0/fragments`);
  assert.equal(frags.body.fragments.length, 1);
  assert.equal(frags.body.fragments[0].status, 'accepted');
});
