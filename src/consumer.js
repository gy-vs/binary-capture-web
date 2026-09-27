// 流式消费引擎：把“连续字节缓冲”按某协议版本增量消费成消息/坏帧记录。
//
// 关键性质：
//   - 增量：consumed 之前的结果已固化，迟到片段到达后只处理新增的连续字节
//   - 重同步：坏帧（魔数/长度/校验/转义）只丢掉被精确定位的字节，后续真帧照常识别
//   - 不猜测：解析器返回 incomplete 时绝不推进，等待跨片段补齐
//   - 所有结果使用逻辑绝对偏移，可直接回溯到原始片段
//   - 每个协议版本各自持有独立的 StreamConsumer，结果互不串扰

export class StreamConsumer {
  constructor(assembly, protocol, opts = {}) {
    this.assembly = assembly;
    this.protocol = protocol;
    this.versionId = protocol.id;
    this.consumed = 0;
    this.messages = [];
    this.errors = [];
    this.idleBytes = 0;
    this.resyncCount = 0;
    this.datagramsStrict = opts.datagramsStrict ?? assembly.transport === 'udp';
  }

  stats() {
    return {
      version: this.versionId,
      consumed: this.consumed,
      messageCount: this.messages.length,
      errorCount: this.errors.length,
      idleBytes: this.idleBytes,
      resyncCount: this.resyncCount,
      blocked: this.consumed < this.assembly.watermark
    };
  }

  // 取当前应消费到的上界：UDP 严格模式下不得越过尚未跨过的数据报尾部标记。
  _currentEnd() {
    const wm = this.assembly.watermark;
    if (!this.datagramsStrict || !this.assembly.marks) return wm;
    const mark = this.assembly.marks.find((m) => m > this.consumed);
    if (mark !== undefined && mark < wm) return mark;
    return wm;
  }

  pump() {
    const asm = this.assembly;
    let guard = 0;
    // 防御：任何协议实现缺陷都不允许吞掉整条流，单字节前跳保底。
    const maxSteps = Math.max(8, asm.watermark + 4);

    while (this.consumed < asm.watermark && guard++ < maxSteps) {
      const buf = asm.contiguousBuffer();
      const end = this._currentEnd();
      if (end <= this.consumed) break;
      const view = buf.subarray(this.consumed, end);

      let res;
      try {
        res = this.protocol.tryParse(view);
      } catch (err) {
        this._commitError(1, 'PROTOCOL_ERROR', `解析器异常: ${err.message}`);
        continue;
      }

      if (res.kind === 'incomplete') {
        const mark = asm.marks && asm.marks.find((m) => m > this.consumed);
        if (this.datagramsStrict && mark !== undefined && end === mark) {
          // 剩余字节到数据报结束仍无法成帧：帧不得跨数据报，坏字节截到边界为止。
          const tail = mark - this.consumed;
          this._commitError(tail, 'DATAGRAM_BOUNDARY', '帧跨越数据报边界且在边界处仍不完整');
          continue;
        }
        break; // 等后续片段
      }

      if (res.kind === 'idle') {
        const n = Math.min(res.idleEnd, view.length);
        this.idleBytes += n;
        this.consumed += n;
        continue;
      }

      if (res.kind === 'error') {
        const n = Math.min(res.errorEnd, view.length);
        this._commitError(n, res.code, res.detail, res.frame || null);
        continue;
      }

      if (res.kind === 'message') {
        const base = this.consumed;
        const m = res.message;
        const absFields = (m.fields || []).map((f) => ({
          ...f,
          start: base + f.start,
          end: base + f.end
        }));
        const msg = {
          index: this.messages.length,
          start: base,
          end: base + res.frameEnd,
          seq: m.seq,
          cmd: m.cmd,
          cmdName: m.cmdName,
          addr: m.addr ?? null,
          payloadLen: m.payloadLen,
          payloadRange: m.payloadRange
            ? [base + m.payloadRange[0], base + m.payloadRange[1]]
            : null,
          fields: absFields
        };
        this.messages.push(msg);
        this.consumed += res.frameEnd;
        continue;
      }

      // 未知结果：保守前跳 1 字节并记录，保证不卡死
      this._commitError(1, 'UNKNOWN_PARSE_RESULT', `解析器返回未知类型: ${res.kind}`);
    }
  }

  _commitError(length, code, detail, frame = null) {
    const start = this.consumed;
    const end = start + length;
    this.errors.push({
      index: this.errors.length,
      start,
      end,
      length,
      code,
      detail,
      frame: frame
        ? { end: start + frame.end, seq: frame.seq ?? null, cmd: frame.cmd ?? null, payloadLen: frame.payloadLen ?? null }
        : null
    });
    this.resyncCount += 1;
    this.consumed = end;
  }

  listMessages({ limit = 100, offset = 0, includeFields = false } = {}) {
    const slice = this.messages.slice(offset, offset + limit);
    return slice.map((m) => this._summary(m, includeFields));
  }

  _summary(m, includeFields) {
    const base = {
      index: m.index,
      start: m.start,
      end: m.end,
      length: m.end - m.start,
      seq: m.seq,
      cmd: m.cmd,
      cmdName: m.cmdName,
      addr: m.addr,
      payloadLen: m.payloadLen,
      payloadRange: m.payloadRange
    };
    if (includeFields) base.fields = m.fields;
    return base;
  }

  getMessage(index) {
    const m = this.messages[index];
    if (!m) return null;
    return this._summary(m, true);
  }

  listErrors({ limit = 100, offset = 0 } = {}) {
    return this.errors.slice(offset, offset + limit);
  }

  // 跳到某个消费边界：第 n 条消息之后、第 n 个错误之后、或绝对偏移。
  boundaries() {
    const items = [];
    for (const m of this.messages) items.push({ kind: 'message', index: m.index, offset: m.end, start: m.start, label: `${m.cmdName ?? 'MSG'}#${m.index}` });
    for (const e of this.errors) items.push({ kind: 'error', index: e.index, offset: e.end, start: e.start, label: `${e.code}#${e.index}` });
    items.sort((a, b) => a.offset - b.offset || a.kind.localeCompare(b.kind));
    return { consumed: this.consumed, items };
  }
}
