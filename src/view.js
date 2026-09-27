'use strict';

// ---------------------------------------------------------------------------
// view.js —— 一个“重组假设”的独立版本视图。
//
// 每个 View 有自己的协议版本（v1/v2）、重叠冲突策略（first/last）和解析产物；
// 会话原始片段在 Session 中只存一份，视图通过重放追加日志追赶，互不共享解析结果。
//
// 局部重组（核心）：
//   first 策略不会改写连续前缀，新片段只可能在 frontier 之后成帧 -> 从旧 frontier 续解析；
//   last  策略可能覆盖任意已存在字节 -> 找到受影响区域之前最后一个完整帧边界，从那里重算。
// 因此补入迟到片段只会重算受影响的局部，且坏帧不会影响边界之前已确认的消息。
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { Coverage } from './coverage.js';
import { parseDirection } from './framer.js';
import { DIRECTIONS } from './session.js';

function emptyTcpState() {
  return { cursor: 0, frontier: 0, messages: [], errors: [] };
}

export class View {
  constructor(session, { id = randomUUID(), protocolVersion = 'v1', overlapPolicy = 'first' } = {}) {
    this.session = session;
    this.id = id;
    this.protocolVersion = protocolVersion;
    this.overlapPolicy = overlapPolicy;
    this.caughtUpRev = 0;

    // TCP: 每方向覆盖集合 + 解析产物
    this.tcp = {};
    // UDP: 每方向 index -> 数据报状态
    this.udp = {};
    for (const d of DIRECTIONS) {
      this.tcp[d] = { coverage: new Coverage(), state: emptyTcpState() };
      this.udp[d] = new Map();
    }
  }

  // 追赶会话的追加日志。幂等；返回本次实际处理的片段
  catchUp() {
    const records = this.session.journalSince(this.caughtUpRev);
    for (const rec of records) {
      if (this.session.transport === 'tcp') this._ingestTcp(rec);
      else this._ingestUdp(rec);
    }
    if (records.length > 0) this.caughtUpRev = this.session.revision;
    return records.length;
  }

  _ingestTcp(rec) {
    const t = this.tcp[rec.direction];
    const cov = t.coverage;
    const st = t.state;
    const oldFrontier = st.frontier;

    let cut;
    if (this.overlapPolicy === 'last' && rec.offset < oldFrontier) {
      // 可能覆盖已解析前缀：取覆盖区间起点之前的最后一个完整帧边界
      cut = this._lastFrameEndBefore(st, rec.offset);
    } else {
      // first 或覆盖发生在 frontier 之外：前缀不受影响
      cut = oldFrontier;
    }

    const result = cov.insert(rec.segId, rec.data, rec.offset, this.overlapPolicy);
    if (!result.changed) {
      // 字节未变化（完全重复，或 first 策略下重叠区全被旧字节挡住）：产物保持不变
      return { ingested: true, duplicate: result.duplicated, changed: false, conflicts: result.conflicts };
    }

    if (cut < st.cursor || cut < oldFrontier) {
      // 作废 cut 之后的全部产物（消息/错误），稍后重新解析
      st.messages = st.messages.filter((m) => m.raw.end <= cut);
      st.errors = st.errors.filter((e) => e.raw.end <= cut);
      st.cursor = cut;
    }

    const newFrontier = cov.frontier();
    const parsed = parseDirection(this.protocolVersion, cov, newFrontier, st.cursor, rec.direction);
    const baseOrdinal = st.messages.length;
    st.messages.push(
      ...parsed.messages.map((m) => ({ ...m, ordinal: baseOrdinal + m.ordinal }))
    );
    st.errors.push(...parsed.errors);
    st.cursor = parsed.cursor;
    st.frontier = newFrontier;

    return {
      ingested: true,
      duplicate: result.duplicated,
      changed: result.changed,
      conflicts: result.conflicts,
      reparsedFrom: cut,
      newMessages: parsed.messages.length,
      newErrors: parsed.errors.length
    };
  }

  _lastFrameEndBefore(state, pos) {
    let end = 0;
    for (const m of state.messages) {
      if (m.raw.end <= pos) end = m.raw.end;
      else break;
    }
    return end;
  }

  _ingestUdp(rec) {
    const map = this.udp[rec.direction];
    const idx = rec.index;
    const existing = map.get(idx);

    if (existing) {
      const same = existing.data.equals(rec.data);
      if (same) return { ingested: true, duplicate: true, conflicts: [] };
      const conflicts = [{ start: 0, end: rec.data.length, existingSegId: existing.segId }];
      if (this.overlapPolicy === 'first') {
        return { ingested: false, duplicate: false, kept: existing.segId, conflicts };
      }
      // last：替换数据报
      // fallthrough
    }

    // 每个数据报独立分帧：单块 Coverage 上跑同一套消费语义
    const cov = new Coverage();
    cov.insert(rec.segId, rec.data, 0, 'first');
    const frontier = rec.data.length;
    const parsed = parseDirection(this.protocolVersion, cov, frontier, 0, rec.direction);
    const messages = parsed.messages.map((m) => ({
      ...m,
      id: `${rec.direction}#${idx}:${m.raw.start}`,
      datagramIndex: idx
    }));
    const errors = parsed.errors.map((e) => ({
      ...e,
      datagramIndex: idx,
      segments: cov.locateSpan(e.raw.start, e.raw.end)
    }));
    map.set(idx, {
      index: idx,
      segId: rec.segId,
      data: rec.data,
      coverage: cov,
      messages,
      errors,
      hasTrailingPending: parsed.cursor < frontier && parsed.pending !== null
    });
    return {
      ingested: true,
      duplicate: false,
      conflicts: existing && !existing.data.equals(rec.data) ? [{ start: 0, end: rec.data.length, existingSegId: existing.segId }] : [],
      newMessages: parsed.messages.length,
      newErrors: parsed.errors.length
    };
  }

  // ---------------------------------------------------------------- 查询接口

  progress(direction) {
    if (this.session.transport === 'tcp') return this._tcpProgress(direction);
    return this._udpProgress(direction);
  }

  _tcpProgress(direction) {
    const dirs = direction ? [direction] : DIRECTIONS;
    const out = {};
    for (const d of dirs) {
      const { coverage, state } = this.tcp[d];
      const spanEnd = coverage.spanEnd();
      out[d] = {
        transport: 'tcp',
        revision: this.session.revision,
        frontier: state.frontier,
        spanEnd,
        coveredBytes: coverage.coveredLength(),
        gaps: coverage.gaps(spanEnd),
        messagesConfirmed: state.messages.length,
        parseErrors: state.errors.length,
        pending: this._pending(d),
        lastConsumed: state.cursor
      };
    }
    return direction ? out[direction] : out;
  }

  _udpProgress(direction) {
    const dirs = direction ? [direction] : DIRECTIONS;
    const out = {};
    for (const d of dirs) {
      const map = this.udp[d];
      const indices = [...map.keys()].sort((a, b) => a - b);
      let maxIndex = -1;
      let msgCount = 0;
      let errCount = 0;
      for (const idx of indices) {
        maxIndex = Math.max(maxIndex, idx);
        msgCount += map.get(idx).messages.length;
        errCount += map.get(idx).errors.length;
      }
      const missing = [];
      for (let i = 0; i <= maxIndex; i++) if (!map.has(i)) missing.push(i);
      out[d] = {
        transport: 'udp',
        revision: this.session.revision,
        datagrams: indices.length,
        maxIndex,
        missingDatagrams: missing,
        messagesConfirmed: msgCount,
        parseErrors: errCount
      };
    }
    return direction ? out[direction] : out;
  }

  _pending(direction) {
    const { coverage, state } = this.tcp[direction];
    if (state.cursor >= state.frontier) return null;
    return {
      start: state.cursor,
      end: state.frontier,
      hasSof: coverage.byteAt(state.cursor) === 0xa5,
      coverage: coverage.coverageOf(state.cursor, state.frontier)
    };
  }

  // 已确认消息（不含负载大字段；需要字节走 range/segment 接口）
  messages(direction, { offset, limit = 100, startAfter, within } = {}) {
    let list;
    let locator;
    if (this.session.transport === 'tcp') {
      list = this.tcp[direction].state.messages;
      locator = (m) => m.raw.start;
    } else {
      list = [];
      const map = this.udp[direction];
      for (const [idx, dg] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
        for (const m of dg.messages) list.push({ ...m, datagramIndex: idx });
      }
      locator = (m) => m.raw.start;
    }

    let filtered = list;
    if (within) filtered = filtered.filter((m) => m.raw.end > within.start && m.raw.start < within.end);
    if (startAfter !== undefined) filtered = filtered.filter((m) => locator(m) > startAfter);
    if (offset) filtered = filtered.filter((m) => locator(m) >= offset);
    const total = filtered.length;
    const page = filtered.slice(0, limit);

    return {
      total,
      messages: page.map((m) => this._messageMeta(m)),
      next: page.length === limit ? locator(page[page.length - 1]) + 1 : null
    };
  }

  _messageMeta(m) {
    return {
      id: m.id,
      ordinal: m.ordinal,
      direction: m.direction,
      version: m.version,
      cmd: m.cmd,
      cmdHex: '0x' + m.cmd.toString(16).padStart(2, '0'),
      flags: m.flags,
      payloadLength: m.payloadLength,
      decoded: stripBigFields(m.decoded),
      raw: m.raw,
      logicalLength: m.logicalLength,
      rawLength: m.rawLength,
      fields: m.fields,
      segments: m.segments,
      datagramIndex: m.datagramIndex ?? null
    };
  }

  // 跳到消费边界：按 ordinal / 消息 id / 原始偏移定位
  boundary(direction, { ordinal, messageId, atOffset } = {}) {
    if (this.session.transport === 'udp') {
      throw new Error('UDP 数据报独立成帧，消费边界请用 datagramIndex + 消息 ordinal');
    }
    const list = this.tcp[direction].state.messages;
    let msg = null;
    if (messageId) msg = list.find((m) => m.id === messageId) || null;
    else if (ordinal !== undefined) msg = list[ordinal] || null;
    else if (atOffset !== undefined) {
      msg = list.find((m) => m.raw.start <= atOffset && m.raw.end > atOffset) || null;
      if (!msg) {
        const next = list.find((m) => m.raw.start >= atOffset);
        return { found: false, atOffset, nextBoundary: next ? next.raw.start : null };
      }
    }
    if (!msg) return { found: false };
    return {
      found: true,
      message: this._messageMeta(msg),
      consumeFrom: msg.raw.start,
      consumeAfter: msg.raw.end
    };
  }

  errors(direction, { limit = 100, within } = {}) {
    let list;
    if (this.session.transport === 'tcp') {
      list = this.tcp[direction].state.errors;
    } else {
      list = [];
      const map = this.udp[direction];
      for (const [idx, dg] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
        for (const e of dg.errors) list.push({ ...e, datagramIndex: idx });
      }
    }
    if (within) list = list.filter((e) => e.raw.end > within.start && e.raw.start < within.end);
    const total = list.length;
    return {
      total,
      errors: list.slice(0, limit).map((e) => ({
        code: e.code,
        message: e.message,
        detail: e.detail,
        raw: e.raw,
        fields: e.fields || {},
        segments: e.segments || (this.session.transport === 'tcp' ? this.tcp[direction].coverage.locateSpan(e.raw.start, e.raw.end) : []),
        datagramIndex: e.datagramIndex ?? null
      }))
    };
  }

  // 字节定位：把线上偏移映射回输入片段
  locate(direction, offset) {
    if (this.session.transport === 'tcp') {
      const cov = this.tcp[direction].coverage;
      const b = cov.byteAt(offset);
      const spans = cov.locateSpan(offset, offset + 1);
      return {
        direction,
        offset,
        covered: b !== null,
        byte: b,
        byteHex: b === null ? null : b.toString(16).padStart(2, '0'),
        provenance: spans
      };
    }
    throw new Error('UDP 定位需提供 datagramIndex，请用 locateDatagramByte');
  }

  locateDatagramByte(direction, datagramIndex, offset) {
    const dg = this.udp[direction]?.get(datagramIndex);
    if (!dg) return { direction, datagramIndex, offset, covered: false, provenance: [] };
    const b = offset < dg.data.length ? dg.data[offset] : null;
    return {
      direction,
      datagramIndex,
      offset,
      covered: b !== null && b !== undefined,
      byte: b ?? null,
      byteHex: b === null || b === undefined ? null : b.toString(16).padStart(2, '0'),
      provenance: b === null || b === undefined ? [] : [{ segId: dg.segId, start: offset, end: offset + 1 }]
    };
  }

  // 局部重组：任意字节范围的覆盖状态 + 可重组部分的十六进制（不按消息复制）
  reassemble(direction, start, end) {
    if (this.session.transport === 'tcp') {
      const cov = this.tcp[direction].coverage;
      return this._rangeResult(direction, cov, start, end);
    }
    throw new Error('UDP 重组请用 reassembleDatagram');
  }

  reassembleDatagram(direction, datagramIndex, start = 0, end) {
    const dg = this.udp[direction]?.get(datagramIndex);
    if (!dg) {
      return { direction, datagramIndex, present: false, start, end: end ?? 0, complete: false, hex: '', provenance: [] };
    }
    const e = end ?? dg.data.length;
    const cov = dg.coverage;
    return {
      ...this._rangeResult(direction, cov, start, e),
      datagramIndex,
      present: true,
      segId: dg.segId
    };
  }

  _rangeResult(direction, cov, start, end) {
    const status = cov.coverageOf(start, end);
    const provenance = cov.locateSpan(start, end);
    let hex = '';
    let assembledRanges = [];
    if (status.complete) {
      hex = cov.slice(start, end).toString('hex');
      assembledRanges = [{ start, end }];
    } else {
      // 缺口之间仍可识别的连续段也局部给出
      let cursor = start;
      for (const g of status.gaps) {
        if (g.start > cursor) {
          hex += cov.slice(cursor, g.start).toString('hex');
          assembledRanges.push({ start: cursor, end: g.start });
        }
        cursor = g.end;
      }
      if (cursor < end) {
        hex += cov.slice(cursor, end).toString('hex');
        assembledRanges.push({ start: cursor, end });
      }
    }
    return {
      direction,
      start,
      end,
      complete: status.complete,
      coveredInRange: status.covered,
      gaps: status.gaps,
      hex,
      assembledRanges,
      provenance
    };
  }

  // 解析失败位置的原始字节（坏帧/孤儿数据），含缺口信息，可回溯到片段
  errorBytes(direction, errorIndex, { datagramIndex } = {}) {
    const e = this._findError(direction, errorIndex, datagramIndex);
    if (!e) return null;
    if (this.session.transport === 'tcp') {
      const cov = this.tcp[direction].coverage;
      return {
        ...this._rangeResult(direction, cov, e.raw.start, e.raw.end),
        errorCode: e.code,
        message: e.message
      };
    }
    const dg = this.udp[direction].get(datagramIndex);
    return {
      ...this._rangeResult(direction, dg.coverage, e.raw.start, e.raw.end),
      datagramIndex,
      errorCode: e.code,
      message: e.message
    };
  }

  _findError(direction, errorIndex, datagramIndex) {
    if (this.session.transport === 'tcp') return this.tcp[direction].state.errors[errorIndex] || null;
    const dg = this.udp[direction].get(datagramIndex);
    return dg ? dg.errors[errorIndex] || null : null;
  }

  // 消息负载字节（结构化字段查看时按需取，不进列表响应）
  messageBytes(direction, messageId) {
    const m = this._findMessage(direction, messageId);
    if (!m) return null;
    const payloadRange = m.fields.payload.raw;
    if (this.session.transport === 'tcp') {
      const cov = this.tcp[direction].coverage;
      return {
        messageId,
        payload: { ...this._rangeResult(direction, cov, payloadRange.start, payloadRange.end) },
        frame: this._rangeResult(direction, cov, m.raw.start, m.raw.end)
      };
    }
    const dg = this.udp[direction].get(m.datagramIndex);
    return {
      messageId,
      datagramIndex: m.datagramIndex,
      payload: { ...this._rangeResult(direction, dg.coverage, payloadRange.start, payloadRange.end) },
      frame: this._rangeResult(direction, dg.coverage, m.raw.start, m.raw.end)
    };
  }

  _findMessage(direction, messageId) {
    if (this.session.transport === 'tcp') {
      return this.tcp[direction].state.messages.find((m) => m.id === messageId) || null;
    }
    for (const dg of this.udp[direction].values()) {
      const m = dg.messages.find((x) => x.id === messageId);
      if (m) return { ...m, datagramIndex: dg.index };
    }
    return null;
  }

  toSummary() {
    return {
      viewId: this.id,
      protocolVersion: this.protocolVersion,
      overlapPolicy: this.overlapPolicy,
      caughtUpRev: this.caughtUpRev,
      sessionRevision: this.session.revision
    };
  }
}

function stripBigFields(decoded) {
  // data 原始块不进结构化列表响应；只给长度，需要时走 messageBytes
  if (decoded && decoded.fields && Buffer.isBuffer(decoded.fields.data)) {
    const { data, ...rest } = decoded.fields;
    return { ...decoded, fields: { ...rest, dataHexLength: data.length } };
  }
  return decoded;
}
