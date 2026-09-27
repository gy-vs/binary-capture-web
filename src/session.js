'use strict';

// ---------------------------------------------------------------------------
// session.js —— 会话原始数据层。
//
// 职责：
//  - 原始片段只在此保存一份（Buffer 引用），任何视图/响应不复制大字节；
//  - 导入动作生成只追加的修订日志，视图创建时重放即可得到同一批原始输入；
//  - 不做协议解析（解析是 View 的事），也不做字节拼接（那是 Coverage 的事）。
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

export const DIRECTIONS = ['c2s', 's2c'];

function normalizeDirection(d) {
  if (!DIRECTIONS.includes(d)) {
    throw new ValidationError(`非法方向: ${d}（应为 ${DIRECTIONS.join(' / ')}）`);
  }
  return d;
}

export class Session {
  constructor({ id = randomUUID(), transport = 'tcp', initialSeq = {}, meta = {} } = {}) {
    if (!['tcp', 'udp'].includes(transport)) throw new ValidationError(`非法传输类型: ${transport}`);
    this.id = id;
    this.transport = transport;
    this.meta = meta;
    // TCP: 每个方向第一个片段的 seq 作为偏移 0 的基准
    this.baseSeq = {
      c2s: initialSeq.c2s ?? null,
      s2c: initialSeq.s2c ?? null
    };
    // segId -> 原始片段记录
    this.segments = new Map();
    // 追加日志: {rev, segId, direction, ...}
    this.journal = [];
    this.revision = 0;
    this.createdAt = Date.now();
  }

  _seqToOffset(direction, seq, dataLen) {
    if (this.transport === 'udp') {
      // UDP 用 datagram 序号寻址，不做序列号换算
      return seq;
    }
    if (this.baseSeq[direction] === null || this.baseSeq[direction] === undefined) {
      this.baseSeq[direction] = seq;
      return 0;
    }
    // TCP 序列号回绕（32 位）
    let delta = (seq - this.baseSeq[direction]) >>> 0;
    if (delta > 0x7fffffff) delta -= 0x100000000;
    return delta;
  }

  // 导入一个或多个片段。片段结构：
  //   TCP: {segId?, direction, seq, data:Buffer|hex}
  //   UDP: {segId?, direction, index(=数据报序号), data:Buffer|hex}
  addSegments(segmentsInput) {
    const accepted = [];
    for (const raw of segmentsInput) {
      const direction = normalizeDirection(raw.direction);
      const data = Buffer.isBuffer(raw.data) ? raw.data : Buffer.from(raw.data, 'hex');
      const idHint = raw.segId || raw.id;

      // 重复导入（调用方重发）：同一 segId 直接幂等返回
      if (idHint && this.segments.has(idHint)) {
        accepted.push({ segId: idHint, duplicate: true });
        continue;
      }

      const segId = idHint || `${this.id}-s${this.journal.length + 1}-${randomUUID().slice(0, 8)}`;
      const transportPos = this.transport === 'tcp' ? raw.seq : raw.index;
      if (this.transport === 'tcp' && (transportPos === null || transportPos === undefined)) {
        throw new ValidationError(`TCP 片段必须提供 seq: ${segId}`);
      }
      if (this.transport === 'udp' && transportPos === undefined) {
        throw new ValidationError(`UDP 片段必须提供 index（数据报序号）`);
      }
      const offset = this._seqToOffset(direction, transportPos ?? 0, data.length);

      const record = {
        segId,
        direction,
        data,
        length: data.length,
        capturedAt: raw.capturedAt ?? Date.now(),
        // TCP
        seq: this.transport === 'tcp' ? transportPos : null,
        offset: this.transport === 'tcp' ? offset : null,
        // UDP
        index: this.transport === 'udp' ? transportPos : null,
        meta: raw.meta ?? {}
      };
      this.segments.set(segId, record);
      this.revision += 1;
      this.journal.push({ rev: this.revision, segId });
      accepted.push({ segId, duplicate: false, record });
    }
    return { revision: this.revision, accepted };
  }

  getSegment(segId) {
    return this.segments.get(segId) ?? null;
  }

  listSegments(direction) {
    const out = [];
    for (const rec of this.segments.values()) {
      if (direction && rec.direction !== direction) continue;
      const { data, ...meta } = rec;
      out.push({ ...meta, dataHexLength: data.length });
    }
    return out;
  }

  // 取原始字节（不复制；调用方只读使用）。范围为片段内偏移
  readSegmentBytes(segId, start = 0, end) {
    const rec = this.segments.get(segId);
    if (!rec) return null;
    return rec.data.subarray(start, end ?? rec.data.length);
  }

  // 从某个修订点重放：返回新增片段记录（供 View 追赶）
  journalSince(rev) {
    return this.journal.filter((e) => e.rev > rev).map((e) => this.segments.get(e.segId));
  }

  toSummary() {
    return {
      id: this.id,
      transport: this.transport,
      revision: this.revision,
      baseSeq: this.baseSeq,
      segmentCount: this.segments.size,
      createdAt: this.createdAt,
      meta: this.meta
    };
  }
}
