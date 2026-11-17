/**
 * APK 壳消息通道（ThemeChannel）页面侧发送端。
 *
 * 壳在 WebView 里注入 `window.zcodeShell`（ThemeChannel.kt JS_OBJECT_NAME），
 * 页面经 `zcodeShell.postMessage(text)` 发送前缀字符串消息（ShellMessagePolicy.kt 解析）：
 * - "notify-clear"    → 壳取消"需要你的处理"常驻通知（pending interaction 已被回答）
 * - "tasks-consumed"  → 壳把常驻通知的"已完成 M"计数清零（用户回到 App 看过结果）
 * - "task-started"    → 壳把常驻通知"运行中 N"计数 +1（会话进入运行态）
 * - "task-finished"   → 壳把"运行中 N"计数 -1、"已完成 M"未读 +1 并刷新速览（会话到达终态）
 *
 * 浏览器直连页没有壳（window.zcodeShell 不存在），所有发送静默跳过；
 * 桌面 Electron 也没有该 bridge，同样跳过——本模块只对 APK 壳生效。
 */

type ShellPostMessage = (message: string) => void;

function readShellPoster(): ShellPostMessage | null {
  // 壳注入的 bridge 形态：window.zcodeShell.postMessage（ThemeChannel.kt PAGE_SIDE_JS 同款调用）。
  // 用 optional chaining 逐级判空：bridge 未注入 / 注入时机未到 / 非 APK 环境全部静默跳过。
  const shell = (globalThis as { zcodeShell?: { postMessage?: unknown } }).zcodeShell;
  if (typeof shell?.postMessage === "function") {
    const post = shell.postMessage as (message: string) => void;
    return (message) => {
      try {
        post(message);
      } catch {
        // 壳侧 receiver 异常不能打断页面主流程（ShellMessagePolicy 对未知消息本就 Ignore）。
      }
    };
  }
  return null;
}

/** 通知壳取消 pending-interaction 通知（ShellMessagePolicy.NotifyClear）。 */
export function notifyShellInteractionCleared(): void {
  readShellPoster()?.("notify-clear");
}

/** 通知壳把"已完成 M"未读计数清零（ShellMessagePolicy.TasksConsumed）。 */
export function notifyShellTasksConsumed(): void {
  readShellPoster()?.("tasks-consumed");
}

/** 通知壳"运行中 N"+1（ShellMessagePolicy.TaskStarted；无参，会话进入运行态）。 */
export function notifyShellTaskStarted(): void {
  readShellPoster()?.("task-started");
}

/** 通知壳"运行中 N"-1、"已完成 M"未读+1 并刷新速览（ShellMessagePolicy.TaskFinished；无参，会话到达终态）。 */
export function notifyShellTaskFinished(): void {
  readShellPoster()?.("task-finished");
}
