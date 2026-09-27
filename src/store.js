// 工作台核心：会话管理 + 不可变快照查询 + 版本化解析状态。
//
// 并发安全模型（Node 单线程事件循环内）：
//   - 每个查询进入时同步拍 Snapshot（浅拷贝描述符 + 固定 watermark/缓冲视图），
//     之后 await 再久，返回的也是拍快照那一刻的状态；在途查询不会被新补丁污染。
//   - 每次 import 推进 session.revision，响应带回 revision；客户端可据此丢弃过期响应。
//   - import 本身是同步原子批处理：同一批片段要么全部完成解析推进，要么整批失败。

import crypto from 'node:crypto';
import { DirectionAssembly } from './assembly.js';
import { StreamConsumer } from './consumer.js';
import { PROTOCOLS } from './protocol.js';

const DEFAULT_PAGE = 256;
const MAX_PAGE = 4096;
const ERROR_PAGE = 128;

export class Workbench {
  constructor({ protocols = PROTOCOLS, defaultVersions = Object.keys(PROTOCOLS) } = {}) {
    this.protocols = { ...protocols };
    this.defaultVersions = defaultVersions;
    this.sessions = new Map();
  }

  registerProtocol(protocol) {
    if (!protocol.id || typeof protocol.tryParse !== 'function') {
      throw new Error('协议定义必须包含 id 和 tryParse');
    }
    this.protocols[protocol.id] = protocol;
  }

  createSession(opts = {}) {
    const id = opts.id ?? crypto.randomBytes(8).toString('hex');
    if (this.sessions.has(id)) throw Object.assign(new Error('会话已存在'), { statusCode: 409 });
    const session = {
      id,
      createdAt: new Date().toISOString(),
      revision: 0,
      versions: opts.versions ?? this.defaultVersions,
      directions: {
        0: new DirectionAssembly(0, { transport: opts.transport ?? 'tcp', baseSeq: opts.baseSeq?.[0] ?? 0 }),
        1: new DirectionAssembly(1, { transport: opts.transport ?? 'tcp', baseSeq: opts.baseSeq?.[1] ?? 0 })
      },
      consumers: { 0: new Map(), 1: new Map() },
      meta: opts.meta ?? {}
    };
    this.sessions.set(id, session);
    this._ensureConsumers(session);
    return id;
  }

  _ensureConsumers(session) {
    for (const dir of [0, 1]) {
      for (const v of session.versions) {
        if (!this.protocols[v]) throw new Error(`未知协议版本: ${v}`);
        if (!session.consumers[dir].has(v)) {
          session.consumers[dir].set(v, new StreamConsumer(session.directions[dir], this.protocols[v]));
        }
      }
    }
  }

  _get(id) {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error(`会话不存在: ${id}`), { statusCode: 404 });
    return s;
  }

  _dir(session, dir) {
    const d = Number(dir);
    if (!session.directions[d]) throw Object.assign(new Error('direction 必须为 0 或 1'), { statusCode: 400 });
    return d;
  }

  _consumer(session, dir, version) {
    const v = version ?? session.versions[0];
    if (!this.protocols[v]) throw Object.assign(new Error(`未知协议版本: ${v}`), { statusCode: 400 });
    this._ensureConsumers(session);
    return session.consumers[dir].get(v);
  }

  listSessions() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      revision: s.revision,
      versions: [...s.versions],
      directions: { 0: s.directions[0].progress(), 1: s.directions[1].progress() }
    }));
  }

  // -------------------------------------------------------------------------
  // 导入（同步原子批处理，完成后统一增量消费所有版本）
  // -------------------------------------------------------------------------

  importFragments(sessionId, batch) {
    const session = this._get(sessionId);
    const items = batch.fragments ?? [];
    const results = [];
    const before = {
      0: { wm: session.directions[0].watermark, covered: session.directions[0].coveredBytes },
      1: { wm: session.directions[1].watermark, covered: session.directions[1].coveredBytes }
    };
    const touchedDirs = new Set();

    for (const item of items) {
      const dir = this._dir(session, item.direction ?? 0);
      const asm = session.directions[dir];
      const payload = item.hex
        ? { ...item, data: Buffer.from(String(item.hex).replace(/\s+/g, ''), 'hex') }
        : item;
      const r = asm.addFragment(payload);
      results.push({ direction: dir, ...r });
      if (r.changed) touchedDirs.add(dir);
    }

    for (const dir of touchedDirs) {
      this._ensureConsumers(session);
      for (const c of session.consumers[dir].values()) c.pump();
    }
    if (touchedDirs.size > 0) session.revision += 1;

    const bytesChanged = {};
    for (const d of [0, 1]) {
      bytesChanged[d] = {
        watermarkDelta: session.directions[d].watermark - before[d].wm,
        coveredDelta: session.directions[d].coveredBytes - before[d].covered
      };
    }

    return {
      sessionId: session.id,
      revision: session.revision,
      imported: results.length,
      accepted: results.filter((r) => r.status === 'accepted').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      conflicts: results.filter((r) => r.status === 'conflict').length,
      results,
      affected: { directions: [...touchedDirs], bytesChanged }
    };
  }

  // -------------------------------------------------------------------------
  // 快照与延迟模拟
  // -------------------------------------------------------------------------

  async _tick(delayMs) {
    if (delayMs && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  snapshot(sessionId) {
    return new Snapshot(this._get(sessionId), this);
  }

  // 进入时同步拍快照，之后可带延迟返回（模拟慢网络/乱序返回）。
  async _query(sessionId, delayMs, fn) {
    const snap = this.snapshot(sessionId);
    await this._tick(delayMs);
    return fn(snap);
  }

  // -------------------------------------------------------------------------
  // 查询接口
  // -------------------------------------------------------------------------

  async getProgress(sessionId, { delayMs = 0 } = {}) {
    return this._query(sessionId, delayMs, (snap) => ({
      sessionId: snap.session.id,
      revision: snap.revision,
      versions: [...snap.session.versions],
      directions: snap.progress()
    }));
  }

  async getMessages(sessionId, dir, version, { limit = DEFAULT_PAGE, offset = 0, includeFields = false, delayMs = 0 } = {}) {
    const d = this._dir(this._get(sessionId), dir);
    return this._query(sessionId, delayMs, (snap) => {
      const c = snap.consumer(d, version);
      const total = c.messages.length; // 快照 consumer 的 messages 是拍快照时的副本
      return {
        sessionId,
        revision: snap.revision,
        direction: d,
        version: c.versionId,
        total,
        offset,
        limit,
        hasMore: offset + limit < total,
        messages: c.listMessages({ limit, offset, includeFields })
      };
    });
  }

  async getMessage(sessionId, dir, version, index, { delayMs = 0 } = {}) {
    const d = this._dir(this._get(sessionId), dir);
    return this._query(sessionId, delayMs, (snap) => {
      const c = snap.consumer(d, version);
      const msg = c.getMessage(index);
      if (!msg) throw Object.assign(new Error(`消息不存在: #${index}`), { statusCode: 404 });
      return { sessionId, revision: snap.revision, direction: d, version: c.versionId, message: msg };
    });
  }

  async getErrors(sessionId, dir, version, { limit = DEFAULT_PAGE, offset = 0, delayMs = 0 } = {}) {
    const d = this._dir(this._get(sessionId), dir);
    return this._query(sessionId, delayMs, (snap) => {
      const c = snap.consumer(d, version);
      const total = c.errors.length;
      return {
        sessionId, revision: snap.revision, direction: d, version: c.versionId,
        total, offset, limit, hasMore: offset + limit < total,
        errors: c.listErrors({ limit, offset })
      };
    });
  }

  // 读取坏帧原始字节（分页、带片段溯源），不把全部原始字节塞进响应。
  async readErrorBytes(sessionId, dir, version, index, { offset = 0, limit = ERROR_PAGE, delayMs = 0 } = {}) {
    const d = this._dir(this._get(sessionId), dir);
    return this._query(sessionId, delayMs, (snap) => {
      const c = snap.consumer(d, version);
      const err = c.errors[index];
      if (!err) throw Object.assign(new Error(`错误记录不存在: #${index}`), { statusCode: 404 });
      const start = err.start + Math.min(offset, err.length);
      const end = Math.min(err.start + err.length, start + Math.min(limit, MAX_PAGE));
      return {
        sessionId, revision: snap.revision, direction: d, version: c.versionId,
        errorIndex: index, code: err.code, detail: err.detail,
        range: [err.start, err.end], window: [start, end],
        total: err.length, offset, limit, hasMore: end < err.end,
        segments: snap.readRange(d, start, end)
      };
    });
  }

  async readRange(sessionId, dir, { start = 0, end, limit = DEFAULT_PAGE, format = 'hex', delayMs = 0 } = {}) {
    const d = this._dir(this._get(sessionId), dir);
    return this._query(sessionId, delayMs, (snap) => {
      const wEnd = end ?? snap.meta(d).watermark;
      const winStart = Math.max(0, start);
      const winEnd = Math.min(Math.max(winStart, wEnd), winStart + Math.min(limit, MAX_PAGE));
      return {
        sessionId, revision: snap.revision, direction: d,
        window: [winStart, winEnd],
        requested: [start, wEnd],
        hasMore: winEnd < wEnd,
        format,
        segments: snap.readRange(d, winStart, winEnd, format)
      };
    });
  }

  // 任意逻辑字节定位：落在消息/坏帧/缺口/未消费区的什么位置。
  async locate(sessionId, dir, version, offset, { delayMs = 0 } = {}) {
    const d = this._dir(this._get(sessionId), dir);
    return this._query(sessionId, delayMs, (snap) => {
      const c = snap.consumer(d, version);
      const meta = snap.meta(d);
      const pos = Number(offset);
      const result = { sessionId, revision: snap.revision, direction: d, version: c.versionId, offset: pos };
      if (meta.gaps.some(([gs, ge]) => pos >= gs && pos < ge)) result.zone = 'gap';
      else if (pos >= meta.highWater) result.zone = 'unseen';
      else if (pos < c.consumed) {
        const m = c.messages.find((x) => pos >= x.start && pos < x.end);
        const e = c.errors.find((x) => pos >= x.start && pos < x.end);
        if (m) { result.zone = 'message'; result.messageIndex = m.index; result.range = [m.start, m.end]; }
        else if (e) { result.zone = 'error'; result.errorIndex = e.index; result.range = [e.start, e.end]; }
        else result.zone = 'idle';
      } else result.zone = 'pending';
      result.provenance = snap.provenance(d, pos, Math.min(pos + 16, meta.highWater));
      return result;
    });
  }

  async getBoundaries(sessionId, dir, version, { delayMs = 0 } = {}) {
    const d = this._dir(this._get(sessionId), dir);
    return this._query(sessionId, delayMs, (snap) => {
      const c = snap.consumer(d, version);
      return { sessionId, revision: snap.revision, direction: d, version: c.versionId, ...c.boundaries() };
    });
  }

  async getFragments(sessionId, dir, { delayMs = 0 } = {}) {
    const d = this._dir(this._get(sessionId), dir);
    return this._query(sessionId, delayMs, (snap) => ({
      sessionId, revision: snap.revision, direction: d,
      fragments: snap.fragments[d]
    }));
  }

  // 版本对比：同一份原始片段、各自版本的解析结果，统计差异并按边界对齐。
  async compare(sessionId, dir, versions, { delayMs = 0 } = {}) {
    const d = this._dir(this._get(sessionId), dir);
    const vs = (versions ?? this._get(sessionId).versions).map(String);
    return this._query(sessionId, delayMs, (snap) => {
      const views = Object.fromEntries(vs.map((v) => {
        const c = snap.consumer(d, v);
        return [v, {
          stats: c.stats(),
          messages: c.listMessages({ limit: MAX_PAGE }).map((m) => ({
            index: m.index, start: m.start, end: m.end, cmdName: m.cmdName, seq: m.seq, payloadLen: m.payloadLen
          })),
          errors: c.listErrors({ limit: MAX_PAGE }).map((e) => ({
            index: e.index, start: e.start, end: e.end, code: e.code
          }))
        }];
      }));
      return {
        sessionId, revision: snap.revision, direction: d, versions: vs,
        views,
        differences: diffViews(vs, views)
      };
    });
  }
}

function diffViews(versions, views) {
  const out = [];
  for (const v of versions) {
    const w = views[v];
    out.push({
      version: v,
      consumed: w.stats.consumed,
      messages: w.stats.messageCount,
      errors: w.stats.errorCount,
      resync: w.stats.resyncCount,
      blocked: w.stats.blocked
    });
  }
  const ref = views[versions[0]];
  const aligned = versions.slice(1).every((v) =>
    views[v].messages.length === ref.messages.length &&
    views[v].messages.every((m, i) => m.start === ref.messages[i].start && m.end === ref.messages[i].end));
  return { perVersion: out, boundariesAligned: aligned };
}

// ---------------------------------------------------------------------------
// 不可变快照：查询期间即使原始状态继续推进，快照里的描述符/水位保持不变。
// Buffer 来自片段且从不修改；连续缓冲在版本号不变时复用，推进后会生成新缓冲，
// 因此这里固定 spanVersion 与缓冲引用。
// ---------------------------------------------------------------------------

class Snapshot {
  constructor(session, bench) {
    this.session = session;
    this.bench = bench;
    this.revision = session.revision;
    this.asmMeta = {
      0: session.directions[0].snapshotMeta(),
      1: session.directions[1].snapshotMeta()
    };
    // 固定此刻的连续缓冲引用（pump 在快照之后才可能触发重建）
    this.buffers = {
      0: session.directions[0].contiguousBuffer(),
      1: session.directions[1].contiguousBuffer()
    };
    this.watermarks = { 0: this.asmMeta[0].watermark, 1: this.asmMeta[1].watermark };
    // 片段清单在快照时刻固化（迟到片段不会出现在在途查询中）
    this.fragments = {
      0: session.directions[0].listFragments(),
      1: session.directions[1].listFragments()
    };
    // 解析结果也必须在构造瞬间固化：懒构造会越过 await 看到新补丁追加的消息/错误。
    this._consumerViews = { 0: new Map(), 1: new Map() };
    for (const d of [0, 1]) {
      for (const [v, real] of session.consumers[d]) {
        this._consumerViews[d].set(v, makeSnapshotConsumer(this, d, real));
      }
    }
  }

  consumer(dir, version) {
    const v = version ?? this.session.versions[0];
    if (!this.bench.protocols[v]) throw Object.assign(new Error(`未知协议版本: ${v}`), { statusCode: 400 });
    const view = this._consumerViews[dir].get(v);
    if (!view) throw Object.assign(new Error(`会话未启用版本: ${v}`), { statusCode: 400 });
    return view;
  }

  meta(dir) {
    return this.asmMeta[dir];
  }

  progress() {
    const live = {
      0: this.session.directions[0].progress(),
      1: this.session.directions[1].progress()
    };
    // 用快照固定的水位/缺口覆盖 live 中可能已变化的字段
    for (const d of [0, 1]) {
      live[d].watermark = this.asmMeta[d].watermark;
      live[d].highWater = this.asmMeta[d].highWater;
      live[d].coveredBytes = this.asmMeta[d].coveredBytes;
      live[d].gaps = this.asmMeta[d].gaps.map(([start, end]) => ({ start, end, length: end - start }));
    }
    return live;
  }

  // 零拷贝范围读取：data 均为片段 Buffer 的 subarray；format=none 只返回来源结构
  readRange(dir, start, end, format = 'hex') {
    const asm = this.session.directions[dir];
    const segs = asm.readRange(start, end);
    return segs.map((s) => {
      const out = { start: s.start, end: s.end, covered: s.covered };
      if (s.covered) {
        out.fragmentId = s.fragmentId;
        out.fragmentOffset = s.fragmentOffset;
        out.arrival = s.arrival;
        if (format !== 'none') {
          out.hex = s.data.toString('hex');
          if (format === 'utf8') out.text = toPrintable(s.data);
        }
      } else {
        out.hex = null;
        out.missing = true;
      }
      return out;
    });
  }

  provenance(dir, start, end) {
    return this.session.directions[dir].provenance(start, end).map((s) => ({
      start: s.start, end: s.end, covered: s.covered,
      fragmentId: s.fragmentId ?? null,
      fragmentOffset: s.fragmentOffset ?? null
    }));
  }
}

function toPrintable(buf) {
  let s = '';
  for (const b of buf) s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  return s;
}

// 构造一个只读的快照 consumer：数组/consumed 在构造瞬间固定，方法复用 StreamConsumer 逻辑。
function makeSnapshotConsumer(snap, dir, real) {
  const fake = Object.create(Object.getPrototypeOf(real));
  fake.versionId = real.versionId;
  fake.consumed = real.consumed;
  fake.messages = real.messages.slice(0);
  fake.errors = real.errors.slice(0);
  fake.idleBytes = real.idleBytes;
  fake.resyncCount = real.resyncCount;
  fake.assembly = { watermark: snap.watermarks[dir] };
  fake.watermarksForSnapshot = snap.watermarks[dir];
  fake.stats = function () {
    return {
      version: this.versionId,
      consumed: this.consumed,
      messageCount: this.messages.length,
      errorCount: this.errors.length,
      idleBytes: this.idleBytes,
      resyncCount: this.resyncCount,
      blocked: this.consumed < snap.watermarks[dir]
    };
  };
  fake.listMessages = StreamConsumer.prototype.listMessages;
  fake.getMessage = StreamConsumer.prototype.getMessage;
  fake.listErrors = StreamConsumer.prototype.listErrors;
  fake.boundaries = StreamConsumer.prototype.boundaries;
  return fake;
}
