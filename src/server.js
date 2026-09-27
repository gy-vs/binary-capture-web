// HTTP 服务：把 Workbench 暴露为 JSON 接口（仅使用 Node 标准库）。
//
// 每个响应都回显：
//   x-session-revision : 响应生成时的会话修订号
//   x-request-token    : 调用方提供的令牌（原样回显，供消费端丢弃过期响应）
// 查询接口支持 ?delayMs= 模拟“服务端查询比新补丁更晚返回”。

import http from 'node:http';
import { URL } from 'node:url';
import { Workbench } from './store.js';

const MAX_BODY = 8 * 1024 * 1024;

export function createServer(workbench = new Workbench()) {
  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, 'http://localhost');
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const q = (name, def) => parsed.searchParams.has(name) ? parsed.searchParams.get(name) : def;
    const token = req.headers['x-request-token'] ?? q('token', null);
    const delayMs = Number(q('delayMs', 0)) || 0;

    const send = (status, body, extraHeaders = {}) => {
      const headers = { 'content-type': 'application/json; charset=utf-8', ...extraHeaders };
      if (token) headers['x-request-token'] = token;
      if (body && typeof body === 'object' && 'revision' in body) {
        headers['x-session-revision'] = String(body.revision);
      }
      const payload = JSON.stringify(body);
      res.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    };

    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
      await route({ req, res, pathname, q, body, send, delayMs, workbench });
    } catch (err) {
      const status = err.statusCode || 400;
      send(status, { error: err.message || String(err) });
    }
  });
  server.workbench = workbench;
  return server;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求体过大'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('非法 JSON'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function paged(q, extra = {}) {
  return {
    limit: clampInt(q('limit', extra.limit ?? 256), 1, 4096),
    offset: clampInt(q('offset', 0), 0, Infinity),
    delayMs: clampInt(q('delayMs', 0), 0, 60000),
    ...extra
  };
}

function clampInt(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

async function route({ req, res, pathname, q, body, send, delayMs, workbench }) {
  const method = req.method;
  const m = (pattern, allowMethods = null) => {
    if (allowMethods && !allowMethods.includes(method)) return null;
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, '(?<$1>[^/]+)') + '$');
    return pathname.match(re);
  };

  // 健康检查
  if (pathname === '/health') return send(200, { ok: true, service: 'packet-reassembly-workbench' });
  if (pathname === '/protocols') {
    return send(200, { protocols: Object.fromEntries(Object.entries(workbench.protocols).map(([id, p]) => [id, { id, name: p.name }])) });
  }

  // 会话列表 / 创建（POST /sessions 或 /sessions/create）
  if (pathname === '/sessions' || (pathname === '/sessions/create' && method === 'POST')) {
    if (method === 'POST') {
      const id = workbench.createSession(body);
      return send(201, { sessionId: id, revision: 0 });
    }
    return send(200, { sessions: workbench.listSessions() });
  }

  let r;
  r = m('/sessions/:id', ['GET']);
  if (r) return send(200, await workbench.getProgress(r.groups.id, { delayMs }));

  r = m('/sessions/:id/fragments', ['POST']);
  if (r) return send(200, await workbench.importFragments(r.groups.id, body));

  r = m('/sessions/:id/directions/:dir/fragments', ['POST']);
  if (r) {
    const dir = Number(r.groups.dir);
    const fragments = (body.fragments ?? [body]).map((f) => ({ ...f, direction: dir }));
    return send(200, await workbench.importFragments(r.groups.id, { fragments }));
  }

  r = m('/sessions/:id/directions/:dir/progress', ['GET']);
  if (r) {
    const all = await workbench.getProgress(r.groups.id, { delayMs });
    return send(200, { ...all, progress: all.directions[r.groups.dir] });
  }

  r = m('/sessions/:id/directions/:dir/fragments', ['GET']);
  if (r) return send(200, await workbench.getFragments(r.groups.id, r.groups.dir, { delayMs }));

  r = m('/sessions/:id/directions/:dir/messages', ['GET']);
  if (r) {
    const opts = paged(q, { includeFields: q('fields', 'false') === 'true' ? true : undefined });
    return send(200, await workbench.getMessages(r.groups.id, r.groups.dir, q('version', undefined), {
      limit: opts.limit, offset: opts.offset, includeFields: !!opts.includeFields, delayMs
    }));
  }

  r = m('/sessions/:id/directions/:dir/messages/:idx', ['GET']);
  if (r) {
    return send(200, await workbench.getMessage(r.groups.id, r.groups.dir, q('version', undefined), Number(r.groups.idx), { delayMs }));
  }

  r = m('/sessions/:id/directions/:dir/errors', ['GET']);
  if (r) {
    const opts = paged(q);
    return send(200, await workbench.getErrors(r.groups.id, r.groups.dir, q('version', undefined), { limit: opts.limit, offset: opts.offset, delayMs }));
  }

  r = m('/sessions/:id/directions/:dir/errors/:idx/bytes', ['GET']);
  if (r) {
    const opts = paged(q, { limit: 128 });
    return send(200, await workbench.readErrorBytes(r.groups.id, r.groups.dir, q('version', undefined), Number(r.groups.idx),
      { offset: opts.offset, limit: opts.limit, delayMs }));
  }

  r = m('/sessions/:id/directions/:dir/range', ['GET']);
  if (r) {
    return send(200, await workbench.readRange(r.groups.id, r.groups.dir, {
      start: clampInt(q('start', 0), 0, Infinity),
      end: q('end', null) === null ? undefined : clampInt(q('end', 0), 0, Infinity),
      limit: clampInt(q('limit', 256), 1, 4096),
      format: q('format', 'hex'),
      delayMs
    }));
  }

  r = m('/sessions/:id/directions/:dir/locate/:offset', ['GET']);
  if (r) {
    return send(200, await workbench.locate(r.groups.id, r.groups.dir, q('version', undefined), Number(r.groups.offset), { delayMs }));
  }

  r = m('/sessions/:id/directions/:dir/boundaries', ['GET']);
  if (r) {
    return send(200, await workbench.getBoundaries(r.groups.id, r.groups.dir, q('version', undefined), { delayMs }));
  }

  r = m('/sessions/:id/directions/:dir/compare', ['GET']);
  if (r) {
    const versions = q('versions', null)?.split(',').map((s) => s.trim()).filter(Boolean);
    return send(200, await workbench.compare(r.groups.id, r.groups.dir, versions, { delayMs }));
  }

  throw Object.assign(new Error(`未找到路由: ${pathname}`), { statusCode: 404 });
}

// 允许直接 node src/server.js [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 8080;
  createServer().listen(port, () => {
    console.log(`packet-reassembly-workbench 监听 http://localhost:${port}`);
  });
}
