'use strict';

// ---------------------------------------------------------------------------
// coverage.js —— 一个方向上的字节覆盖集合。
//
// 只记录“哪些线上偏移被哪个输入片段覆盖”，不做整段拼接缓冲；
// 支持乱序到达、重复片段识别，以及两种重叠冲突假设：
//   first: 先到的字节为准（默认，TCP 重传内容不一致时的保守策略）
//   last : 后到的字节为准（现场怀疑旧快照被覆盖时的对照假设）
// ---------------------------------------------------------------------------

export class Coverage {
  constructor() {
    // 按 start 排序、互不重叠的覆盖块；data 只引用原始片段 Buffer，不拷贝
    this.chunks = []; // { start, end, segId, data, dataStart }
    this.maxEnd = 0;
  }

  // 二分定位包含 pos 的块
  _chunkIndexAt(pos) {
    const c = this.chunks;
    let lo = 0;
    let hi = c.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pos < c[mid].start) hi = mid - 1;
      else if (pos >= c[mid].end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  byteAt(pos) {
    const i = this._chunkIndexAt(pos);
    if (i === -1) return null;
    const ch = this.chunks[i];
    return ch.data[ch.dataStart + (pos - ch.start)];
  }

  // 连续覆盖前缀长度：[0, frontier) 全部有字节
  frontier() {
    let f = 0;
    for (const ch of this.chunks) {
      if (ch.start <= f) f = Math.max(f, ch.end);
      else break;
    }
    return f;
  }

  coveredLength() {
    let n = 0;
    for (const ch of this.chunks) n += ch.end - ch.start;
    return n;
  }

  spanEnd() {
    return this.maxEnd;
  }

  // 把任意区间映射回来源片段: [{segId, start, end}]（线上偏移，半开）
  locateSpan(start, end) {
    const out = [];
    for (const c of this.chunks) {
      if (c.end <= start) continue;
      if (c.start >= end) break;
      const s = Math.max(c.start, start);
      const e = Math.min(c.end, end);
      if (e > s) out.push({ segId: c.segId, start: s, end: e });
    }
    return out;
  }

  // [0,spanEnd) 内未覆盖区间（缺口）
  gaps(spanEnd = this.maxEnd) {
    const out = [];
    let cursor = 0;
    for (const c of this.chunks) {
      if (c.start > cursor && cursor < spanEnd) {
        out.push({ start: cursor, end: Math.min(c.start, spanEnd) });
      }
      if (c.start < spanEnd) cursor = Math.max(cursor, Math.min(c.end, spanEnd));
    }
    if (cursor < spanEnd) out.push({ start: cursor, end: spanEnd });
    return out;
  }

  ranges() {
    return this.chunks.map((c) => ({ start: c.start, end: c.end, segId: c.segId }));
  }

  // 插入一个片段。segStart 为线上起始偏移，dataStart 为该片段内的子偏移。
  // 返回: { duplicated, changed, conflicts:[{start,end,existingSegId}], bytesAdded }
  insert(segId, data, segStart, policy = 'first', dataStart = 0, dataEnd = data.length) {
    const s = segStart;
    const e = segStart + (dataEnd - dataStart);
    const overlappers = this.chunks.filter((c) => c.end > s && c.start < e);

    const allSame =
      overlappers.length > 0 &&
      overlappers.every((c) => {
        const ovS = Math.max(c.start, s);
        const ovE = Math.min(c.end, e);
        for (let pos = ovS; pos < ovE; pos++) {
          if (this.byteAt(pos) !== data[dataStart + (pos - s)]) return false;
        }
        return true;
      });
    const fullyCovered =
      this.chunks.some((c) => c.start <= s && c.end >= e) &&
      (allSame || overlappers.every((c) => c.segId === segId));
    if (fullyCovered) {
      return { duplicated: true, changed: false, conflicts: [], bytesAdded: 0 };
    }

    const conflicts = [];
    for (const c of overlappers) {
      const ovS = Math.max(c.start, s);
      const ovE = Math.min(c.end, e);
      let same = true;
      for (let pos = ovS; pos < ovE; pos++) {
        if (this.byteAt(pos) !== data[dataStart + (pos - s)]) {
          same = false;
          break;
        }
      }
      if (!same) conflicts.push({ start: ovS, end: ovE, existingSegId: c.segId });
    }

    let pieces;
    if (policy === 'last') {
      // 后到为准：从旧块集合中“挖掉”重叠部分（旧块可能被切成左右两段）
      this.chunks = this._removeOverlap(this.chunks, s, e);
      pieces = [{ start: s, end: e, ds: dataStart }];
    } else {
      // 先到为准：从新区间中扣除所有已有覆盖，剩余逐块插入
      pieces = [{ start: s, end: e, ds: dataStart }];
      for (const c of overlappers) {
        const next = [];
        for (const p of pieces) {
          if (p.end <= c.start || p.start >= c.end) {
            next.push(p);
            continue;
          }
          if (p.start < c.start) {
            next.push({ start: p.start, end: Math.min(p.end, c.start), ds: p.ds });
          }
          if (p.end > c.end) {
            next.push({
              start: Math.max(p.start, c.end),
              end: p.end,
              ds: p.ds + (c.end - p.start)
            });
          }
        }
        pieces = next;
      }
    }

    let bytesAdded = 0;
    for (const p of pieces) {
      if (p.end <= p.start) continue;
      this._insertChunk({ start: p.start, end: p.end, segId, data, dataStart: p.ds });
      bytesAdded += p.end - p.start;
    }
    this.maxEnd = Math.max(this.maxEnd, e);

    return { duplicated: false, changed: bytesAdded > 0, conflicts, bytesAdded };
  }

  // 从块集合中挖掉 [s,e) 的重叠（旧块可能被切成左右两段）
  _removeOverlap(chunks, s, e) {
    const out = [];
    for (const c of chunks) {
      if (c.end <= s || c.start >= e) {
        out.push(c);
        continue;
      }
      if (c.start < s) {
        out.push({ ...c, end: s, dataStart: c.dataStart });
      }
      if (c.end > e) {
        out.push({ ...c, start: e, dataStart: c.dataStart + (e - c.start) });
      }
    }
    return out;
  }

  _insertChunk(ch) {
    const c = this.chunks;
    let i = 0;
    while (i < c.length && c[i].start < ch.start) i++;
    c.splice(i, 0, ch);
    // 合并相邻且同源的块
    if (i + 1 < c.length && c[i].end === c[i + 1].start && c[i].segId === c[i + 1].segId) {
      c[i].end = c[i + 1].end;
      c.splice(i + 1, 1);
    }
    if (i > 0 && c[i - 1].end === c[i].start && c[i - 1].segId === c[i].segId) {
      c[i - 1].end = c[i].end;
      c.splice(i, 1);
    }
  }

  // 从连续前缀取出已重组字节（要求 [start,end) 全覆盖，否则抛 GAP）
  slice(start, end) {
    const out = Buffer.alloc(end - start);
    for (let pos = start; pos < end; pos++) {
      const b = this.byteAt(pos);
      if (b === null) {
        const err = new Error(`range [${start},${end}) 在偏移 ${pos} 处未覆盖`);
        err.code = 'GAP';
        err.gapAt = pos;
        throw err;
      }
      out[pos - start] = b;
    }
    return out;
  }

  coverageOf(start, end) {
    const missing = [];
    let cursor = start;
    for (const c of this.chunks) {
      if (c.end <= start) continue;
      if (c.start >= end) break;
      if (c.start > cursor) missing.push({ start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
    }
    if (cursor < end) missing.push({ start: cursor, end });
    const missingBytes = missing.reduce((n, g) => n + (g.end - g.start), 0);
    return {
      start,
      end,
      covered: end - start - missingBytes,
      gaps: missing,
      complete: missing.length === 0
    };
  }
}
