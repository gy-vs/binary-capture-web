'use strict';

// ---------------------------------------------------------------------------
// workbench.js —— 重组工作台核心门面（无 I/O，可直接在进程内使用）。
//
// Session 保存原始片段与追加修订日志（唯一一份字节）；
// View    是带独立版本号的重组假设（协议版本 + 冲突策略），追赶同一会话日志，
//         视图之间的解析结果完全隔离，切换视图不会串结果。
//
// 所有写操作串行化（importMutex），因此查询与补片并发交错时状态一致；
// 查询返回的响应带 revision，调用方可据此丢弃过期响应。
// ---------------------------------------------------------------------------

import { Session } from './session.js';
import { View } from './view.js';

export class Workbench {
  constructor() {
    this.sessions = new Map(); // id -> Session
    this.views = new Map(); // viewId -> View
    this._importChain = Promise.resolve();
  }

  createSession(options = {}) {
    const session = new Session(options);
    this.sessions.set(session.id, session);
    return session.toSummary();
  }

  getSession(id) {
    const s = this.sessions.get(id);
    if (!s) throw notFound(`会话不存在: ${id}`);
    return s;
  }

  listSessions() {
    return [...this.sessions.values()].map((s) => s.toSummary());
  }

  // 导入片段（批量原子可见：视图追赶时一次看到整批）。
  // 返回一个 Promise，同一工作台内串行提交，避免并发补片互相交错。
  importSegments(sessionId, segments) {
    const session = this.getSession(sessionId);
    const run = this._importChain.then(() => {
      const { revision, accepted } = session.addSegments(segments);
      // 同步追赶所有视图；视图各自独立重放，互不影响
      const viewResults = [];
      for (const view of this.views.values()) {
        if (view.session !== session) continue;
        const before = {
          messages: countMessages(view),
          errors: countErrors(view)
        };
        const n = view.catchUp();
        viewResults.push({
          viewId: view.id,
          caughtUpSegments: n,
          revision,
          before,
          after: { messages: countMessages(view), errors: countErrors(view) }
        });
      }
      return { sessionId, revision, accepted: accepted.map(stripRecord), views: viewResults };
    });
    this._importChain = run.catch(() => {});
    return run;
  }

  listSegments(sessionId, direction) {
    return this.getSession(sessionId).listSegments(direction);
  }

  getSegmentMeta(sessionId, segId) {
    const rec = this.getSession(sessionId).getSegment(segId);
    if (!rec) throw notFound(`片段不存在: ${segId}`);
    const { data, ...meta } = rec;
    return { ...meta, dataLength: data.length };
  }

  // 原始字节只通过范围接口读取，且不复制（Buffer.subarray 视图）
  readSegmentBytes(sessionId, segId, start = 0, end) {
    const rec = this.getSession(sessionId).getSegment(segId);
    if (!rec) throw notFound(`片段不存在: ${segId}`);
    const e = end ?? rec.data.length;
    return {
      segId,
      start,
      end: e,
      length: e - start,
      hex: rec.data.subarray(start, e).toString('hex'),
      provenance: { segId, start, end }
    };
  }

  // 创建带独立版本的重组假设
  createView(sessionId, options = {}) {
    const session = this.getSession(sessionId);
    const view = new View(session, options);
    view.catchUp();
    this.views.set(view.id, view);
    return view.toSummary();
  }

  getView(viewId) {
    const v = this.views.get(viewId);
    if (!v) throw notFound(`视图不存在: ${viewId}`);
    return v;
  }

  listViews(sessionId) {
    return [...this.views.values()].filter((v) => v.session.id === sessionId).map((v) => v.toSummary());
  }

  // 确保视图已追赶（查询时调用；补片通常已追赶，这里处理直建视图后的迟到会话日志）
  _freshView(viewId) {
    const view = this.getView(viewId);
    view.catchUp();
    return view;
  }

  progress(viewId, direction) {
    const view = this._freshView(viewId);
    return { view: view.toSummary(), ...view.progress(direction) };
  }

  messages(viewId, direction, options) {
    const view = this._freshView(viewId);
    return { view: view.toSummary(), direction, ...view.messages(direction, options) };
  }

  errors(viewId, direction, options) {
    const view = this._freshView(viewId);
    return { view: view.toSummary(), direction, ...view.errors(direction, options) };
  }

  boundary(viewId, direction, options) {
    const view = this._freshView(viewId);
    return { view: view.toSummary(), direction, ...view.boundary(direction, options) };
  }

  locate(viewId, direction, offset) {
    const view = this._freshView(viewId);
    if (view.session.transport === 'udp') {
      throw badRequest('UDP 会话请用 locateDatagram 并提供 datagramIndex');
    }
    return view.locate(direction, offset);
  }

  locateDatagram(viewId, direction, datagramIndex, offset) {
    const view = this._freshView(viewId);
    return view.locateDatagramByte(direction, datagramIndex, offset);
  }

  reassemble(viewId, direction, start, end) {
    const view = this._freshView(viewId);
    if (view.session.transport === 'udp') {
      throw badRequest('UDP 会话请用 reassembleDatagram(viewId, direction, datagramIndex, start, end)');
    }
    return view.reassemble(direction, start, end);
  }

  reassembleDatagram(viewId, direction, datagramIndex, start, end) {
    const view = this._freshView(viewId);
    return view.reassembleDatagram(direction, datagramIndex, start, end);
  }

  errorBytes(viewId, direction, errorIndex, options) {
    const view = this._freshView(viewId);
    const result = view.errorBytes(direction, errorIndex, options);
    if (!result) throw notFound(`错误不存在: ${errorIndex}`);
    return result;
  }

  messageBytes(viewId, direction, messageId) {
    const view = this._freshView(viewId);
    const result = view.messageBytes(direction, messageId);
    if (!result) throw notFound(`消息不存在: ${messageId}`);
    return result;
  }
}

function countMessages(view) {
  let n = 0;
  if (view.session.transport === 'tcp') {
    for (const d of ['c2s', 's2c']) n += view.tcp[d].state.messages.length;
  } else {
    for (const d of ['c2s', 's2c']) for (const dg of view.udp[d].values()) n += dg.messages.length;
  }
  return n;
}

function countErrors(view) {
  let n = 0;
  if (view.session.transport === 'tcp') {
    for (const d of ['c2s', 's2c']) n += view.tcp[d].state.errors.length;
  } else {
    for (const d of ['c2s', 's2c']) for (const dg of view.udp[d].values()) n += dg.errors.length;
  }
  return n;
}

function stripRecord(a) {
  if (a.duplicate) return { segId: a.segId, duplicate: true };
  const rec = a.record;
  return {
    segId: rec.segId,
    direction: rec.direction,
    length: rec.length,
    offset: rec.offset,
    seq: rec.seq,
    index: rec.index,
    duplicate: false
  };
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function notFound(msg) {
  return new ApiError(404, msg);
}
function badRequest(msg) {
  return new ApiError(400, msg);
}
