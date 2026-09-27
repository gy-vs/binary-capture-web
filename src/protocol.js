// 协议定义层。
// 两个协议版本共用同一套“可续帧消费”接口：
//   { kind, message?, error?, idleEnd? }
//     - message: 在 [0, frameEnd) 完整识别一帧
//     - error:   在 [0, errorEnd) 为确定坏字节（跳过后从下一字节重同步）
//     - idle:    [0, idleEnd) 为可丢弃的非帧字节（如多余标志字节）
//     - incomplete: 现有数据不足以判定（必须等更多字节，禁止猜测）
// 长度字段、校验和、转义、跨片段字段都在这里解释；engine 只负责在连续缓冲上反复驱动它。

export const MAX_FRAME_LEN = 0xffff;
export const SCAN_LIMIT = 64 * 1024; // 坏流中前向搜索下一候选帧的上限，避免异常输入下 O(n²)

export const CMD_NAMES = {
  0x01: 'HELLO',
  0x02: 'DATA',
  0x03: 'ACK',
  0x04: 'PING',
  0x05: 'PONG',
  0x7f: 'TERM'
};

export function cmdName(cmd) {
  return CMD_NAMES[cmd] ?? `CMD_0x${cmd.toString(16).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// v1：长度前缀二进制帧（无转义）
//   AA55 | LEN(2,LE) | SEQ | CMD | PAYLOAD(LEN) | CHK
//   CHK = 从 SEQ 起到 PAYLOAD 末尾所有字节的异或和
// ---------------------------------------------------------------------------

const V1_MAGIC = Buffer.from([0xaa, 0x55]);
const V1_HEADER = 6; // magic(2)+len(2)+seq+cmd
const V1_CHK = 1;

function v1Checksum(buf, start, end) {
  let chk = 0;
  for (let i = start; i < end; i++) chk ^= buf[i];
  return chk;
}

// 从 from 起寻找下一个魔数候选（起始位置本身可以是候选）。返回 -1 表示现有数据内没有。
function findMagic(buf, magic, from) {
  outer: for (let p = from; p <= buf.length - magic.length; p++) {
    for (let j = 0; j < magic.length; j++) {
      if (buf[p + j] !== magic[j]) continue outer;
    }
    return p;
  }
  return -1;
}

// 仅有一个不完整魔数前缀时，保留这些字节等待跨片段补齐。
function trailingMagicPrefix(buf, magic) {
  for (let k = magic.length - 1; k > 0; k--) {
    const start = buf.length - k;
    if (start < 0) continue;
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (buf[start + j] !== magic[j]) { ok = false; break; }
    }
    if (ok) return start;
  }
  return buf.length;
}

function v1TryParse(buf) {
  // 1. 起始魔数不匹配：跳到下一个候选魔数；候选不完整则等待。
  if (buf[0] !== V1_MAGIC[0] || (buf.length > 1 && buf[1] !== V1_MAGIC[1])) {
    const next = findMagic(buf, V1_MAGIC, 1);
    if (next >= 0) return { kind: 'error', code: 'BAD_MAGIC', errorEnd: next, detail: '起始魔数错误' };
    const keep = trailingMagicPrefix(buf, V1_MAGIC);
    if (keep === 0) return { kind: 'incomplete' };
    return { kind: 'error', code: 'BAD_MAGIC', errorEnd: keep, detail: '起始魔数错误' };
  }
  // 只有魔数第一字节，第二字节未到。
  if (buf.length < V1_MAGIC.length) return { kind: 'incomplete' };
  if (buf.length < V1_HEADER) return { kind: 'incomplete' };

  const len = buf.readUInt16LE(2);
  if (len > MAX_FRAME_LEN) {
    // 长度字段不可信，不能跳过整帧；从下一个候选魔数重同步。
    const next = findMagic(buf, V1_MAGIC, V1_MAGIC.length);
    if (next >= 0) return { kind: 'error', code: 'BAD_LENGTH', errorEnd: next, detail: `帧长度超限: ${len}` };
    return { kind: 'error', code: 'BAD_LENGTH', errorEnd: buf.length, detail: `帧长度超限: ${len}` };
  }
  const frameEnd = V1_HEADER + len + V1_CHK;
  if (buf.length < frameEnd) return { kind: 'incomplete' };

  const seq = buf[4];
  const cmd = buf[5];
  const wantChk = v1Checksum(buf, 4, frameEnd - 1);
  const gotChk = buf[frameEnd - 1];
  if (wantChk !== gotChk) {
    // 长度可信但校验失败：跳过本帧，从下一个候选魔数继续（本帧体内若含真帧也能找到）。
    const next = findMagic(buf, V1_MAGIC, V1_MAGIC.length);
    const resume = next >= 0 ? next : frameEnd;
    return {
      kind: 'error',
      code: 'BAD_CHECKSUM',
      errorEnd: resume,
      frame: { end: frameEnd, seq, cmd, payloadLen: len },
      detail: `校验和错误: 期望 0x${wantChk.toString(16)} 收到 0x${gotChk.toString(16)}`
    };
  }

  return {
    kind: 'message',
    frameEnd,
    message: {
      seq,
      cmd,
      cmdName: cmdName(cmd),
      payloadLen: len,
      payloadRange: [V1_HEADER, V1_HEADER + len],
      fields: [
        { name: 'magic',   value: '0xaa55', start: 0, end: 2 },
        { name: 'len',     value: len,      start: 2, end: 4 },
        { name: 'seq',     value: seq,      start: 4, end: 5 },
        { name: 'cmd',     value: cmdName(cmd), start: 5, end: 6 },
        { name: 'payload', value: `hex:${buf.slice(V1_HEADER, V1_HEADER + len).toString('hex')}`,
          start: V1_HEADER, end: V1_HEADER + len, encoding: 'hex' },
        { name: 'chk',     value: `0x${gotChk.toString(16)}`, start: frameEnd - 1, end: frameEnd }
      ]
    }
  };
}

// ---------------------------------------------------------------------------
// v2：标志定界 + SLIP 转义 + 校验和
//   0x7E ADDR LEN(1) PAYLOAD(LEN) CHK 0x7E
//   线上 PAYLOAD 与 CHK 中：7D -> 7D 5D，7E -> 7D 5E
//   CHK = (ADDR + LEN + PAYLOAD各字节) & 0xff
// 相邻标志字节(7E7E)作为线路空闲，不报错也不成帧。
// ---------------------------------------------------------------------------

const V2_FLAG = 0x7e;
const V2_ESC = 0x7d;
const V2_MIN_FRAME = 6; // flag addr len chk flag（空载荷）

function v2Checksum(addr, len, payload) {
  let chk = (addr + len) & 0xff;
  for (const b of payload) chk = (chk + b) & 0xff;
  return chk;
}

// 从 from 起找下一个“未被转义”的 FLAG。
function findRawFlag(buf, from) {
  for (let p = from; p < buf.length; p++) {
    if (buf[p] !== V2_FLAG) continue;
    if (p > from && buf[p - 1] === V2_ESC) continue;
    return p;
  }
  return -1;
}

function v2TryParse(buf) {
  if (buf[0] !== V2_FLAG) {
    const next = findRawFlag(buf, 1);
    if (next >= 0) return { kind: 'error', code: 'BAD_FLAG', errorEnd: next, detail: '起始标志缺失' };
    return { kind: 'error', code: 'BAD_FLAG', errorEnd: buf.length, detail: '起始标志缺失' };
  }
  const end = findRawFlag(buf, 1);
  if (end < 0) return { kind: 'incomplete' }; // 结束标志可能在下个片段
  if (end === 1) return { kind: 'idle', idleEnd: 1 }; // 多余的标志字节

  // 反转义 body（buf[1..end)），同时建立“逻辑偏移 -> 线上偏移”的映射，
  // 使结构化字段与错误位置能准确回到跨片段的原始字节。
  const body = buf.subarray(1, end);
  const rawToLog = [];
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    if (b === V2_ESC) {
      if (i + 1 >= body.length) return { kind: 'incomplete' }; // 截断的转义序列
      const e = body[i + 1];
      if (e === 0x5e) { out.push(V2_FLAG); rawToLog.push(i, i + 1); i++; }
      else if (e === 0x5d) { out.push(V2_ESC); rawToLog.push(i, i + 1); i++; }
      else {
        return { kind: 'error', code: 'BAD_ESCAPE', errorEnd: end + 1, detail: `非法转义序列 7D ${e.toString(16)}` };
      }
    } else {
      out.push(b);
      rawToLog.push(i);
    }
  }
  const frame = Buffer.from(out);
  const frameEnd = end + 1;

  if (frame.length < 3) {
    return { kind: 'error', code: 'FRAME_TOO_SHORT', errorEnd: frameEnd, detail: `解码后帧体过短: ${frame.length} 字节` };
  }
  const addr = frame[0];
  const len = frame[1];
  if (frame.length !== 3 + len) {
    return { kind: 'error', code: 'BAD_LENGTH', errorEnd: frameEnd,
      detail: `长度字段 ${len} 与实际载荷 ${frame.length - 3} 不一致` };
  }
  const payload = frame.subarray(2, 2 + len);
  const gotChk = frame[2 + len];
  const wantChk = v2Checksum(addr, len, payload);
  if (wantChk !== gotChk) {
    return { kind: 'error', code: 'BAD_CHECKSUM', errorEnd: frameEnd,
      frame: { end: frameEnd, addr, payloadLen: len },
      detail: `校验和错误: 期望 0x${wantChk.toString(16)} 收到 0x${gotChk.toString(16)}` };
  }

  // seq/cmd 复用载荷前两字节，保证两个版本字段可对比；短载荷只有数据。
  const seq = len >= 1 ? payload[0] : null;
  const cmd = len >= 2 ? payload[1] : null;
  const logStart = (logOff) => 1 + rawToLog[logOff];
  const logEnd = (logOff) => 1 + rawToLog[Math.min(logOff, rawToLog.length - 1)] + 1;
  const fields = [
    { name: 'flag0', value: '0x7e', start: 0, end: 1 },
    { name: 'addr', value: `0x${addr.toString(16)}`, start: logStart(0), end: logEnd(0) },
    { name: 'len', value: len, start: logStart(1), end: logEnd(1) }
  ];
  if (len > 0) {
    fields.push({ name: 'payload', value: `hex:${payload.toString('hex')}`,
      start: logStart(2), end: logEnd(2 + len - 1) + 0, encoding: 'escaped-hex' });
    if (seq !== null) fields.push({ name: 'seq', value: seq, start: logStart(2), end: logEnd(2) });
    if (cmd !== null) fields.push({ name: 'cmd', value: cmdName(cmd), start: logStart(3), end: logEnd(3) });
  }
  fields.push({ name: 'chk', value: `0x${gotChk.toString(16)}`, start: logStart(2 + len), end: logEnd(2 + len) });
  fields.push({ name: 'flag1', value: '0x7e', start: end, end: frameEnd });

  return {
    kind: 'message',
    frameEnd,
    message: {
      seq,
      cmd,
      cmdName: cmd === null ? null : cmdName(cmd),
      addr,
      payloadLen: len,
      payloadRange: [logStart(2), logEnd(2 + len - 1)], // 线上绝对字节范围
      fields
    }
  };
}

// ---------------------------------------------------------------------------
// 帧构造器（测试 / demo 使用；生产输入来自抓包）
// ---------------------------------------------------------------------------

export const PROTOCOLS = {
  v1: {
    id: 'v1',
    name: '长度前缀帧 v1 (LEN-prefix + XOR checksum)',
    tryParse: v1TryParse
  },
  v2: {
    id: 'v2',
    name: '标志转义帧 v2 (HDLC-like FLAG + SLIP escape)',
    tryParse: v2TryParse
  }
};

export function buildV1({ seq = 0, cmd = 0x02, payload = Buffer.alloc(0) }) {
  const body = Buffer.concat([Buffer.from([seq, cmd]), Buffer.from(payload)]);
  let chk = 0;
  for (const b of body) chk ^= b;
  const head = Buffer.alloc(4);
  head[0] = 0xaa; head[1] = 0x55;
  head.writeUInt16LE(body.length - 2, 2); // LEN 只计 PAYLOAD
  return Buffer.concat([head, body, Buffer.from([chk])]);
}

export function buildV2({ addr = 0x11, seq = 0, cmd = 0x02, payload = undefined }) {
  // 默认载荷 [seq, cmd]；调用方显式给 payload 时完全以 payload 为准。
  const pl = payload !== undefined ? Buffer.from(payload) : Buffer.from([seq, cmd]);
  let chk = (addr + pl.length) & 0xff;
  for (const b of pl) chk = (chk + b) & 0xff;
  const raw = Buffer.concat([Buffer.from([addr, pl.length]), pl, Buffer.from([chk])]);
  const esc = [];
  for (const b of raw) {
    if (b === V2_FLAG) esc.push(V2_ESC, 0x5e);
    else if (b === V2_ESC) esc.push(V2_ESC, 0x5d);
    else esc.push(b);
  }
  return Buffer.concat([Buffer.from([V2_FLAG]), Buffer.from(esc), Buffer.from([V2_FLAG])]);
}

export function hex(buf) {
  return Buffer.from(buf).toString('hex');
}
