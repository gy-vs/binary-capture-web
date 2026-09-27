# 二进制协议抓包重组工作台

面向协议开发与现场支持的抓包重组内核。输入是来自不同方向、可能**重复 / 缺失 / 乱序**的
TCP 或 UDP 片段（一个片段也可能含多条消息），输出不是“拼起来的一个文本框”，而是：

- 每个方向的**重组进度**（连续前缀 frontier、覆盖字节、无法继续的缺口 gaps）；
- 已经**确认的消息边界**与结构化字段（字段范围可回溯到具体输入片段）；
- **解析失败的原始字节**（坏校验 / 非法长度 / 非法转义 / 孤儿数据），坏帧不吞后续消息；
- 任意字节范围的**局部重组**（含缺口、分段 hex、来源片段映射）。

仅依赖 Node.js 20 标准能力（`node:http`、`node:test`、全局 `fetch`、`node:crypto`）。

## 运行

```bash
npm test          # 测试：协议/覆盖/分帧/TCP/UDP/HTTP/局部重组
npm start         # PORT=8080 启动 HTTP 服务
```

进程内直接使用：

```js
import { Workbench } from './src/index.js';
import { buildFrame } from './src/protocol.js';

const wb = new Workbench();
const session = wb.createSession({ transport: 'tcp', initialSeq: { c2s: 1000 } });
const view = wb.createView(session.id, { protocolVersion: 'v1', overlapPolicy: 'first' });

// 乱序：先补后段，再补前段
const stream = Buffer.concat([buildFrame({ cmd: 0x01 }, 'v1'), buildFrame({ cmd: 0x01 }, 'v1')]);
await wb.importSegments(session.id, [{ direction: 'c2s', seq: 1005, data: stream.subarray(5) }]);
wb.progress(view.viewId, 'c2s'); // frontier=0, gaps=[...]
await wb.importSegments(session.id, [{ direction: 'c2s', seq: 1000, data: stream.subarray(0, 5) }]);
wb.messages(view.viewId, 'c2s', {}); // 2 条已确认消息，带 raw 边界与字段来源
```

## 架构与数据流

```
原始片段(只存一份)          追加修订日志            独立版本的重组假设
┌──────────────┐  导入   ┌──────────────┐  重放   ┌──────────────────────┐
│ Session      │ ──────> │ journal(rev) │ ──────> │ View v1 / first      │
│  segments[]  │         └──────────────┘  ┌────> │  Coverage + 解析产物  │
│  (Buffer引用)│ ──────────────────────────┤      ├──────────────────────┤
└──────────────┘                           ├────> │ View v2 / last       │
                                           │      │  独立 Coverage+产物   │
                                           └────> └──────────────────────┘
```

- `src/protocol.js` — 虚构二进制协议：`SOF(0xA5) | LEN | CMD | FLAGS | PAYLOAD | CHECK`。
  帧体 DLE 风格转义（`A5→1D 01`、`1D→1D 02`）；**v1 = sum8，v2 = CRC-8(poly 07, init 37)**，
  同一条字节流在两个版本下结论不同，用于版本隔离对照。
- `src/framer.js` — **唯一的消费语义**。长度合法性、转义、校验和、跨片段字段都在这里的
  逻辑读取器中解释。读取基于覆盖模型而不是拼接 Buffer，缺一个字节就停在 SOF 等待；
  校验坏帧从帧尾之后继续，非法长度/转义回退到 `SOF+1` 重新狩猎。
- `src/coverage.js` — 字节覆盖区间集合：二分定位、乱序合并、重复识别、
  `first` / `last` 两种重叠冲突假设、`locateSpan` 字节→来源片段映射。
- `src/session.js` — 原始片段唯一存放处 + 只追加 journal（视图按修订重放）。
- `src/view.js` — 每个假设独立版本号、独立解析状态。迟到片段：
  - `first`：连续前缀不变，只在旧 frontier 之后**续解析**；
  - `last`：找到受影响区域之前**最后一个完整帧边界**，仅作废其后的产物再重算。
- `src/workbench.js` — 无 I/O 门面；导入经 Promise 链串行化，查询只读，响应带修订号。
- `src/server.js` / `src/client.js` — HTTP REST 外壳与保持当前选择的客户端。

## HTTP 接口（节选）

| 方法 & 路径 | 说明 |
| --- | --- |
| `POST /sessions` | 建会话 `{transport:'tcp'\|'udp', initialSeq}` |
| `POST /sessions/:id/segments` | 批量导入片段（TCP 给 `seq`，UDP 给 `index`，字节用 hex） |
| `GET  /sessions/:id/segments` | 片段元数据列表（不含大字节） |
| `GET  /sessions/:id/segments/:segId/bytes?start&end` | 原始片段字节范围 |
| `POST /sessions/:id/views` | 建独立版本假设 `{protocolVersion, overlapPolicy}` |
| `GET  /views/:v/:dir/progress` | frontier / gaps / 消息数 / 错误数 / pending |
| `GET  /views/:v/:dir/messages` | 已确认消息边界 + 结构化字段（分页 `offset/limit`） |
| `GET  /views/:v/:dir/messages/:id/bytes` | 某消息负载与整帧字节（按需，不进列表） |
| `GET  /views/:v/:dir/errors` | 解析失败列表（含 raw 范围与字段来源） |
| `GET  /views/:v/:dir/errors/:idx/bytes` | 错误位置原始字节 |
| `GET  /views/:v/:dir/boundary?ordinal=&atOffset=` | 跳到消费边界 |
| `GET  /views/:v/:dir/locate?offset=` | TCP 字节定位回输入片段 |
| `GET  /views/:v/:dir/bytes/range?start&end` | 局部重组（缺口、分段 hex、provenance） |
| `GET  /views/:v/:dir/datagrams/:i/...` | UDP：定位 / 字节范围（数据报独立成帧） |

大字节不进列表响应：消息只返回字段范围，需要时通过 `.../bytes` 按范围取 hex；
所有范围都带 `segments:[{segId,start,end}]`，可从最终结果回溯到原始片段。

## 并发与版本一致性

- **写串行**：`Workbench.importSegments` 用 Promise 链串行提交，乱序并发补片不会交错写状态；
  查询只读，任何中间快照下 `messagesConfirmed === 消息列表长度`、消息不越过 frontier。
- **独立版本**：视图之间不共享解析结果；切视图只改变查询绑定的 viewId，
  `WorkbenchClient` 用世代号（generation）标记在途查询，切换后旧响应抛 `StaleResponseError`。
- **过期响应**：导入抬升客户端修订水位；响应 `view.caughtUpRev` 低于水位时
  （查询比补片晚返回），客户端判定过期，不把旧结果混入当前选择。HTTP 查询支持
  `_delay=毫秒`（延迟发生在快照取出之后、响应发出之前），用于复现现场网络乱序。

## 测试对应关系

- `test/protocol.test.js` — 转义、v1/v2 校验和差异；
- `test/coverage.test.js` — 乱序、重复、first/last 冲突、来源映射、缺口拒绝拼接；
- `test/framer.test.js` — 跨片段字段（逐切点）、pending 续帧、坏帧不吞后续、非法长度/转义、孤儿数据；
- `test/tcp.integration.test.js` — 乱序补片、重复幂等、一帧多消息、版本隔离、假设比较、并发；
- `test/udp.integration.test.js` — 数据报独立成帧、多消息、缺失/迟到、重复与冲突；
- `test/local-reassembly.test.js` — 单帧中间缺口迟到补齐、字段跨片段溯源、局部重算边界；
- `test/http.integration.test.js` — 端到端接口、切换世代丢弃、晚返回过期判定。
