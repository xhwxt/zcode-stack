# 直连 web 恢复三问题：标题偏移、滚动记忆持久化、软重连

## 背景
1. 真断线重连仍走整页 reload：白屏 + 重新下载/解析 7MB JS（实测 2.2s+）。
2. 刷新后对话滚动位置剧变：滚动记忆只存内存 Map，reload 后清零。
3. 手机端 header 标题与按钮整体右移、被裁切。

## 规则

### header 窗控空垫必须区分平台与视口
`WorkspaceHeader` 的 `pl-38/pl-44/pl-48/pl-58/pl-66` 系列左内边距只为
mac 红绿灯 / Windows/Linux 内联窗控预留，必须以 `isDesktop === true` 为前提。
web 手机抽屉视口（isDesktop=false 且窄屏）不存在窗控，但左上角有浮层按钮组
（侧栏开关 + 新建任务，右缘 ≈ 68px），header 内容必须以 pl-20（80px）起步
避免标题滑入浮层下方；web 宽屏视口不加任何窗控空垫。
手机抽屉视口下标题 h1 的 max-w 上限放宽到 42vw（22vw 上限会造成过度裁切），
仍保持 truncate 与 title 提示。

### 滚动记忆跨页面生命周期持久化
`chatSessionScrollMemory` 的存储在内存 Map 之外增加 sessionStorage 镜像：
- 写入：每次 `saveChatSessionScrollMemoryState` 同步镜像到
  sessionStorage（key 前缀 `zcode-scroll-memory:`，按会话 key 存储）。
- 读取：`readChatSessionScrollMemoryState` 先查内存 Map，未命中再查
  sessionStorage 并回填内存 Map。
- 容量：sessionStorage 镜像上限 40 条（LRU 修剪），避免低配手机的
  5MB 配额压力；超限静默丢弃最旧条目。
- `wasPinnedToBottom === true` 的条目照常存取（贴底恢复语义不变）。
- 所有存取必须 try/catch：隐私模式/配额满时静默降级为纯内存行为。

### 滚动恢复锚点与时机纪律
恢复锚点与落地时机（实测：落点在会话中部随机位置；滚动中被拽走）：
- 锚点用「距底部距离」而非绝对 scrollTop：`savedDistanceFromBottom =
  savedScrollHeight - savedClientHeight - savedScrollTop`，恢复目标 =
  当前 maxScrollTop − savedDistanceFromBottom。同内容会话切回时与绝对值
  精确等价；reload 后尾窗先就绪/会话底部有新增时仍能稳定落在原阅读点附近
  （绝对值会被夹紧到随机中间位置）。
- 恢复落地前必须检查真实用户滚动意图（`getActiveUserScrollIntent()`，
  wheel/touch/键盘 TTL 内或触摸/滚动条拖拽进行中）：意图活跃 → 立即作废
  恢复租约，绝不改写 scrollTop。250ms 布局保护窗内的用户滚动仍产生真实
  意图（wheel/touch 监听不受 guard 影响），不得被布局分类掩盖。
- 恢复租约最多「落地 + 一帧校正」：校正帧后即释放租约。测高漂移交给
  virtualizer 位移补偿（shouldAdjustScrollPositionOnItemSizeChange），
  历史前插交给 prepend 锚定，不再以 scrollHeight 追平作为释放条件
  （新增消息会虚增 scrollHeight，旧判定不可靠）。
- 用户真实滚动事件立即作废恢复租约（handleScroll 既有逻辑保留），
  后续 saveCurrentScrollMemory 保存用户实际位置，不落中间态污染。

### 软重连（无整页 reload 的恢复路径）
socket 意外关闭后不再无条件整页 reload，优先页面内软重连：
- `packages/web/src/main.tsx` 不再把 Root 挂载写死为一次性 render：
  保存最新 `services`（IServiceAccessor），socket 关闭后按
  1s→2s→4s→8s（封顶 8s）指数退避重试 `connectViaWebSocket`；
  成功后以递增 `connectionEpoch` 作为 React key 重挂 `<Root>`，
  强制整树重新初始化（所有 Zustand store/hook 状态回到服务端事实源）。
- 语义与 reload 等价：服务端是事实源 + web-remote-replayable 快照重放，
  软重连后 restoreSession 走同一 bootstrap 链路。
- 重连期间保留旧 React 树可见（顶部红色横幅提示，不复用旧 guard 的
  DOM overlay，改由 React 组件渲染），用户可继续阅读已渲染内容。
- 仍在可见状态且 close 为非正常关闭（wasClean=false 且 code∉{1000,1001}）
  → 走软重连。仅以下情形保留整页 reload 兜底：
  a) 软重连连续失败 ≥ 4 次（指数退避耗尽后）；
  b) 60 秒内软重连成功次数 ≥ 5 次（防重连风暴）。
- 锁屏（hidden）期间 socket 死亡：不做任何操作，回前台（visibilitychange
  → visible / online 事件）时触发软重连探测，不再探测后 reload。
- 桌面端正常关闭（登出等主动流程）不触发软重连。

### 回归红线
- 桌面 1280×800 渲染路径不得变化（header 空垫逻辑仅 web 手机命中路径变化）。
- 秒切回（socket 健在）不得触发任何重连（延续 8d4489c 修复）。

## 验收
- 390×844：header 标题完整可见不被裁切，起点在浮层按钮组（右缘 ≈68px）之后，
  宽度上限 46vw。
- 长会话上滚 → 刷新 → 恢复后落点距底距离与保存值一致（±视口高）；恢复落地后
  用户立即滚动，scrollTop 不得再被改写（租约已作废）。
- 杀 socket（服务端主动 close 非正常码）：页面不刷新，旧内容保持可见，
  横幅出现后消失，UI 恢复可交互。
- typecheck / lint / architecture:check 通过。
