'use strict';

// ---------------------------------------------------------------------------
// 协议定义：一个带 SOF、长度字段、转义和校验和的虚构二进制协议。
//
// 线上帧（转义之后）:
//   SOF(0xA5)
//   LEN          1 字节, L 的值（负载字节数, 0..4095）
//   CMD          1 字节, 命令码
//   FLAGS        1 字节, bit0..bit7
//   PAYLOAD      L 字节（结构化字段由具体 CMD 解释）
//   CHECK        校验和（见各版本）
//
// 转义（DLE 风格）:
//   帧体是 SOF 之后到校验和（含）之间的全部字节；SOF 本身不转义。
//     0xA5 -> ESC(0x1D) 0x01
//     0x1D -> ESC(0x1D) 0x02
// 帧体内出现孤立 ESC 或 ESC+未知目标 => badEscape 错误，坏帧后继续寻找下一帧。
//
// 校验和:
//   v1: 所有未转义帧体字节（LEN..PAYLOAD）求和模 256
//   v2: 初始值 0x37 的 8 位 CRC（多项式 0x07），同样覆盖 LEN..PAYLOAD
// 同一条字节流在两个版本下会得到不同结论，用来证明视图版本隔离。
// ---------------------------------------------------------------------------

const SOF = 0xa5;
const ESC = 0x1d;
const ESC_SOF = 0x01;
const ESC_ESC = 0x02;

const HEADER_LEN = 3; // LEN + CMD + FLAGS
const CHECK_LEN = 1;
// 单字节长度字段可达 255；协议规定上限 200，超限即 badLength（仍在同一套消费语义里处理）
const MAX_PAYLOAD = 200;

const VERSIONS = {
  v1: {
    id: 'v1',
    checksumKind: 'sum8',
    checksumInit: 0x00,
    maxPayload: MAX_PAYLOAD
  },
  v2: {
    id: 'v2',
    checksumKind: 'crc8',
    checksumInit: 0x37,
    maxPayload: MAX_PAYLOAD
  }
};

function getVersion(id) {
  const v = VERSIONS[id];
  if (!v) {
    throw new Error(`unknown protocol version: ${id}（支持: ${Object.keys(VERSIONS).join(', ')}）`);
  }
  return v;
}

function checksumSum8(bytes) {
  let s = 0;
  for (const b of bytes) s = (s + b) & 0xff;
  return s;
}

// CRC-8（poly 0x07，无反射，无最终异或），初始值可配置
function checksumCrc8(bytes, init = 0x37) {
  let crc = init & 0xff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc & 0xff;
}

function computeChecksum(version, bodyBytes) {
  if (version.checksumKind === 'sum8') return checksumSum8(bodyBytes);
  return checksumCrc8(bodyBytes, version.checksumInit);
}

function escapeBody(body) {
  const out = [];
  for (const b of body) {
    if (b === SOF) {
      out.push(ESC, ESC_SOF);
    } else if (b === ESC) {
      out.push(ESC, ESC_ESC);
    } else {
      out.push(b);
    }
  }
  return Buffer.from(out);
}

// 按命令码解释负载的结构化字段（两个协议版本共用布局；版本差异只在校验和）
function decodeFields(cmd, flags, payload) {
  switch (cmd) {
    case 0x01: { // PING: 无负载
      return { name: 'PING', fields: {} };
    }
    case 0x10: { // DATA: seq(BE32) + data...
      if (payload.length < 4) return { name: 'DATA', fields: {}, truncated: true };
      return {
        name: 'DATA',
        fields: {
          seq: payload.readUInt32BE(0),
          dataLength: payload.length - 4,
          data: payload.subarray(4)
        }
      };
    }
    case 0x20: { // CFG: id(BE16) + mode(1)
      if (payload.length < 3) return { name: 'CFG', fields: {}, truncated: true };
      return {
        name: 'CFG',
        fields: { id: payload.readUInt16BE(0), mode: payload[2] }
      };
    }
    default:
      return { name: `UNKNOWN_0x${cmd.toString(16).padStart(2, '0')}`, fields: {} };
  }
}

// 构造一帧（未转义 body -> 转义后整帧），测试与现场回放都用它造数据
function buildFrame({ cmd, flags = 0, payload = Buffer.alloc(0) }, versionId = 'v1') {
  const version = typeof versionId === 'string' ? getVersion(versionId) : versionId;
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (p.length > version.maxPayload) {
    throw new Error(`payload too large: ${p.length} > ${version.maxPayload}`);
  }
  const body = Buffer.concat([Buffer.from([p.length, cmd, flags]), p]);
  const check = computeChecksum(version, body);
  return Buffer.concat([Buffer.from([SOF]), escapeBody(body), Buffer.from([check])]);
}

// 允许故意制造坏帧：替换转义后整帧中指定的原始偏移字节
function corruptFrame(frame, rawOffset, byte) {
  const out = Buffer.from(frame);
  out[rawOffset] = byte;
  return out;
}

export {
  SOF,
  ESC,
  ESC_SOF,
  ESC_ESC,
  HEADER_LEN,
  CHECK_LEN,
  MAX_PAYLOAD,
  VERSIONS,
  getVersion,
  computeChecksum,
  escapeBody,
  decodeFields,
  buildFrame,
  corruptFrame,
  checksumSum8,
  checksumCrc8
};
