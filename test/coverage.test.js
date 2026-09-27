'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coverage } from '../src/coverage.js';

test('乱序插入后 frontier/缺口计算正确', () => {
  const cov = new Coverage();
  cov.insert('a', Buffer.from([1, 2]), 0, 'first');
  cov.insert('b', Buffer.from([7, 8]), 6, 'first');
  assert.equal(cov.frontier(), 2); // [3..6) 缺口阻断连续前缀
  assert.deepEqual(cov.gaps(8), [{ start: 2, end: 6 }]);

  cov.insert('c', Buffer.from([3, 4, 5, 6]), 2, 'first');
  assert.equal(cov.frontier(), 8);
  assert.deepEqual(cov.gaps(8), []);
  assert.deepEqual([...cov.slice(0, 8)], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('完全重复（同字节重叠）识别为 duplicated 且不改字节', () => {
  const cov = new Coverage();
  const r1 = cov.insert('a', Buffer.from([9, 9, 9, 9]), 10, 'first');
  assert.equal(r1.changed, true);
  const r2 = cov.insert('b', Buffer.from([9, 9]), 11, 'first');
  assert.equal(r2.duplicated, true);
  assert.equal(cov.coveredLength(), 4);
});

test('first 策略保留先到字节并报告冲突', () => {
  const cov = new Coverage();
  cov.insert('a', Buffer.from([1, 1, 1]), 0, 'first');
  const r = cov.insert('b', Buffer.from([2, 2]), 1, 'first');
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual([...cov.slice(0, 3)], [1, 1, 1]);
});

test('last 策略用后到字节覆盖旧内容', () => {
  const cov = new Coverage();
  cov.insert('a', Buffer.from([1, 1, 1]), 0, 'last');
  const r = cov.insert('b', Buffer.from([2, 2]), 1, 'last');
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual([...cov.slice(0, 3)], [1, 2, 2]);
});

test('locateSpan 能把字节范围回溯到来源片段（含跨片段区间）', () => {
  const cov = new Coverage();
  cov.insert('a', Buffer.from([1, 2]), 0, 'first');
  cov.insert('b', Buffer.from([3, 4, 5]), 2, 'first');
  const spans = cov.locateSpan(1, 4);
  assert.deepEqual(spans, [
    { segId: 'a', start: 1, end: 2 },
    { segId: 'b', start: 2, end: 4 }
  ]);
});

test('slice 在缺口处抛 GAP 而不是拼出错误字节', () => {
  const cov = new Coverage();
  cov.insert('a', Buffer.from([1]), 0, 'first');
  cov.insert('b', Buffer.from([3]), 2, 'first');
  assert.throws(() => cov.slice(0, 3), (e) => e.code === 'GAP' && e.gapAt === 1);
});

test('coverageOf 给出局部区间的覆盖字节数与子缺口', () => {
  const cov = new Coverage();
  cov.insert('a', Buffer.from([1]), 0, 'first');
  cov.insert('b', Buffer.from([1]), 3, 'first');
  const st = cov.coverageOf(0, 5);
  assert.equal(st.complete, false);
  assert.equal(st.covered, 2);
  assert.deepEqual(st.gaps, [{ start: 1, end: 3 }, { start: 4, end: 5 }]);
});
