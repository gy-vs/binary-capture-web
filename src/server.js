'use strict';

// ---------------------------------------------------------------------------
// server.js —— HTTP REST 外壳（只用 node:http）。
//
// 约定：
//  - 原始字节一律以 hex 字符串传输；消息/错误列表不内联大字节，需要时走
//    /bytes/range、/messages/:id/bytes、/errors/:idx/bytes、/segments/:id/bytes；
//  - 所有查询响应带 view + sessionRevision，调用方可识别过期响应；
//  - 写操作经 Workbench 的导入串行链，查询只读快照，并发安全；
//  - 查询支持 _delay=毫秒，模拟“查询比新补丁更晚返回”的现场网络。
// ---------------------------------------------------------------------------

import http from 'node:http';
import { URL } from 'node:url';
import { Workbench, ApiError } from './workbench.js';
import { ValidationError } from './session.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function createServer({ workbench = new Workbench() } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // 延迟发生在“只读快照已取出、响应尚未发出”之间（见 sendJson 的 pendingFlush），
      // 用以模拟查询在网络上比后发的补片更晚返回。
      const d = Number(url.searchParams.get('_delay') || 0);
      if (d > 0) res[pendingFlush] = () => delay(d);
      await route(workbench, req, res, url);
    } catch (err) {
      const status = err.status || 500;
      sendJson(res, status, {
        error: err.status ? err.message : `内部错误: ${err.message}`,
        stack: err.status ? undefined : err.stack
      });
    }
  });
  return server;
}

const pendingFlush = Symbol('pendingFlush');

async function route(wb, req, res, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;
  const method = req.method;
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readJson(req) : null;

  // --- 会话 ---
  if (p === '/sessions' && method === 'POST') {
    return sendJson(res, 201, wb.createSession(body || {}));
  }
  if (p === '/sessions' && method === 'GET') {
    return sendJson(res, 200, { sessions: wb.listSessions() });
  }

  let m;
  if ((m = p.match(/^\/sessions\/([^/]+)$/)) && method === 'GET') {
    return sendJson(res, 200, wb.getSession(m[1]).toSummary());
  }

  // --- 片段导入 / 查询 ---
  if ((m = p.match(/^\/sessions\/([^/]+)\/segments$/)) && method === 'POST') {
    const segments = (body?.segments || [body]).map(normalizeSegment);
    const result = await wb.importSegments(m[1], segments);
    return sendJson(res, 200, result);
  }
  if ((m = p.match(/^\/sessions\/([^/]+)\/segments$/)) && method === 'GET') {
    return sendJson(res, 200, {
      segments: wb.listSegments(m[1], q.get('direction') || undefined)
    });
  }
  if ((m = p.match(/^\/sessions\/([^/]+)\/segments\/([^/]+)$/)) && method === 'GET') {
    return sendJson(res, 200, wb.getSegmentMeta(m[1], m[2]));
  }
  if ((m = p.match(/^\/sessions\/([^/]+)\/segments\/([^/]+)\/bytes$/)) && method === 'GET') {
    return sendJson(
      res,
      200,
      wb.readSegmentBytes(m[1], m[2], int(q, 'start', 0), int(q, 'end', undefined))
    );
  }

  // --- 视图（独立版本的重组假设） ---
  if ((m = p.match(/^\/sessions\/([^/]+)\/views$/)) && method === 'POST') {
    return sendJson(res, 201, wb.createView(m[1], body || {}));
  }
  if ((m = p.match(/^\/sessions\/([^/]+)\/views$/)) && method === 'GET') {
    return sendJson(res, 200, { views: wb.listViews(m[1]) });
  }
  if ((m = p.match(/^\/views\/([^/]+)$/)) && method === 'GET') {
    return sendJson(res, 200, wb.getView(m[1]).toSummary());
  }

  // 方向与视图下的查询
  const vq = (m2) => {
    if (!m2) return null;
    return {
      viewId: m2[1],
      direction: m2[2]
    };
  };

  if ((m = vq(p.match(/^\/views\/([^/]+)\/(c2s|s2c)\/progress$/))) && method === 'GET') {
    return sendJson(res, 200, wb.progress(m.viewId, m.direction));
  }
  if ((m = vq(p.match(/^\/views\/([^/]+)\/(c2s|s2c)\/messages$/))) && method === 'GET') {
    return sendJson(
      res,
      200,
      wb.messages(m.viewId, m.direction, {
        limit: int(q, 'limit', 100),
        offset: int(q, 'offset', undefined),
        startAfter: int(q, 'startAfter', undefined)
      })
    );
  }
  if ((m = p.match(/^\/views\/([^/]+)\/(c2s|s2c)\/messages\/([^/]+)$/)) && method === 'GET') {
    return sendJson(res, 200, {
      view: wb.getView(m[1]).toSummary(),
      direction: m[2],
      boundary: wb.boundary(m[1], m[2], { messageId: m[3] })
    });
  }
  if ((m = p.match(/^\/views\/([^/]+)\/(c2s|s2c)\/messages\/([^/]+)\/bytes$/)) && method === 'GET') {
    return sendJson(res, 200, wb.messageBytes(m[1], m[2], m[3]));
  }
  if ((m = vq(p.match(/^\/views\/([^/]+)\/(c2s|s2c)\/errors$/))) && method === 'GET') {
    return sendJson(res, 200, wb.errors(m.viewId, m.direction, { limit: int(q, 'limit', 100) }));
  }
  if ((m = p.match(/^\/views\/([^/]+)\/(c2s|s2c)\/errors\/(\d+)$/)) && method === 'GET') {
    return sendJson(
      res,
      200,
      wb.errorBytes(m[1], m[2], Number(m[3]), { datagramIndex: int(q, 'datagramIndex', undefined) })
    );
  }
  if ((m = vq(p.match(/^\/views\/([^/]+)\/(c2s|s2c)\/boundary$/))) && method === 'GET') {
    return sendJson(
      res,
      200,
      wb.boundary(m.viewId, m.direction, {
        ordinal: int(q, 'ordinal', undefined),
        atOffset: int(q, 'atOffset', undefined)
      })
    );
  }
  if ((m = vq(p.match(/^\/views\/([^/]+)\/(c2s|s2c)\/locate$/))) && method === 'GET') {
    return sendJson(res, 200, wb.locate(m.viewId, m.direction, int(q, 'offset')));
  }
  if ((m = p.match(/^\/views\/([^/]+)\/(c2s|s2c)\/datagrams\/(\d+)\/locate$/)) && method === 'GET') {
    return sendJson(
      res,
      200,
      wb.locateDatagram(m[1], m[2], Number(m[3]), int(q, 'offset'))
    );
  }
  if ((m = vq(p.match(/^\/views\/([^/]+)\/(c2s|s2c)\/bytes\/range$/))) && method === 'GET') {
    const di = int(q, 'datagramIndex', undefined);
    if (di !== undefined) {
      return sendJson(res, 200, wb.reassembleDatagram(m.viewId, m.direction, di, int(q, 'start', 0), int(q, 'end', undefined)));
    }
    return sendJson(res, 200, wb.reassemble(m.viewId, m.direction, int(q, 'start'), int(q, 'end')));
  }
  if ((m = p.match(/^\/views\/([^/]+)\/(c2s|s2c)\/datagrams\/(\d+)\/bytes\/range$/)) && method === 'GET') {
    return sendJson(
      res,
      200,
      wb.reassembleDatagram(m[1], m[2], Number(m[3]), int(q, 'start', 0), int(q, 'end', undefined))
    );
  }

  sendJson(res, 404, { error: `没有这个接口: ${method} ${p}` });
}

function int(q, name, fallback = null) {
  if (!q.has(name) || q.get(name) === '') return fallback ?? undefined;
  const v = Number(q.get(name));
  if (!Number.isInteger(v)) {
    const e = new ApiError(400, `参数 ${name} 必须是整数`);
    throw e;
  }
  return v;
}

function normalizeSegment(seg) {
  const out = { ...seg };
  if (out.data && typeof out.data === 'object' && !Buffer.isBuffer(out.data) && out.data.hex) {
    out.data = out.data.hex;
  }
  if (typeof out.data === 'string') out.data = Buffer.from(out.data, 'hex');
  return out;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    throw new ApiError(400, `请求体不是合法 JSON: ${e.message}`);
  }
}

async function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj, jsonReplacer));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length
  });
  const hook = res[pendingFlush];
  if (hook) {
    res[pendingFlush] = null;
    await hook();
  }
  res.end(buf);
}

function jsonReplacer(key, value) {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  return value;
}
