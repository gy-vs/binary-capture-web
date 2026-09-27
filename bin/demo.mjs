#!/usr/bin/env node
// 端到端演示（不依赖 HTTP，直接走公开 API）：
//   1. 建立会话（双方向、双协议版本）
//   2. 乱序 + 切得很碎的片段导入，含重复重传
//   3. 观察水位/缺口/消息/坏帧
//   4. 补入迟到片段后局部结果刷新
//   5. 坏帧字节溯源回原始片段
//   6. 版本对比与并发查询快照隔离
import { Workbench, buildV1 } from '../src/index.js';

const wb = new Workbench();
const sid = wb.createSession({ id: 'demo', versions: ['v1', 'v2'], transport: 'tcp' });
const show = (label, obj) => console.log(`\n=== ${label} ===\n${JSON.stringify(obj, null, 2)}`);

// 方向0：三个 v1 帧 + 一段坏字节
const f1 = buildV1({ seq: 1, cmd: 0x01 });
const f2 = buildV1({ seq: 2, cmd: 0x02, payload: Buffer.from('hello') });
const f3 = buildV1({ seq: 3, cmd: 0x03 });
const noise = Buffer.from([0x00, 0x11, 0x22]);
const stream = Buffer.concat([f1, noise, f2, f3]);
const noiseOff = f1.length;

// 切成碎片并打乱（保留 offset）
const pieces = [];
for (let i = 0; i < stream.length; i += 3) {
  pieces.push({ direction: 0, offset: i, data: stream.subarray(i, Math.min(i + 3, stream.length)), id: `p${i}` });
}
// 先导入后半部分（乱序），前半部分稍后补
const late = pieces.filter((p) => p.offset < f1.length);
const early = pieces.filter((p) => p.offset >= f1.length);
wb.importFragments(sid, { fragments: early });
show('补片前：方向0 进度（水位应为 0，存在缺口）', (await wb.getProgress(sid)).directions[0]);

wb.importFragments(sid, { fragments: late });
const dup = wb.importFragments(sid, { fragments: [{ direction: late[0].direction, offset: late[0].offset, data: late[0].data }] }); // 无 id 同字节重传
console.log(`\n重复片段导入 -> status=${dup.results[0].status}, revision 未变化: ${dup.revision === 2}`);

show('补齐后消息（v1，坏帧后仍恢复）',
  (await wb.getMessages(sid, 0, 'v1')).messages.map((m) => ({ seq: m.seq, cmd: m.cmdName, range: [m.start, m.end] })));

const errs = await wb.getErrors(sid, 0, 'v1');
show('坏帧记录', errs.errors);
const badBytes = await wb.readErrorBytes(sid, 0, 'v1', 0);
show('坏帧原始字节（溯源到片段）', badBytes.segments);
console.log(`\n坏字节位于偏移 ${noiseOff}..${noiseOff + noise.length}，来源片段 ${badBytes.segments[0].fragmentId}`);

show('版本对比 v1 vs v2（同一份原始字节）', await wb.compare(sid, 0, ['v1', 'v2']));

// 并发：慢查询 vs 新补丁
const slow = wb.getMessages(sid, 0, 'v1', { delayMs: 30 });
wb.importFragments(sid, { fragments: [{ direction: 0, offset: stream.length, data: buildV1({ seq: 4, cmd: 0x04 }) }] });
const lateResp = await slow;
const fresh = await wb.getMessages(sid, 0, 'v1');
console.log(`\n并发：慢查询返回 revision=${lateResp.revision} 消息数=${lateResp.total}；当前 revision=${fresh.revision} 消息数=${fresh.total}`);

show('最终片段清单（accepted/duplicate 全留痕）', (await wb.getFragments(sid, 0)).fragments.map((f) => ({
  id: f.id, offset: f.offset, status: f.status, duplicate: f.duplicate
})));
