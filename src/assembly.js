// 片段装配层（每个方向一个 DirectionAssembly）。
//
// 职责：
//   - 保存原始片段（永不丢弃：重复、冲突、被拒绝的都留痕）
//   - 维护非重叠覆盖区间 spans，增量合并
//   - 维护“从 base 开始的连续水位”watermark 和缺口列表 gaps
//   - 连续字节按需拼接（Buffer.concat），迟到片段只重建一次缓冲
//   - 任意逻辑字节范围 -> 原始片段的溯源（provenance）
//
// 字节模型：TCP 片段用绝对流偏移 offset（= seq - baseSeq）；
// UDP 数据报同样映射到逻辑流（调用方按抓包顺序给 offset），
// 帧消费是否允许跨数据报由 parse 边界标志控制（见 consumer）。

let nextFragSeq = 0;

function autoId() {
  nextFragSeq += 1;
  return `frag_${Date.now().toString(36)}_${nextFragSeq.toString(36)}`;
}

function dataKey(buf, offset) {
  // 小型 FNV-1a 指纹，用于识别同位置同字节的重复重传
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${offset}:${buf.length}:${h.toString(16)}`;
}

export class DirectionAssembly {
  constructor(direction, opts = {}) {
    this.direction = direction;
    this.baseSeq = opts.baseSeq ?? 0;
    this.transport = opts.transport ?? 'tcp';
    this.fragments = new Map(); // id -> { id, offset, end, length, data, status, arrival, ... }
    this.spans = [];            // 非重叠且已排序的覆盖区间 [{start,end,fragmentIds}]
    this.watermark = 0;         // 从 0 起连续覆盖到的位置
    this.gaps = [];             // 已观测区间内的缺口（水位之后的洞）
    this.highWater = 0;         // 已观测的最远字节边界（用于 progress 展示）
    this._contig = null;        // 连续缓冲（覆盖 [0, watermark)）
    this._contigVersion = -1;   // 与 spans 状态对齐的重建标记
    this._spanVersion = 0;
    this.arrivalCount = 0;
    this.marks = []; // UDP 数据报尾部的逻辑偏移（帧不得跨此边界）
  }

  get coveredBytes() {
    let n = 0;
    for (const s of this.spans) n += s.end - s.start;
    return n;
  }

  // 入库一个片段。status: accepted | duplicate | conflict(rejected)
  addFragment(frag) {
    const data = Buffer.from(frag.data ?? frag.hex ?? []);
    const offset = Number.isInteger(frag.offset) ? frag.offset : 0;
    const length = data.length;
    const end = offset + length;
    this.arrivalCount += 1;
    const arrival = { order: this.arrivalCount, at: new Date().toISOString() };

    const existing = frag.id ? this.fragments.get(frag.id) : null;
    if (existing) {
      const record = {
        id: frag.id,
        offset, end, length, data,
        status: 'conflict', rejected: true,
        reason: 'DUPLICATE_ID',
        arrival: { order: this.arrivalCount, at: new Date().toISOString() },
        capturedAt: frag.ts ?? null
      };
      // 用带后缀的内部键保存被拒副本，原始 id 仍指向先到片段（列表通过 values 返回）
      const rejectKey = `${frag.id}#rejected#${this.arrivalCount}`;
      this.fragments.set(rejectKey, record);
      return { status: 'conflict', rejected: { fragmentId: rejectKey, offset, length, reason: 'DUPLICATE_ID', at: record.arrival.at }, changed: false };
    }

    // 同位置重叠的已有片段：逐字节比对，完全一致 = 重传重复；不一致 = 冲突，先到者保留。
    let identicalOverlap = true;
    let hasOverlap = false;
    for (const s of this.spans) {
      if (end <= s.start || offset >= s.end) continue;
      hasOverlap = true;
      for (let p = Math.max(offset, s.start); p < Math.min(end, s.end); p++) {
        if (data[p - offset] !== this.readByte(p)) { identicalOverlap = false; break; }
      }
      if (!identicalOverlap) break;
    }

    if (hasOverlap && !identicalOverlap) {
      const id = frag.id ?? autoId();
      const record = {
        id, offset, end, length, data,
        status: 'conflict', rejected: true,
        reason: 'BYTE_MISMATCH',
        arrival,
        retained: null // 不参与覆盖
      };
      this.fragments.set(id, record);
      return {
        status: 'conflict',
        rejected: { fragmentId: id, offset, length, reason: 'BYTE_MISMATCH', at: arrival.at },
        changed: false
      };
    }

    // 计算该片段相对现有覆盖新增的字节区间（用于 changed 判断和 spans 合并）。
    const pieces = this._newPieces(offset, end);
    const id = frag.id ?? autoId();
    const record = {
      id,
      offset, end, length,
      data,
      status: hasOverlap ? 'duplicate' : 'accepted',
      duplicate: hasOverlap && identicalOverlap,
      overlapBytes: hasOverlap ? this._overlapBytes(offset, end) : 0,
      newBytes: pieces.reduce((n, p) => n + (p[1] - p[0]), 0),
      arrival,
      capturedAt: frag.ts ?? null
    };
    this.fragments.set(id, record);
    if (pieces.length > 0) {
      this._mergeSpans(offset, end, id);
      this._tick();
    }
    if (this.transport === 'udp' && length > 0 && !this.marks.includes(end)) {
      this.marks.push(end);
      this.marks.sort((a, b) => a - b);
    }
    return {
      status: record.status,
      fragmentId: id,
      changed: pieces.length > 0,
      newBytes: record.newBytes,
      duplicate: record.duplicate,
      at: arrival.at
    };
  }

  _overlapBytes(start, end) {
    let n = 0;
    for (const s of this.spans) {
      if (end <= s.start || start >= s.end) continue;
      n += Math.min(end, s.end) - Math.max(start, s.start);
    }
    return n;
  }

  _newPieces(start, end) {
    let cursor = start;
    const pieces = [];
    for (const s of this.spans) {
      if (s.end <= cursor) continue;
      if (s.start >= end) break;
      if (s.start > cursor) pieces.push([cursor, s.start]);
      cursor = Math.max(cursor, s.end);
      if (cursor >= end) break;
    }
    if (cursor < end) pieces.push([cursor, end]);
    return pieces;
  }

  // 把 [start,end) 并入 spans；重叠/相邻区间合并，fragmentIds 保留所有贡献片段。
  _mergeSpans(start, end, fragmentId) {
    const merged = [];
    let cur = { start, end, fragmentIds: new Set([fragmentId]) };
    for (const s of this.spans) {
      if (s.end < cur.start || s.start > cur.end) {
        merged.push(s);
        continue;
      }
      cur.start = Math.min(cur.start, s.start);
      cur.end = Math.max(cur.end, s.end);
      for (const id of s.fragmentIds) cur.fragmentIds.add(id);
    }
    merged.push(cur);
    merged.sort((a, b) => a.start - b.start);
    // 相邻（含重叠）再合一遍
    const out = [];
    for (const s of merged) {
      const last = out[out.length - 1];
      if (last && s.start <= last.end) {
        last.end = Math.max(last.end, s.end);
        for (const id of s.fragmentIds) last.fragmentIds.add(id);
      } else {
        out.push({ start: s.start, end: s.end, fragmentIds: new Set(s.fragmentIds) });
      }
    }
    this.spans = out;
    this._spanVersion += 1;
  }

  _tick() {
    let wm = 0;
    for (const s of this.spans) {
      if (s.start <= wm) wm = Math.max(wm, s.end);
      else break;
    }
    this.watermark = wm;
    this.highWater = this.spans.reduce((m, s) => Math.max(m, s.end), 0);
    const gaps = [];
    let cursor = wm;
    for (const s of this.spans) {
      if (s.end <= cursor) continue;
      if (s.start > cursor) gaps.push([cursor, s.start]);
      cursor = s.end;
    }
    this.gaps = gaps;
  }

  readByte(pos) {
    for (const s of this.spans) {
      if (pos < s.start || pos >= s.end) continue;
      for (const id of s.fragmentIds) {
        const f = this.fragments.get(id);
        if (f && !f.rejected && pos >= f.offset && pos < f.end) return f.data[pos - f.offset];
      }
    }
    return undefined;
  }

  // 连续缓冲：覆盖 [0, watermark)。迟到片段到达后只重建一次。
  contiguousBuffer() {
    if (this._contig && this._contigVersion === this._spanVersion) return this._contig;
    if (this.watermark === 0) {
      this._contig = Buffer.alloc(0);
      this._contigVersion = this._spanVersion;
      return this._contig;
    }
    const parts = [];
    let cursor = 0;
    // 用覆盖 [0,watermark) 的片段按 offset 切片拼接；优先最小片段集合即可。
    const frags = [...this.fragments.values()]
      .filter((f) => !f.rejected && f.end > 0 && f.offset < this.watermark)
      .sort((a, b) => a.offset - b.offset);
    const used = [];
    for (const f of frags) {
      if (f.end <= cursor) continue;
      const start = Math.max(f.offset, cursor);
      const end = Math.min(f.end, this.watermark);
      if (start >= end) continue;
      parts.push(f.data.subarray(start - f.offset, end - f.offset));
      used.push([start, end, f.id]);
      cursor = end;
      if (cursor >= this.watermark) break;
    }
    const buf = Buffer.concat(parts, this.watermark);
    this._contig = buf;
    this._contigVersion = this._spanVersion;
    this._contigSources = used;
    return buf;
  }

  // 逻辑字节范围 -> 逐片段的来源切分（用于错误字节 / 任意范围溯源）。
  provenance(start, end) {
    const out = [];
    let cursor = start;
    while (cursor < end) {
      const span = this.spans.find((s) => cursor >= s.start && cursor < s.end);
      if (!span) {
        // 跳到下一个 span 或 end，记为缺口
        const next = this.spans.find((s) => s.start > cursor);
        const holeEnd = Math.min(end, next ? next.start : end);
        out.push({ start: cursor, end: holeEnd, covered: false });
        cursor = holeEnd;
        continue;
      }
      const frag = [...span.fragmentIds]
        .map((id) => this.fragments.get(id))
        .find((f) => f && !f.rejected && cursor >= f.offset && cursor < f.end);
      const pieceEnd = Math.min(end, span.end, frag ? frag.end : span.end);
      out.push({
        start: cursor,
        end: pieceEnd,
        covered: true,
        fragmentId: frag.id,
        fragmentOffset: cursor - frag.offset,
        arrival: frag.arrival
      });
      cursor = pieceEnd;
    }
    return out;
  }

  // 读取任意范围（跨缺口）。返回逐段 { covered, data?, fragmentId?, start,end }，零拷贝 subarray。
  readRange(start, end) {
    return this.provenance(start, end).map((seg) => {
      if (!seg.covered) return seg;
      const f = this.fragments.get(seg.fragmentId);
      return {
        ...seg,
        data: f.data.subarray(seg.start - f.offset, seg.end - f.offset)
      };
    });
  }

  progress() {
    return {
      direction: this.direction,
      transport: this.transport,
      baseSeq: this.baseSeq,
      watermark: this.watermark,
      highWater: this.highWater,
      coveredBytes: this.coveredBytes,
      gaps: this.gaps.map(([start, end]) => ({ start, end, length: end - start })),
      fragmentCount: this.fragments.size,
      arrivalCount: this.arrivalCount
    };
  }

  listFragments() {
    return [...this.fragments.values()].map((f) => ({
      id: f.id,
      offset: f.offset,
      end: f.end,
      length: f.length,
      status: f.status,
      duplicate: !!f.duplicate,
      newBytes: f.newBytes ?? 0,
      overlapBytes: f.overlapBytes ?? 0,
      arrival: f.arrival,
      capturedAt: f.capturedAt,
      reason: f.reason ?? null,
      hexPreview: f.data.subarray(0, 16).toString('hex')
    }));
  }

  snapshotMeta() {
    return {
      baseSeq: this.baseSeq,
      transport: this.transport,
      watermark: this.watermark,
      highWater: this.highWater,
      coveredBytes: this.coveredBytes,
      gaps: this.gaps.map((g) => [g[0], g[1]]),
      spans: this.spans.map((s) => ({ start: s.start, end: s.end, fragmentIds: [...s.fragmentIds] })),
      spanVersion: this._spanVersion
    };
  }
}
