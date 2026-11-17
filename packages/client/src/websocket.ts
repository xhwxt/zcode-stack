import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
  /**
   * 连接建立、SocketProtocol 就绪后回调（宿主可据此挂探针桥、帧缓冲等）。
   * 热换底场景宿主必须缓冲 onOpenProtocol 之后到达的帧——server 的 Initialize
   * 在 WS open 时已发出，而 ChannelClient 绑定发生在其后的 resetTransport。
   */
  onOpenProtocol?: (protocol: SocketProtocol) => void;
  /** 心跳监视器就绪后回调（宿主保存把手用于同 socket 活性查询/补探）。 */
  onHeartbeat?: (handle: WebSocketHeartbeatHandle) => void;
  /** 心跳判死回调：在 close 事件之前触发，宿主应按断连处理（启动软重连）。 */
  onHeartbeatDead?: () => void;
}

/**
 * 心跳监视器参数：intervalMs 发探针的周期；timeoutMs 无任何帧到达的判死阈值。
 * timeout 必须 ≥ 2×interval：允许单个探针/回显因瞬态抖动丢失后由下一周期自愈，
 * 健康连接不会被误判（见 packages/rpc/specs/socket-keepalive.md 回归红线）。
 */
export interface WebSocketHeartbeatOptions {
  intervalMs: number;
  timeoutMs: number;
  /**
   * 页面可见性查询（可选）。提供后，hidden 期间监视器不杀连接——手机切后台
   * JS 计时器冻结、帧消费停止，回前台时 lastReceivedAt 必然超阈值，若直接判死
   * 会误杀一条可能还活着的连接（表现为每次切回都闪一次重连）。回前台后的
   * 裁决链：守卫 probeConnectionAliveOnSameSocket（新鲜判定+补探）先行，监视器
   * visible 态判死还有二次探针兜底（见 startWebSocketHeartbeatMonitor）。
   */
  isPageVisible?: () => boolean;
}

export const WEB_SOCKET_HEARTBEAT_DEFAULTS: WebSocketHeartbeatOptions = {
  intervalMs: 15_000,
  timeoutMs: 30_000,
};

/**
 * 浏览器宿主默认的可见性感知心跳参数：hidden 态不杀连接（切后台回前台不误杀），
 * 其余同 WEB_SOCKET_HEARTBEAT_DEFAULTS。isPageVisible 由调用方注入——本包不得
 * 引用 document（desktop host 的无 DOM 编译会经 @zcode/server/remote →
 * @zcode/client 把本文件源码拖进 lib:es2025 工程，DOM 全局在此不可用）。
 *
 * @param isPageVisible 宿主注入的可见性查询，如 () => document.visibilityState === "visible"
 */
export function withPageVisibility(
  isPageVisible: () => boolean,
  options?: WebSocketHeartbeatOptions | null,
): WebSocketHeartbeatOptions | null {
  if (options === null) return null;
  return {
    ...(options ?? WEB_SOCKET_HEARTBEAT_DEFAULTS),
    isPageVisible,
  };
}

function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (e) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer)));
  });
  ws.addEventListener("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.addEventListener("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

// ── 心跳监视器（同 socket 半开判死）──────────────────────────────────────────
// 修复依据：半开是 per-connection 的，
// 换一根连接的 HTTP 探测测不出当前这根已死；必须在应用正在用的 socket 上发帧并等回应。
// 所有权：每条连接的监视器闭包是 lastReceivedAt 的唯一所有者；探针经 SocketProtocol
// sendKeepAlive()（ack=0）发出，对端自动回显（ack=1）或触发 onKeepAlive/任何帧更新活性。
// 事件顺序：interval 到点 → sendKeepAlive → 对端回显 → onKeepAlive → lastReceivedAt 刷新；
// 检查计时器发现超时 → 主动 close() → 浏览器 close 事件 → 既有的守卫/软重连路径接手。
// 活性经 onHeartbeat 把手暴露给宿主（packages/web 的页面守卫挂在 window 桥上；
// 本文件不引用 window/Window——desktop host 的无 DOM 编译会经 @zcode/server/remote
// → @zcode/client 把本文件源码拖进 lib:es2025 工程，DOM 全局在此不可用）。

/** 心跳监视器把手：宿主经此查询同 socket 活性 / 补发探针。 */
export interface WebSocketHeartbeatHandle {
  /** 最近一次收到任何协议帧（含 KeepAlive 回显）的时间戳。 */
  lastReceivedAt: () => number;
  /** 立即在当前连接上补发一根 KeepAlive 探针。 */
  sendKeepAlive: () => void;
}

interface WebSocketHeartbeatMonitor extends WebSocketHeartbeatHandle {
  dispose: () => void;
}

function startWebSocketHeartbeatMonitor(
  protocol: SocketProtocol,
  ws: WebSocket,
  options: WebSocketHeartbeatOptions,
  onDead?: () => void,
): WebSocketHeartbeatMonitor {
  let lastReceivedAt = Date.now();
  const markAlive = () => {
    lastReceivedAt = Date.now();
  };
  // 任何到达的帧都证明这条 socket 的接收方向是活的（数据帧或 KeepAlive 回显均可）。
  const keepAliveSubscription = protocol.onKeepAlive(markAlive);
  const messageSubscription = protocol.onMessage(markAlive);

  const keepAliveTimer: ReturnType<typeof setInterval> = setInterval(() => {
    protocol.sendKeepAlive();
  }, options.intervalMs);

  // ── 判死流程（visible 态）：超时 → 二次探针 → 仍无回显才杀 ────────────────
  // 二次探针是防误杀的关键：切后台回来的连接 lastReceivedAt 必然超阈值（后台冻结
  // 期间帧停走），但连接往往还活着。先补一根探针等回显，有回应即 stand down。
  let probing = false;
  const checkTimer: ReturnType<typeof setInterval> = setInterval(() => {
    if (Date.now() - lastReceivedAt <= options.timeoutMs) {
      return;
    }
    if (options.isPageVisible && !options.isPageVisible()) {
      // hidden（手机切后台/锁屏）：计时器在真机上本已冻结，此分支覆盖「计时器
      // 未冻结但页面不可见」的实现差异。hidden 态绝不杀连接——回前台后
      // visibilitychange → 守卫 probeConnectionAliveOnSameSocket 先行裁决
      // （新鲜判定 + 补探），本计时器随后再跑时连接若已被证明健康，
      // lastReceivedAt 已刷新，不会进入判死分支。
      return;
    }
    if (probing) {
      return;
    }
    // 二次探针：发一根 KeepAlive，等 2.5s。有回显 → markAlive 刷新 → 下一跳自愈。
    probing = true;
    try {
      protocol.sendKeepAlive();
    } catch {
      // socket 已死（send 抛错）：直接判死。
      probing = false;
      onDead?.();
      try {
        ws.close();
      } catch {}
      return;
    }
    setTimeout(() => {
      probing = false;
      if (Date.now() - lastReceivedAt > options.timeoutMs) {
        // 2.5s 内仍无任何帧（含探针回显）：确认真死。先通知宿主（等同非正常
        // 关闭语义——监视器自己的 close() 是干净关闭，若直接依赖 close 事件会
        // 被宿主当作主动登出而不重连），再关闭本连接。重连所有权在宿主。
        onDead?.();
        try {
          ws.close();
        } catch {
          // 已处于 CLOSING/CLOSED 时 close() 不应抛错；兜底忽略。
        }
      }
    }, 2_500);
  }, Math.min(options.intervalMs, options.timeoutMs));

  return {
    lastReceivedAt: () => lastReceivedAt,
    sendKeepAlive: () => protocol.sendKeepAlive(),
    dispose: () => {
      clearInterval(keepAliveTimer);
      clearInterval(checkTimer);
      keepAliveSubscription.dispose();
      messageSubscription.dispose();
    },
  };
}

export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions & { heartbeat?: WebSocketHeartbeatOptions | null },
): Promise<IServiceAccessor> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let monitor: WebSocketHeartbeatMonitor | null = null;

    const teardownMonitor = () => {
      monitor?.dispose();
      monitor = null;
    };

    ws.addEventListener("error", () => {
      if (!settled) {
        reject(new Error(`WebSocket connection failed: ${wsUrl}`));
      }
    });
    ws.addEventListener("close", (event) => {
      teardownMonitor();
      options?.onClose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      if (!settled) {
        reject(
          new Error(
            event.reason
              ? `WebSocket closed before ready: ${event.reason}`
              : `WebSocket closed before ready (${event.code})`,
          ),
        );
      }
    });

    ws.addEventListener("open", () => {
      settled = true;
      options?.onOpenSocket?.(ws);
      const socket = wrapBrowserWebSocket(ws);
      const protocol = new SocketProtocol(socket);
      // 心跳默认开启：浏览器直连链路此前零存活探测（半开永不判死）。
      // 显式传 heartbeat: null 可关闭（现有调用方均不传，桌面 MessagePort 路径不受影响）。
      if (options?.heartbeat !== null) {
        monitor = startWebSocketHeartbeatMonitor(
          protocol,
          ws,
          options?.heartbeat ?? WEB_SOCKET_HEARTBEAT_DEFAULTS,
          options?.onHeartbeatDead,
        );
        options?.onHeartbeat?.(monitor);
      }
      options?.onOpenProtocol?.(protocol);
      resolve(connectViaProtocol(protocol));
    });
  });
}

export function connectViaProtocol(protocol: IMessagePassingProtocol): IServiceAccessor {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client);
}

/**
 * 可热换底的服务连接：对外暴露的 IServiceAccessor **对象身份恒定**，
 * 断线重连成功后经 `reconnect()` 把新 socket 换进同一 ChannelClient——
 * 上层（React context）感知不到任何对象变化，消费树零重渲。
 *
 * 修复依据：软重连若更换 accessor 对象，React context value
 * 变化导致整棵消费树重渲（视觉上等同界面闪一下重建）。本类把重连收敛为
 * 传输层热替换：ChannelClient.resetTransport fail-closed 挂起请求并重置握手，
 * 事件订阅由上层监听 onReconnected 后重挂。
 */
export interface HotSwapConnection {
  services: IServiceAccessor;
  /**
   * 断线重连成功后调用：把新连接换进既有 ChannelClient（对象身份不变）。
   * bufferedFrames：新 SocketProtocol 在绑定 ChannelClient 前已解析的帧
   * （含 server 的 Initialize）——必须重放，否则握手永远无法完成。
   */
  reconnect: (protocol: IMessagePassingProtocol, bufferedFrames: unknown[]) => void;
}

export function connectViaHotSwapProtocol(
  protocol: IMessagePassingProtocol,
): HotSwapConnection {
  const client = new ChannelClient(protocol);
  return {
    services: new RemoteServiceAccess(client),
    reconnect: (next, bufferedFrames) =>
      client.resetTransport(next, bufferedFrames as VSBuffer[]),
  };
}
