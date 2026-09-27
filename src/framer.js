'use strict';

// ---------------------------------------------------------------------------
// framer.js —— 唯一的“消费语义”实现。
//
// 长度字段、转义、校验和、跨片段字段全部由这里的逻辑读取器解释；
// 输入不是拼好的 Buffer，而是一个字节覆盖模型（Coverage）：
//   coverage.byteAt(pos) -> 数字 | null（未到达/缺口）
//   coverage.locateSpan(start,end) -> [{segId,start,end}]
//
// 关键保证：
//  1. 只从连续覆盖的前缀字节读取，缺一字节就停在 SOF 处等待（pending）；
//  2. 任何坏帧（长度非法 / 转义非法 / 校验错误）只作废本帧并从 SOF+1 重新狩猎，
//     不会吞掉后续仍可识别的消息；
//  3. 所有消息与错误都带线上字节范围，且范围可回溯到具体输入片段。
// ---------------------------------------------------------------------------

import {
  SOF,
  ESC,
  ESC_SOF,
  ESC_ESC,
  HEADER_LEN,
  CHECK_LEN,
  getVersion,
  computeChecksum,
  decodeFields
} from './protocol.js';

// 从逻辑字节下标区间映射回线上原始区间涉及的片段
function logicalFieldSpans(coverage, raws, logStart, logEnd) {
  const positions = [];
  for (let i = logStart; i < logEnd; i++) positions.push(raws[i]);
  if (positions.length === 0) return { raw: { start: 0, end: 0 }, segments: [] };
  const rawStart = positions[0];
  const rawEnd = positions[positions.length - 1] + 1;
  return { raw: { start: rawStart, end: rawEnd }, segments: coverage.locateSpan(rawStart, rawEnd) };
}

// 在 sof 处尝试消费一帧。返回 status: 'complete' | 'incomplete' | 'error'
function readFrame(version, coverage, frontier, sof, direction, ordinal) {
  let raw = sof + 1;
  const logical = []; // 每个逻辑字节对应的线上位置（转义会占用 2 个线上字节）
  const raws = () => logical;

  const readLogical = () => {
    if (raw >= frontier) return { kind: 'incomplete' };
    const b = coverage.byteAt(raw);
    if (b === null) return { kind: 'incomplete' };
    if (b !== ESC) {
      logical.push(raw);
      raw += 1;
      return { kind: 'ok', value: b };
    }
    const targetPos = raw + 1;
    if (targetPos >= frontier) return { kind: 'incomplete' };
    const target = coverage.byteAt(targetPos);
    if (target === null) return { kind: 'incomplete' };
    if (target === ESC_SOF) {
      logical.push(raw, targetPos);
      raw += 2;
      return { kind: 'ok', value: SOF };
    }
    if (target === ESC_ESC) {
      logical.push(raw, targetPos);
      raw += 2;
      return { kind: 'ok', value: ESC };
    }
    return { kind: 'badEscape', errorEnd: targetPos + 1 };
  };

  const readField = (n) => {
    const logStart = logical.length;
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      const r = readLogical();
      if (r.kind === 'incomplete') return { incomplete: true };
      if (r.kind === 'badEscape') {
        return { badEscape: true, errorEnd: r.errorEnd, fieldLogStart: logStart };
      }
      out[i] = r.value;
    }
    return { bytes: out, logStart, logEnd: logical.length };
  };

  // --- LEN ---
  const lenField = readField(1);
  if (lenField.incomplete) return { status: 'incomplete' };
  if (lenField.badEscape) {
    return badEscapeError(coverage, sof, lenField);
  }
  const payloadLen = lenField.bytes[0];
  if (payloadLen > version.maxPayload) {
    const end = raws()[lenField.logEnd - 1] + 1;
    return {
      status: 'error',
      error: {
        code: 'badLength',
        message: `length ${payloadLen} 超过上限 ${version.maxPayload}`,
        detail: { length: payloadLen, maxPayload: version.maxPayload },
        raw: { start: sof, end },
        fields: {
          sof: { raw: { start: sof, end: sof + 1 }, segments: coverage.locateSpan(sof, sof + 1) },
          length: logicalFieldSpans(coverage, raws(), lenField.logStart, lenField.logEnd)
        }
      },
      resumeAt: sof + 1
    };
  }

  // --- CMD + FLAGS + PAYLOAD ---
  const rest = readField(HEADER_LEN - 1 + payloadLen + CHECK_LEN);
  if (rest.incomplete) return { status: 'incomplete' };
  if (rest.badEscape) {
    return badEscapeError(coverage, sof, rest);
  }

  const cmd = rest.bytes[0];
  const flags = rest.bytes[1];
  const payload = rest.bytes.subarray(2, 2 + payloadLen);
  const checkRecv = rest.bytes[2 + payloadLen];

  const body = Buffer.concat([Buffer.from([payloadLen, cmd, flags]), payload]);
  const checkExpect = computeChecksum(version, body);

  const frameEnd = raw; // 校验和之后
  const fieldRanges = (logStart, logEnd) => logicalFieldSpans(coverage, raws(), logStart, logEnd);

  if (checkRecv !== checkExpect) {
    const checkLogStart = HEADER_LEN + payloadLen;
    return {
      status: 'error',
      error: {
        code: 'checksumMismatch',
        message: `校验和不匹配: 收到 0x${checkRecv.toString(16).padStart(2, '0')}, 期望 0x${checkExpect
          .toString(16)
          .padStart(2, '0')} (${version.id})`,
        detail: { checkRecv, checkExpect, version: version.id, cmd, payloadLength: payloadLen },
        raw: { start: sof, end: frameEnd },
        fields: {
          sof: { raw: { start: sof, end: sof + 1 }, segments: coverage.locateSpan(sof, sof + 1) },
          length: fieldRanges(0, 1),
          cmd: fieldRanges(1, 2),
          flags: fieldRanges(2, 3),
          payload: fieldRanges(3, 3 + payloadLen),
          checksum: fieldRanges(checkLogStart, checkLogStart + 1)
        },
        segments: coverage.locateSpan(sof, frameEnd)
      },
      // 长度字段合法、帧边界可信：从整帧之后继续，不把坏帧体内的偶然字节误判为孤儿
      resumeAt: frameEnd
    };
  }

  const decoded = decodeFields(cmd, flags, payload);
  const message = {
    id: `${direction}:${sof}`,
    ordinal,
    direction,
    version: version.id,
    cmd,
    flags,
    payload,
    payloadLength: payloadLen,
    decoded,
    raw: { start: sof, end: frameEnd },
    logicalLength: body.length + 1,
    rawLength: frameEnd - sof,
    fields: {
      sof: { raw: { start: sof, end: sof + 1 }, segments: coverage.locateSpan(sof, sof + 1) },
      length: fieldRanges(0, 1),
      cmd: fieldRanges(1, 2),
      flags: fieldRanges(2, 3),
      payload: fieldRanges(3, 3 + payloadLen),
      checksum: fieldRanges(HEADER_LEN + payloadLen, HEADER_LEN + payloadLen + 1)
    },
    segments: coverage.locateSpan(sof, frameEnd)
  };
  return { status: 'complete', message, next: frameEnd };
}

function badEscapeError(coverage, sof, failed) {
  return {
    status: 'error',
    error: {
      code: 'badEscape',
      message: `非法转义序列 @raw ${failed.errorEnd - 2}..${failed.errorEnd}`,
      detail: {},
      raw: { start: sof, end: failed.errorEnd },
      fields: {},
      segments: coverage.locateSpan(sof, failed.errorEnd)
    },
    resumeAt: sof + 1
  };
}

// 对一个方向的连续前缀 [0, frontier) 做（增量）解析。
// startPos 之前的结果由调用方保留；本函数只返回 startPos 之后新确认的内容。
function parseDirection(versionId, coverage, frontier, startPos, direction) {
  const version = getVersion(versionId);
  const messages = [];
  const errors = [];
  let cursor = startPos;

  while (cursor < frontier) {
    // HUNT：找下一个 SOF
    let sof = -1;
    for (let p = cursor; p < frontier; p++) {
      if (coverage.byteAt(p) === SOF) {
        sof = p;
        break;
      }
    }
    if (sof < 0) {
      // 剩余字节里没有任何 SOF —— 永久孤儿数据，不会再成帧
      errors.push({
        code: 'orphanData',
        message: `[${cursor}, ${frontier}) 之间没有帧起始标志`,
        detail: {},
        raw: { start: cursor, end: frontier },
        fields: {},
        segments: coverage.locateSpan(cursor, frontier)
      });
      cursor = frontier;
      break;
    }
    if (sof > cursor) {
      errors.push({
        code: 'orphanData',
        message: `[${cursor}, ${sof}) 之间的字节不属于任何帧`,
        detail: {},
        raw: { start: cursor, end: sof },
        fields: {},
        segments: coverage.locateSpan(cursor, sof)
      });
    }

    const result = readFrame(version, coverage, frontier, sof, direction, messages.length);
    if (result.status === 'incomplete') {
      // 帧未到齐：光标留在 SOF，迟到片段补入后从这里继续
      cursor = sof;
      break;
    }
    if (result.status === 'error') {
      errors.push(result.error);
      cursor = result.resumeAt;
      continue;
    }
    messages.push(result.message);
    cursor = result.next;
  }

  return {
    messages,
    errors,
    cursor,
    pending:
      cursor < frontier
        ? { start: cursor, end: frontier, hasSof: coverage.byteAt(cursor) === SOF }
        : null
  };
}

export { parseDirection, readFrame };
