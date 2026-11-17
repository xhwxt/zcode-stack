# SocketProtocol KeepAlive 探针/回显 —— 直连 web 半开判死

## 背景

直连页链路（浏览器 ↔ nginx ↔ server `/ws`）此前零存活探测：
`SocketProtocol.readMessages()` 只对 `Regular` 帧触发 `onMessage`，其余类型直接丢弃；
两端都没有应用层心跳。半开连接（对端已死、本地不报 close）因此永远不会被发现——
界面用已加载的数据继续渲染，任何新 RPC 都打到死 socket 上（「表面正常、实际已断」）。

半开是 per-connection 的：换一根连接的探测（HTTP fetch、另开 WS）测不出当前这根已死。
必须在应用正在用的那条连接上发帧并等回应。

## 规则

### 探针帧格式与回显语义（防回显风暴的关键）
- 探针：`KeepAlive` 帧，`ack=0`，空 body，由 `SocketProtocol.sendKeepAlive()` 发出。
- 回显：任何一端收到 `ack=0` 的 `KeepAlive`，立即在同一连接上回一帧
  `KeepAlive`，`ack=1`，空 body，并触发 `onKeepAlive` 事件。
- 收到 `ack=1` 的 `KeepAlive`（即回显帧）只触发 `onKeepAlive`，**不再回显**。
  两端共享同一份 `SocketProtocol` 代码时该规则保证恰好一问一答，不会互相无限回显。
- `KeepAlive` 帧携带非空 body 时，body 被读出并丢弃（不触发 `onMessage`）。
- 除 KeepAlive 处理外，帧解析行为不变；`Regular` 仍走 `onMessage`，
  其余类型仍丢弃。`PersistentProtocol` 自带 5s KeepAlive（发出端 ack=incomingAckId），
  它收到 KeepAlive 只更新活跃时间、不回显——与本机制配对时同样恰好一问一答，
  不产生风暴。

### 客户端心跳监视器（packages/client，浏览器直连路径）
- `connectViaWebSocket` 在 `SocketProtocol` 外包一层监视器：周期
  （默认 15s）调用 `sendKeepAlive()`，并把「最近一次收到任何协议帧或 KeepAlive
  回显」的时间戳作为活性依据。
- 超过 `timeoutMs`（默认 30s）没有任何帧到达 → 判定连接死亡 → 在**同一 socket 上**
  主动 `close()`，让应用层的 close 事件路径（既有软重连）接手。
- 探测必须在应用正在用的那条连接上收发；禁止用 HTTP 探测代替半开判死
  （HTTP 换了连接，测不出半开）。
- 关闭事件到达时停止心跳计时器；重连成功后新连接拥有自己的监视器。
- 活性查询以全局桥 `window.__zcodeWebConnProbe()` 暴露给页面守卫（与既有
  `window.__zcodeConnGuard` 桥同一模式），始终指向最近一次建立的连接。

### 服务端 WS 层 ping/pong 清理（packages/server 与 zcode-server-cli 的 /ws）
- 对 `/ws`（terminal-client）上的每个连接，服务端每 30s 发 RFC 6455 ping 帧；
  连续 2 个周期无 pong（65s 内）→ `terminate()`。
- 浏览器网络栈自动回 pong（不依赖页面 JS 计时器，后台冻结页也能回）；
  服务端 terminate 使浏览器侧收到 close 事件 → 走既有软重连。
- 该心跳同时覆盖远控页（relay 的 RPC 也是页面直连 server `/ws`），
  relay 自身的控制通道 WS 不受影响。

## 状态与事件顺序（所有权）

```text
客户端监视器（唯一所有者：connectViaWebSocket 内的监视器闭包）
  sendKeepAlive ──► server SocketProtocol 回显 ──► onKeepAlive → lastReceivedAt
  计时器发现超时 → ws.close() → close 事件 → handleWebTransportClosed → 软重连
服务端 ping 循环（每连接独立闭包）
  ws.ping → 浏览器栈 pong → 'pong' 事件 → alive=true
  计时器发现连续 miss → ws.terminate() → 浏览器 close 事件
```

回退语义不变：软重连退避耗尽/重连风暴才整页 reload（见 ui/specs/web-recovery.md 的退避与整页重载规则）。

## 回归红线

- `Regular` 帧、ACK、Disconnect 等 framing 行为不变；桌面 stdio/MessagePort/
  PersistentProtocol 路径不发探针也不应答探针（ack=0 回显仅由本机制触发），
  行为零变化。
- 健康连接不得误判：单个探针丢失（瞬态抖动）由下一个周期自愈，
  连续两个周期（30s）无任何帧才判死。
- 桌面端与远控页 bundle 不受本次改动影响（远控页 RPC 仍是同一 server /ws，
  仅额外获得服务端 ping 清理）。

## 验收

- 单测（packages/rpc/test/socket-keepalive.test.ts，node:test）：
  探针→回显恰好一问一答；ack=1 不再回显（无风暴）；Regular 消息不受影响。
- E2E：静默黑洞（拦下 /ws 双向不转发且
  不断开）→ 页面 ≤45s 内自动软重连（新 WS 连接），不整页 reload；
  健康页面 60s 内不产生重连、不误判。
- `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 通过。
