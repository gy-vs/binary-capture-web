import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DirectionAssembly } from '../src/assembly.js';

function frag(offset, data, extra = {}) {
  return { offset, data: Buffer.from(data), ...extra };
}

test('乱序片段：先到远端片段不推进水位，补齐后连续水位到位', () => {
  const a = new DirectionAssembly(0);
  const r2 = a.addFragment(frag(10, Buffer.from('12345')));
  assert.equal(r2.changed, true);
  assert.equal(a.watermark, 0); // 0..10 是缺口，水位仍为 0
  assert.deepEqual(a.gaps, [[0, 10]]);

  a.addFragment(frag(0, Buffer.from('abcdefghij')));
  assert.equal(a.watermark, 15);
  assert.deepEqual(a.gaps, []);
  const buf = a.contiguousBuffer();
  assert.equal(buf.toString(), 'abcdefghij12345');
});

test('乱序多洞：迟到片段逐个填洞，水位单调推进', () => {
  const a = new DirectionAssembly(0);
  a.addFragment(frag(0, Buffer.from('AAAA')));
  a.addFragment(frag(8, Buffer.from('CCCC')));
  a.addFragment(frag(12, Buffer.from('DDDD')));
  assert.equal(a.watermark, 4);
  assert.deepEqual(a.gaps, [[4, 8]]);

  a.addFragment(frag(4, Buffer.from('BBBB')));
  assert.equal(a.watermark, 16);
  assert.deepEqual(a.gaps, []);
  assert.equal(a.contiguousBuffer().toString(), 'AAAABBBBCCCCDDDD');
});

test('重复片段：完全相同的重传记为 duplicate 且不改变状态', () => {
  const a = new DirectionAssembly(0);
  const r1 = a.addFragment(frag(0, Buffer.from('XYZ123'), { id: 'seg1' }));
  assert.equal(r1.status, 'accepted');

  // 同 id 再来 = 冲突拒绝（id 唯一）
  const rSameId = a.addFragment(frag(0, Buffer.from('XYZ123'), { id: 'seg1' }));
  assert.equal(rSameId.status, 'conflict');
  assert.equal(rSameId.rejected.reason, 'DUPLICATE_ID');

  // 无 id、同位置同字节 = 重传重复
  const rDup = a.addFragment(frag(0, Buffer.from('XYZ123')));
  assert.equal(rDup.status, 'duplicate');
  assert.equal(rDup.duplicate, true);
  assert.equal(rDup.changed, false);
  assert.equal(a.watermark, 6);
  // 原始 + 无id重复 + 被拒的同id副本，全部留痕
  assert.equal(a.fragments.size, 3);
  const rejected = [...a.fragments.values()].find((f) => f.reason === 'DUPLICATE_ID');
  assert.ok(rejected && rejected.rejected);
});

test('字节冲突：同位置不同字节拒绝后到者，先到字节不变', () => {
  const a = new DirectionAssembly(0);
  a.addFragment(frag(0, Buffer.from('ABCDEF')));
  const conflict = a.addFragment(frag(2, Buffer.from('XX')));
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.rejected.reason, 'BYTE_MISMATCH');
  assert.equal(a.readByte(2), 0x43); // 'C' 仍然是先到者
  assert.equal(a.contiguousBuffer().toString(), 'ABCDEF');
});

test('部分重叠：新片段扩新区间，重叠一致部分计为重复字节', () => {
  const a = new DirectionAssembly(0);
  a.addFragment(frag(0, Buffer.from('0123456789')));
  const r = a.addFragment(frag(8, Buffer.from('89ABCDEF')));
  assert.equal(r.status, 'duplicate');
  assert.equal(r.changed, true);
  assert.equal(r.newBytes, 6);
  assert.equal(a.watermark, 16);
  assert.equal(a.contiguousBuffer().toString('utf8'), '0123456789ABCDEF');
});

test('字节溯源：任意字节范围可回溯到原始片段与片段内偏移', () => {
  const a = new DirectionAssembly(0);
  a.addFragment(frag(0, Buffer.from('AAAA'), { id: 'p1' }));
  a.addFragment(frag(4, Buffer.from('BBBB'), { id: 'p2' }));
  const prov = a.provenance(2, 7);
  assert.deepEqual(prov.map((p) => [p.fragmentId, p.start, p.end, p.fragmentOffset]),
    [['p1', 2, 4, 2], ['p2', 4, 7, 0]]);
});

test('readRange 跨缺口：返回覆盖段与缺失段，数据为零拷贝 subarray', () => {
  const a = new DirectionAssembly(0);
  const src = Buffer.from('HELLOWORLD');
  a.addFragment(frag(0, src.subarray(0, 5), { id: 'h' }));
  a.addFragment(frag(8, src.subarray(5), { id: 'w' })); // WORLD 位于 8..13
  const segs = a.readRange(0, 13);
  assert.equal(segs[0].covered, true);
  assert.equal(segs[0].data.toString(), 'HELLO');
  assert.equal(segs[1].covered, false);
  assert.deepEqual([segs[1].start, segs[1].end], [5, 8]);
  assert.equal(segs[2].data.toString(), 'WORLD');
  // subarray 与源 Buffer 共享内存
  assert.equal(segs[0].data.buffer, src.buffer);
});

test('缺口查询：高水位之外的区间在 gaps 中正确表达', () => {
  const a = new DirectionAssembly(0);
  a.addFragment(frag(100, Buffer.from('Z')));
  const p = a.progress();
  assert.equal(p.watermark, 0);
  assert.equal(p.highWater, 101);
  assert.deepEqual(p.gaps, [{ start: 0, end: 100, length: 100 }]);
});
