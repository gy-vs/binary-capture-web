# 二进制协议抓包重组工作台

面向协议开发与现场支持的抓包重组内核。输入是来自不同方向的 TCP/UDP 片段（允许**重复、缺失、乱序、一记录多消息**），输出不是拼接文本，而是：

- 每个方向的**重组进度**（连续水位、覆盖字节、缺口列表）
- 已确认的**消息边界**与结构化字段（逻辑绝对偏移，可回溯到原始片段）
- **无法继续的缺口**与**解析失败的原始字节**（分页读取 + 片段溯源）
- 同一套消费语义解释**帧长、校验和、转义、跨片段字段**，坏帧只重同步、不吞后续消息
- **多协议版本独立对比**，视图互不串扰
- **不可变快照 + 修订号 + 请求令牌**：慢于补丁返回的查询不会污染当前状态

仅依赖 Node.js 20 标准库，无第三方依赖。

## 快速开始

```bash
node --version        # 需要 >= 20
npm test              # 38 个测试（装配/消费/工作台/HTTP/并发压力）
npm run demo          # 端到端演示
npm start             # HTTP 服务，默认 :8080
```

## 架构分层

| 模块 | 职责 |
| --- | --- |
| `src/protocol.js` | 协议版本定义。v1 长度前缀+XOR校验；v2 FLAG 定界+SLIP转义+校验。统一 `tryParse(buf) -> message/error/idle/incomplete`，可续、不猜测 |
| `src/assembly.js` | 片段装配：原始片段留痕、偏移去重、冲突拒绝、覆盖区间 spans、水位 watermark、缺口 gaps、连续缓冲重建、字节 provenance |
| `src/consumer.js` | 流式消费：在连续缓冲上增量驱动协议解析，消息/坏帧全部用逻辑绝对偏移固化；UDP 数据报边界约束 |
| `src/store.js` | `Workbench`：会话/方向/多版本管理、原子批量导入、不可变 `Snapshot` 查询、范围分页、版本对比 |
| `src/server.js` | HTTP JSON 接口，回显 `x-session-revision` / `x-request-token`，`?delayMs=` 模拟慢查询 |
| `src/client.js` | 消费端：保持当前会话/方向/版本选择，generation + token 丢弃迟到响应 |

### 核心语义

- **消费语义只有一套**：长度字段、校验和、转义解码、跨片段字段都由协议对象在“当前连续字节视图”上解释；装配层只管字节连续性。解析器对跨片段边界返回 `incomplete`，引擎不前推任何字节。
- **坏帧恢复**：魔数错误/长度非法/校验失败/非法转义都返回精确的 `errorEnd`，引擎提交错误区间后从该位置继续，帧体内若嵌有真帧也能重新识别。
- **迟到补片是局部刷新**：结果只追加不重算；`consumed` 之前的消息/错误固化，新连续字节只驱动增量消费。
- **字节不整体复制**：范围接口全部分页（默认 256、上限 4096），`data` 是片段 Buffer 的 `subarray`；错误记录只存区间描述符，按需回读；`format=none` 只返回来源结构。
- **溯源**：任何逻辑偏移可映射到 `fragmentId + fragmentOffset + 到达次序`。
- **快照隔离**：查询进入时同步固定水位、spans、连续缓冲引用、消息/错误数组副本；之后无论多久返回都是该修订的状态。

## HTTP 接口

所有响应带 `x-session-revision`；发送 `x-request-token`（或 `?token=`）原样回显。查询接口支持 `?delayMs=`。

| 方法 路径 | 说明 |
| --- | --- |
| `GET  /health` `/protocols` | 健康检查、协议版本清单 |
| `GET  /sessions` · `POST /sessions` 或 `/sessions/create` | 会话列表 / 创建（body: `{versions:['v1','v2'], transport:'tcp'|'udp'}`） |
| `POST /sessions/:id/fragments` | 批量导入 `{fragments:[{direction:0, offset:0, data|hex, id?, ts?}]}`，原子推进 |
| `GET  /sessions/:id/directions/:dir/fragments` | 原始片段清单（accepted/duplicate/conflict 全留痕） |
| `GET  /sessions/:id` | 双方向进度（watermark/gaps/covered/fragmentCount） |
| `GET  .../messages?version=v1&offset=&limit=&fields=true` | 已确认消息（分页） |
| `GET  .../messages/:idx` | 单条消息 + 结构化字段（绝对偏移） |
| `GET  .../errors` · `.../errors/:idx/bytes?offset=&limit=` | 坏帧列表 / 坏帧原始字节分页（含溯源） |
| `GET  .../range?start=&end=&limit=&format=hex|utf8|none` | 字节窗口（跨缺口分段，含片段归属） |
| `GET  .../locate/:offset?version=v1` | 字节定位：message/error/gap/pending/unseen/idle |
| `GET  .../boundaries?version=v1` | 全部消费边界（消息后/错误后），用于跳转 |
| `GET  .../compare?versions=v1,v2` | 同一份字节下多版本解析结果与差异 |

### 快速演练

```bash
curl -s localhost:8080/sessions/create -H 'content-type: application/json' \
  -d '{"versions":["v1","v2"]}'
SID=<上一步 sessionId>
curl -s localhost:8080/sessions/$SID/fragments -H 'content-type: application/json' \
  -d '{"fragments":[{"direction":0,"offset":10,"hex":"a5150300010203aa"}]}'   # 先放远端
curl -s "localhost:8080/sessions/$SID"                                        # 看到缺口 0..10
curl -s localhost:8080/sessions/$SID/fragments -H 'content-type: application/json' \
  -d '{"fragments":[{"direction":0,"offset":0,"hex":"aa550300010401020300"}]}' # 迟到补片
curl -s "localhost:8080/sessions/$SID/directions/0/messages?fields=true"
curl -s "localhost:8080/sessions/$SID/directions/0/compare?versions=v1,v2"
```

## 程序化使用

```js
import { Workbench, buildV1 } from './src/index.js';

const wb = new Workbench();
const sid = wb.createSession({ versions: ['v1', 'v2'] });
wb.importFragments(sid, { fragments: [{ direction: 0, offset: 0, data: buildV1({ seq: 1, cmd: 0x04 }) }] });

const msgs = await wb.getMessages(sid, 0, 'v1');       // 已确认消息
const errs = await wb.getErrors(sid, 0, 'v1');         // 坏帧区间
const bytes = await wb.readErrorBytes(sid, 0, 'v1', 0, { offset: 0, limit: 128 });
const where = await wb.locate(sid, 0, 'v1', 42);       // 字节定位
const cmp = await wb.compare(sid, 0, ['v1', 'v2']);    // 版本对比
// 慢查询与补丁并发：慢查询携带旧 revision，状态不受影响
const slow = wb.getMessages(sid, 0, 'v1', { delayMs: 50 });
```

消费端（防迟到响应覆盖）：

```js
import { WorkbenchClient, buildV1 } from './src/index.js';
const client = new WorkbenchClient('http://localhost:8080');
const view = await client.createSession({ versions: ['v1'] });
await view.importFragments([{ direction: 0, data: buildV1({ seq: 1 }) }]);
const stale = view.messages({ delayMs: 80 });
await view.importFragments([{ direction: 0, offset: 7, data: buildV1({ seq: 2 }) }]);
const r = await stale;          // { stale: true, dropped: {...} }
view.select({ direction: 1 });  // 切换方向同样使在途响应过期
```

## 测试对应关系

- `test/assembly.test.js`：乱序填洞、重复/冲突留痕、水位缺口、零拷贝范围、溯源
- `test/consumer.test.js`：跨片段帧头/长度/校验、一记录多消息、坏帧恢复、校验和、迟到补齐、SLIP 转义跨片段、UDP 边界、版本隔离
- `test/store.test.js`：修订号、快照并发隔离、乱序返回、错误字节溯源、分页、locate/boundaries、版本对比、双方向
- `test/http.test.js`：真实端口全链路、hex 导入、版本切换、客户端 stale 丢弃
- `test/concurrency.test.js`：随机切碎 + 乱序导入 + 延迟查询交错压力，校验快照自洽与最终线性重组一致
