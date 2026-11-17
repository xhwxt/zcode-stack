/**
 * 连接热换底的重订广播出口——web 入口（main.tsx）在软重连成功后调用，
 * 驱动 conversation / sessions-index store 携当前水位重订。
 * 从本模块导出以避免 web 直接依赖 registry 内部路径。
 */
import { bumpAgentV4HandshakeEpoch } from "@/v4/agentV4ConnectionHandshake.js";

import { notifySessionsIndexSwapped } from "@/v4/sessionsIndexRegistry.js";
import { notifyWorkspaceConnectionsSwapped } from "@/v4/workspaceConnectionRegistry.js";

/** 热换底后调用：作废旧握手缓存并广播重订。web main.tsx 的唯一入口。 */
export function notifyConnectionSwappedAfterHotSwap(): void {
  bumpAgentV4HandshakeEpoch();
  markWebTransportConnected();
  notifyWorkspaceConnectionsSwapped();
  notifySessionsIndexSwapped();
}

// ── 断连时钟（横幅静默的判据源）─────────────────────────────────
// 架构事实（实测+代码链证实）：WS close 事件不经过 v4 projection
// store——store 在断连期间停在 stale `live`（"断着但不知道"），其 connecting
// 只覆盖 main.tsx 软重连成功（hot-swap resetTransport）后的快恢复段（实测
// 1.2-1.7s）。因此"connecting 持续 ≥5s"在任何断连时长下都够不到，横幅判据
// 必须用"断连总时长"。真正的 close 事实只在 web 入口（main.tsx 的
// onClose/onHeartbeatDead 回调）可观测，这里提供最小只读面：
//   main.tsx 在 close/心跳判死时调 markWebTransportDisconnected()，
//   hot-swap 成功（notifyConnectionSwappedAfterHotSwap）时调 markWebTransportConnected()。
// 桌面端（Electron MessagePort 链路）没有这套回调——readWebTransportDisconnectedMs()
// 恒返回 0，横幅自动退回旧行为（只看队列），不受影响。无轮询定时器：唯一的通知点
// 是断连开始/结束的两个边沿（订阅点），pane 收到"断连开始"后才挂一次性计时器，
// 在 5s 阈值点触发一次渲染；"恢复"边沿负责立即熄灭。
let webTransportDisconnectedAt: number | null = null;

const DISCONNECT_LIFECYCLE_EVENT = "zcode:web-transport-disconnect-lifecycle";

/** socket 死亡（close/心跳判死）时由 web 入口调用；重复调用不覆盖首次时刻。 */
export function markWebTransportDisconnected(): void {
  if (webTransportDisconnectedAt !== null) return;
  webTransportDisconnectedAt = Date.now();
  if (typeof document !== "undefined") {
    document.dispatchEvent(new Event(DISCONNECT_LIFECYCLE_EVENT));
  }
}

/** 连接恢复（hot-swap 换底成功）时由 web 入口调用；清除断连时刻。 */
export function markWebTransportConnected(): void {
  if (webTransportDisconnectedAt === null) return;
  webTransportDisconnectedAt = null;
  if (typeof document !== "undefined") {
    document.dispatchEvent(new Event(DISCONNECT_LIFECYCLE_EVENT));
  }
}

/** 当前断连持续毫秒数；0 = 连接健康（或桌面端无此信号）。 */
export function readWebTransportDisconnectedMs(): number {
  if (webTransportDisconnectedAt === null) return 0;
  return Date.now() - webTransportDisconnectedAt;
}

/**
 * 断连生命周期订阅点（开始/恢复两个边沿各派发一次）。返回退订函数。
 * pane 层用它在"断连开始"边沿挂一次性阈值计时器、在"恢复"边沿清理。
 */
export function subscribeWebTransportDisconnectLifecycle(
  listener: () => void,
): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener(DISCONNECT_LIFECYCLE_EVENT, listener);
  return () => {
    document.removeEventListener(DISCONNECT_LIFECYCLE_EVENT, listener);
  };
}

// ── useSyncExternalStore 适配（横幅的最终消费形态）────────────────
// React 19 对 native dispatchEvent→setState 的批处理存在时序竞态（实测：
// 横幅判据三种实现形态两种全灭），useSyncExternalStore 专为"外部可变源
// + 原生事件"设计，天然消除这类竞态。契约：
//   - getSnapshot 返回**量化稳定值**（0=连接健康；断连中按整秒推进）——同一
//     断连窗口内多次调用值不变，避免无限重渲染；原样暴露 Date.now() 差值会
//     每毫秒变化，绝不能直接做 getSnapshot。
//   - 通知只在量化值跨档时发出（断连中每秒一档 + 恢复归零），订阅期外不触发。
//   - 最后一个订阅者退订时拆除 document 监听与采样器（无订阅零开销）。
//   - 桌面端无 close 信号：恒 0，消费方退回旧行为。

const msListeners = new Set<() => void>();
let msLifecycleUnsub: (() => void) | null = null;
let msSampler: ReturnType<typeof setInterval> | null = null;
let msLastNotifiedQuantum = 0;

/** 量化快照：0=健康；断连中 = 截断到整秒的已持续毫秒数。 */
export function getWebTransportDisconnectedMsSnapshot(): number {
  if (webTransportDisconnectedAt === null) return 0;
  return Math.floor((Date.now() - webTransportDisconnectedAt) / 1_000) * 1_000;
}

function notifyMsListeners(): void {
  const quantum = getWebTransportDisconnectedMsSnapshot();
  if (quantum === msLastNotifiedQuantum) return;
  msLastNotifiedQuantum = quantum;
  for (const listener of msListeners) listener();
}

function armMsSampler(): void {
  if (msSampler !== null || webTransportDisconnectedAt === null) return;
  msSampler = setInterval(notifyMsListeners, 1_000);
}

function disarmMsSampler(): void {
  if (msSampler === null) return;
  clearInterval(msSampler);
  msSampler = null;
}

function onMsEdge(): void {
  if (webTransportDisconnectedAt !== null) {
    armMsSampler();
  } else {
    disarmMsSampler();
  }
  notifyMsListeners();
}

/**
 * 断连时钟的 useSyncExternalStore 订阅点。回调幂等（只触发 React 重读
 * snapshot）；量化值未跨档时不通知；最后一个订阅者退订后完全拆除。
 */
export function subscribeWebTransportDisconnectedMs(
  listener: () => void,
): () => void {
  if (typeof document === "undefined") return () => {};
  msListeners.add(listener);
  if (msListeners.size === 1) {
    msLastNotifiedQuantum = getWebTransportDisconnectedMsSnapshot();
    msLifecycleUnsub = subscribeWebTransportDisconnectLifecycle(onMsEdge);
    armMsSampler();
  }
  return () => {
    msListeners.delete(listener);
    if (msListeners.size === 0) {
      msLifecycleUnsub?.();
      msLifecycleUnsub = null;
      disarmMsSampler();
      msLastNotifiedQuantum = 0;
    }
  };
}
