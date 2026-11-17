# 闲时任务终态通知 —— 桌面与 Web 双端启用

## 背景

闲时任务终态通知 hook（`packages/ui/src/hooks/useOffPeakTaskNotifications.ts`）
自实现起就被 `packages/ui/src/App.tsx` 用 `enabled: Boolean(notificationEnabled && isDesktop)`
限制在桌面端。当时 `isDesktop` 的唯一理由是**去重归属**：桌面 main 进程
`dispatchTaskNotification`（`packages/desktop/src/main/desktopNotifications.ts`）
按 `(status:taskId)` 做 3s 窗口去重，吸收多窗口/多标签对同一终态的重复派发。

该限制与 Web 端的实际能力不符：

- Web 平台层 `showTaskNotification`（`packages/web/src/main.tsx`）已实现：
  页面持有焦点时提前 return（前台不打扰）；无焦点且 `Notification.permission === "granted"`
  时发 `window.Notification`（silent）。
- 闲时任务服务在 Web 通道已可用：`RemoteServiceAccess.offPeakTaskService`
  经 RPC 代理（`packages/client/src/remoteServiceAccess.ts`），服务端常驻
  `OffPeakTaskService`（`packages/services/src/node.ts`）。
- hook 的轮询/边沿逻辑是平台无关的（30s 轮询 `list()`；仅 `completed|failed`
  状态边沿触发；首次见到即终态不补发；消失任务从 Map 清理）。

## 产品规则

- 通知启用条件：`notificationEnabled`（用户设置），**不再区分平台**。
  桌面与 Web 行为差异全部下沉到平台层 `showTaskNotification`：
  - 桌面：main 进程 3s `(status:taskId)` 去重 + 应用窗口有焦点即不弹（原语义不变）。
  - Web：`document.hasFocus()` 抑制前台打扰（原语义不变）；通知权限未授予则静默跳过。
- 通知文案仍由 renderer 侧 i18n 生成（`offPeak.notify.{completed,failed}.{title,body}`），
  平台层不兜底文案。

## 多标签页（Web）重复通知策略：接受各发一次（选项 a）

同一任务的同一终态，多个 Web 标签页会各发一次系统通知。

理由：

1. **手机/单标签场景零影响**——自托管手机 WebView 是单页应用，不存在多标签竞争。
2. **Web 没有 main 进程**——桌面去重依赖 Electron main 聚合所有 renderer；浏览器
   标签页之间没有共享的去重点（`localStorage`/`BroadcastChannel` 选主是跨标签
   同步问题，需要引入leader 选举与失效恢复，用超时或心跳掩盖竞态违背
   "不用超时掩盖同步问题"的纪律，收益却只覆盖"用户在两个标签同时挂闲时任务"
   这一罕见场景）。
3. **重复面有限**——通知由状态边沿触发（非轮询重发），一个标签只会在边沿那一刻
   发一次；即便双标签同开，最多两条同文通知，且浏览器通常将同源通知折叠。
4. 若未来实测多标签重复成为真实困扰，再评估 `BroadcastChannel` 选主，作为独立改动。

## 状态所有者

- 开关：`notificationEnabled`（Zustand 全局设置，双端同一事实源）。
- 已见状态表：hook 内 `seenStatusRef`（每渲染根一份；每个标签页/窗口各自持有，
  属于客户端本地观察状态，不是服务端事实）。
- 终态事实：服务端 `OffPeakTaskService.list()`，轮询读取。

## 验收场景

1. Web/手机（页面失焦或后台、通知权限已授予）：闲时任务运行中 → 终态
   completed → 系统通知「闲时任务已完成 / Idle-time task finished」，正文含任务标题。
2. 同上，终态 failed → 「闲时任务失败 / Idle-time task failed」。
3. 页面前台（hasFocus / 桌面应用窗口有焦点）：不弹系统通知。
4. 同一任务不因持续轮询重复通知（边沿触发）；首次打开页面即见终态的存量任务不补发。
5. 桌面行为不变：多窗口重复派发仍由 main 进程 3s 去重吸收。
6. 用户设置关闭通知时：双端都不发。
