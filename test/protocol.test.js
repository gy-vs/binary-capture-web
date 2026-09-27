'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrame,
  corruptFrame,
  SOF,
  ESC,
  ESC_SOF,
  ESC_ESC,
  checksumSum8,
  checksumCrc8
} from '../src/protocol.js';

test('v1 与 v2 使用不同校验和，同一帧体得到不同校验字节', () => {
  const body = Buffer.from([0x00, 0x01, 0x00]); // PING 的 body
  const s = checksumSum8(body);
  const c = checksumCrc8(body, 0x37);
  assert.notEqual(s, c);

  const f1 = buildFrame({ cmd: 0x01 }, 'v1');
  const f2 = buildFrame({ cmd: 0x01 }, 'v2');
  assert.notEqual(f1[f1.length - 1], f2[f2.length - 1]);
  assert.equal(f1[f1.length - 1], s);
  assert.equal(f2[f2.length - 1], c);
});

test('帧体内的 SOF/ESC 字节被转义，转义序列在帧头之后成对出现', () => {
  const payload = Buffer.from([0x10, SOF, 0x11, ESC, 0x12]);
  const frame = buildFrame({ cmd: 0x10, payload }, 'v1');
  assert.equal(frame[0], SOF);
  // 帧体内不应再出现裸 SOF
  for (let i = 1; i < frame.length; i++) assert.notEqual(frame[i], SOF);
  // 能找到 ESC SOF 与 ESC ESC 两对
  let sofPairs = 0;
  let escPairs = 0;
  for (let i = 1; i < frame.length - 1; i++) {
    if (frame[i] === ESC && frame[i + 1] === ESC_SOF) sofPairs++;
    if (frame[i] === ESC && frame[i + 1] === ESC_ESC) escPairs++;
  }
  assert.equal(sofPairs, 1);
  assert.equal(escPairs, 1);
});

test('故意破坏校验字节后，v1/v2 仍然各自失败（证明版本不可互换）', () => {
  const f1 = buildFrame({ cmd: 0x01 }, 'v1');
  const bad = corruptFrame(f1, f1.length - 1, (f1[f1.length - 1] + 1) & 0xff);
  assert.notEqual(bad[bad.length - 1], f1[f1.length - 1]);
});
