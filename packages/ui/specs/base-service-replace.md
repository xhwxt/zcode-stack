# base service 换代的原地恢复（web 直连页软重连不重挂）

## 背景

web 直连页（packages/web）软重连此前以 `connectionEpoch` 为 React key 整树卸载重挂
`<Root>`，视觉等价整页刷新。而服务端/协议层本已具备无损恢复的全部要素：

- V4 订阅协议支持 resume（客户端携 base {logEpoch, seq}，服务端裁决续增量或重快照）；
- 投影 store（conversationProjectionStore）的 `handleRuntimeRestart("transportReplaced")`
  正是「transport 换代、保留水位 fresh subscribe」的原地恢复路径；
- `ReplaceableConversationTransport` 已在远程 workspace 线承担「service proxy 换代期间
  transport 身份稳定」的职责，但 registry 只为 remote endpoint 创建它。

硬性要求：切后台→回前台**绝不能看到刷新**。误杀已由心跳 hidden 豁免清零；
真断线（后台 socket 被系统回收）后原地恢复成为最后一段体感差距。

## 规则

### registry：base（__base__）换代改走 replace，不再删旧建新
`workspaceConnectionRegistry.acquireWorkspaceConnection`：
- 无论 endpoint 是否 remote，entry 一律持有 `ReplaceableConversationTransport`；
- 命中 existing 且 `agentService` 对象不同（base 换代）时：更新 entry 的
  agentService/agentServiceGeneration，`replaceableTransport.replace(新 transport)`，
  refCount++——**不 delete、不 stale**。旧 transport 的订阅退订与延迟清理由
  ReplaceableConversationTransport.replace 内部协议负责（best-effort unsubscribe +
  `transportReplaced` 通知）；
- 「本地 __base__ service 换代 = 旧条目失效」的旧语义废止：store/layer 身份保持，
  conversation 投影与 sessions-index store 跨换代存续。

### sessionsIndexRegistry：local 换代同样 replaceTransport
`acquireSessionsIndex` 的 replaceTransport 分支去掉 remote-only 限制：existing 命中且
generation 更新时，一律 `store.replaceTransport(新 transport)`；旧分支的 delete+close
仅保留给「existing 存在但 endpoint/语义不匹配」的兜底。

### web bootstrap：软重连成功后更新 services，不再重挂 Root
`packages/web/src/main.tsx`：
- `services` 由模块变量改为 React state（`useState<IServiceAccessor | null>`）；
- 软重连成功：新 accessor `setWebServices(next)` → `ServiceProvider` value 更新 →
  React 重渲消费者（不卸载子树），hooks 依 deps 自然重订；
- `connectionEpoch` 重挂机制删除；横幅/退避/风暴保护语义不变；
- bootstrap 首连与软重连共用同一 render 路径（首次 setState 由 null → accessor）。

### useTabPersistence：恢复是一次性启动语义
restore effect 以「本 hook 实例从未完成过恢复」为唯一执行条件（ref 守卫）；
settingService/accessor 换代不重跑 restoreTabs（restoreTabs 会重建 tab id，二次执行
会让已挂载会话视图闪断）。persist 路径正常跟随最新 settingService。

### 幂等边界（换代重跑审计结论）
- broadcast/bots effect：subscribe+cleanup 模式，deps 变化自动重订 ✓
- Root 的 `registerBaseWorkspaceServices` effect：重复注册是幂等 set ✓
- useModelSelectionServiceView 等 useSyncExternalStore 消费者：重订 ✓
- 会话输入草稿、滚动记忆：属 UI-local/sessionStorage，不依赖 service 对象身份 ✓

## 验收

- E2E：hidden 期间服务端杀掉 socket（真断线）→ 回前台守卫探测判死 → 软重连 →
  **Root 未卸载**（以 `document` 内 React root 标记/全局计数证伪整树重挂）、
  会话视图仍在原 tab、横幅按惰性语义出现/不出现；
- 健康切回零扰动（沿既有实现）；黑洞半开判死路径不受影响；
- 桌面端不受影响：registry 对 desktop 场景的语义不变（base 只注册一次，不换代）。
- typecheck / lint / 单测通过。
