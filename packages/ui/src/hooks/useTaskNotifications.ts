/* eslint-disable max-lines -- 单工作区/全工作区/挂起交互/壳计数四组通知钩子共置一处，拆文件反而割裂同一协议的记账语义。 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { IPlatformService, TaskNotificationPayload } from "@zcode/shared";
import type {
  ConversationSnapshot,
  SessionPhase,
  SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import type { IntlInstance } from "@/i18n/index.js";
import { logger } from "@/logger.js";
import {
  collectPendingInteractionNotificationPayloads,
  collectTerminalTaskNotificationPayloads,
} from "@/lib/taskNotificationOrchestrator.js";
// APK 壳通知联动（ThemeChannel）：通知发出后用户在页面里回答了交互/看完结果，
// 壳侧常驻通知必须撤掉，否则通知栏残留过期状态。
// task-started / task-finished 是壳侧常驻通知"运行中 N / 已完成 M"真实计数的信号源。
import {
  notifyShellInteractionCleared,
  notifyShellTaskFinished,
  notifyShellTaskStarted,
  notifyShellTasksConsumed,
} from "@/lib/shellMessageSender.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStoreStatus } from "@/v4/sessionsIndexStore.js";
import type { IZCodeAgentService } from "@zcode/services";

type FormatMessage = IntlInstance["formatMessage"];
type TaskNotificationPlatform = Pick<IPlatformService, "showTaskNotification">;

interface WorkspaceTerminalTaskNotificationsParams {
  workspacePath: string;
  workspaceIdentity?: string;
  endpointKey?: string | null;
  enabled: boolean;
  rpcReady: boolean;
  platform: TaskNotificationPlatform | null | undefined;
  formatMessage: FormatMessage;
}

/** 全 workspace 终态通知的 tab 描述（App 层从 tabStore 投影）。 */
export interface AllWorkspacesTerminalTaskNotificationTab {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface PendingInteractionTaskNotificationsParams {
  snapshot: ConversationSnapshot | null;
  enabled: boolean;
  platform: TaskNotificationPlatform | null | undefined;
  formatMessage: FormatMessage;
}

interface SessionsIndexNotificationState {
  signature: string;
  sessions: readonly SessionSummary[];
  status: SessionsIndexStoreStatus;
}

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildWorkspaceNotificationSignature(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  endpointKey?: string;
}): string {
  return [
    params.endpointKey ?? "__base__",
    params.workspaceIdentity ?? "",
    params.workspacePath,
  ].join("\0");
}

function toSessionMap(sessions: readonly SessionSummary[]): Map<string, SessionSummary> {
  return new Map(sessions.map((session) => [session.sessionId, session]));
}

function showTaskNotification(
  platform: TaskNotificationPlatform,
  payload: TaskNotificationPayload,
): void {
  try {
    platform.showTaskNotification(payload);
  } catch (error) {
    logger.warn("[task-notification] 触发平台通知失败", {
      taskId: payload.taskId,
      status: payload.status,
      error,
    });
  }
}

/**
 * v4 任务终态通知编排。
 *
 * v4 重构删掉旧 renderer background monitor 后，platform 通知通道仍在，
 * 但 sessions-index 事实没有再被翻译成展示命令，导致任务完成/失败没有系统通知。
 * 这里只在 renderer 做“已观察边沿”的通知意图，事实仍以 sessions-index 为准；
 * 是否因窗口活跃而抑制通知继续交给 desktop/web platform 层判断。
 */
export function useWorkspaceTerminalTaskNotifications({
  workspacePath,
  workspaceIdentity: rawWorkspaceIdentity,
  endpointKey: rawEndpointKey,
  enabled,
  rpcReady,
  platform,
  formatMessage,
}: WorkspaceTerminalTaskNotificationsParams): void {
  const { zcodeAgentService } = useServices();
  const workspaceIdentity = trimOptional(rawWorkspaceIdentity);
  const endpointKey = trimOptional(rawEndpointKey);
  const workspaceKey = workspaceIdentity ?? workspacePath;
  const signature = useMemo(
    () =>
      buildWorkspaceNotificationSignature({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(endpointKey ? { endpointKey } : {}),
      }),
    [endpointKey, workspaceIdentity, workspacePath],
  );
  const [indexState, setIndexState] = useState<SessionsIndexNotificationState>({
    signature,
    sessions: [],
    status: "idle",
  });
  const previousBySessionIdRef = useRef<Map<string, SessionSummary> | null>(null);

  useEffect(() => {
    previousBySessionIdRef.current = null;
    setIndexState({ signature, sessions: [], status: "idle" });
  }, [signature]);

  useEffect(() => {
    if (!enabled || !rpcReady || !platform) {
      // App 壳在 remote attachment 就绪前会先挂载，旧通知 hook
      // 只看用户开关就订阅 sessions-index，从而越过 conversation 的 readiness gate
      // 访问断连代理。这里共用 workspace rpcReady；本地 workspace 始终为 true。
      previousBySessionIdRef.current = null;
      setIndexState({ signature, sessions: [], status: "idle" });
      return;
    }

    const registryScope: SessionsIndexScope = {
      workspaceKey,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(endpointKey ? { endpointKey } : {}),
    };
    const store = acquireSessionsIndex(registryScope, zcodeAgentService);
    const syncState = () => {
      setIndexState({
        signature,
        sessions: store.getSessions(),
        status: store.getStatus(),
      });
    };
    const unsubscribe = store.subscribe(syncState);
    syncState();

    return () => {
      unsubscribe();
      releaseSessionsIndex(registryScope, store);
    };
  }, [
    enabled,
    endpointKey,
    platform,
    rpcReady,
    signature,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeAgentService,
  ]);

  useEffect(() => {
    if (
      !enabled ||
      !platform ||
      indexState.signature !== signature ||
      indexState.status !== "live"
    ) {
      return;
    }

    const previousBySessionId = previousBySessionIdRef.current;
    const nextBySessionId = toSessionMap(indexState.sessions);
    if (!previousBySessionId) {
      previousBySessionIdRef.current = nextBySessionId;
      return;
    }

    const payloads = collectTerminalTaskNotificationPayloads({
      previousBySessionId,
      sessions: indexState.sessions,
      formatMessage,
    });
    for (const payload of payloads) {
      showTaskNotification(platform, payload);
    }
    previousBySessionIdRef.current = nextBySessionId;
  }, [enabled, formatMessage, indexState, platform, signature]);
}

/**
 * 全 workspace 任务终态通知。
 *
 * useWorkspaceTerminalTaskNotifications 只订阅当前 active workspace 的
 * sessions-index（App.tsx 单实例挂载）——任务跑在后台 workspace、用户前台停在
 * 别的项目时，那个 workspace 的终态边沿无人观察，完成/失败通知丢失（上游桌面
 * 同构同样有此盲区）。本 hook 从 tabStore 投影出的全部 workspace tab 逐个
 * acquireSessionsIndex 订阅，按 workspaceKey（workspaceIdentity ?? workspacePath）
 * 去重、分桶记账差分，任一 workspace 的终态边沿都发通知。设置 tab 无
 * workspacePath，自然跳过。订阅数量 = 打开的 workspace tab 数（一般 2-5 个），
 * registry 引用计数保证与单 workspace 版共存时共享同一 store 实例。
 *
 * App.tsx 用本 hook **替换**单 workspace 版（不叠加，防重复通知）。
 */
export function useAllWorkspacesTerminalTaskNotifications({
  tabs,
  enabled,
  rpcReady,
  platform,
  formatMessage,
}: {
  tabs: readonly AllWorkspacesTerminalTaskNotificationTab[];
  enabled: boolean;
  rpcReady: boolean;
  platform: TaskNotificationPlatform | null | undefined;
  formatMessage: FormatMessage;
}): void {
  const { zcodeAgentService } = useServices();
  // workspaceKey（workspaceIdentity ?? workspacePath）→ 该 workspace 的订阅参数。
  // 同 key 的重复 tab（identity 相同的临时重复行）只保留第一个，避免重复订阅。
  const workspaceScopes = useMemo(() => {
    const byKey = new Map<
      string,
      { workspacePath: string; workspaceIdentity?: string; endpointKey?: string }
    >();
    for (const tab of tabs) {
      const workspacePath = tab.workspacePath.trim();
      if (!workspacePath) continue;
      const workspaceIdentity = trimOptional(tab.workspaceIdentity);
      const endpointKey = trimOptional(tab.remoteSessionId);
      const workspaceKey = workspaceIdentity ?? workspacePath;
      if (byKey.has(workspaceKey)) continue;
      byKey.set(workspaceKey, {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(endpointKey ? { endpointKey } : {}),
      });
    }
    return [...byKey.entries()].map(
      ([workspaceKey, scope]) => ({ workspaceKey, ...scope }) as const,
    );
  }, [tabs]);

  // workspaceKey → 该 workspace 的差分记账。订阅重建（tabs 变化导致 scope 增减）
  // 只影响对应桶：被移除的 workspace 的 previous 一起丢弃，新出现的工作区从基线开始。
  const previousBySessionIdByWorkspaceKeyRef = useRef<Map<string, Map<string, SessionSummary>>>(
    new Map(),
  );

  useEffect(() => {
    if (!enabled || !rpcReady || !platform) {
      previousBySessionIdByWorkspaceKeyRef.current = new Map();
      return;
    }
    const scopeKeys = new Set(workspaceScopes.map((scope) => scope.workspaceKey));
    const nextLedger = new Map(
      [...previousBySessionIdByWorkspaceKeyRef.current].filter(([key]) => scopeKeys.has(key)),
    );
    previousBySessionIdByWorkspaceKeyRef.current = nextLedger;
  }, [enabled, platform, rpcReady, workspaceScopes]);

  // 逐 workspace 订阅：把单 workspace 版的订阅 effect 参数化。每个 scope 一条
  // effect 依赖链做不到（数量可变），这里用一个合并 state 订阅所有 store。
  const [allStates, setAllStates] = useState<Map<string, SessionsIndexNotificationState>>(
    () => new Map(),
  );
  const storeSubscriptionVersionRef = useRef(0);

  useEffect(() => {
    if (!enabled || !rpcReady || !platform) {
      setAllStates(new Map());
      return;
    }
    const stores: Array<{ workspaceKey: string; unsubscribe: () => void }> = [];
    const syncState = (workspaceKey: string, store: ReturnType<typeof acquireSessionsIndex>) => {
      setAllStates((current) => {
        const next = new Map(current);
        next.set(workspaceKey, {
          signature: workspaceKey,
          sessions: store.getSessions(),
          status: store.getStatus(),
        });
        return next;
      });
    };
    for (const scope of workspaceScopes) {
      const registryScope: SessionsIndexScope = {
        workspaceKey: scope.workspaceKey,
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        ...(scope.endpointKey ? { endpointKey: scope.endpointKey } : {}),
      };
      const store = acquireSessionsIndex(registryScope, zcodeAgentService);
      const unsubscribe = store.subscribe(() => syncState(scope.workspaceKey, store));
      syncState(scope.workspaceKey, store);
      stores.push({ workspaceKey: scope.workspaceKey, unsubscribe });
    }
    const versionAtMount = ++storeSubscriptionVersionRef.current;
    void versionAtMount;
    return () => {
      for (const entry of stores) entry.unsubscribe();
      setAllStates(new Map());
    };
  }, [enabled, platform, rpcReady, workspaceScopes, zcodeAgentService]);

  useEffect(() => {
    if (!enabled || !platform) return;
    for (const [workspaceKey, indexState] of allStates) {
      if (indexState.status !== "live") continue;
      const ledger = previousBySessionIdByWorkspaceKeyRef.current;
      const previousBySessionId = ledger.get(workspaceKey) ?? null;
      const nextBySessionId = toSessionMap(indexState.sessions);
      if (!previousBySessionId) {
        ledger.set(workspaceKey, nextBySessionId);
        continue;
      }
      const payloads = collectTerminalTaskNotificationPayloads({
        previousBySessionId,
        sessions: indexState.sessions,
        formatMessage,
      });
      for (const payload of payloads) {
        showTaskNotification(platform, payload);
      }
      ledger.set(workspaceKey, nextBySessionId);
    }
  }, [allStates, enabled, formatMessage, platform]);
}

/**
 * 当前 conversation snapshot 的阻塞交互通知。
 *
 * 首个 snapshot 只作为基线，避免订阅历史/恢复 replayable snapshot 时重放旧权限弹窗通知；
 * 后续新增 interactionId 才发通知，重复 pending 不会刷屏。
 */
export function usePendingInteractionTaskNotifications({
  snapshot,
  enabled,
  platform,
  formatMessage,
}: PendingInteractionTaskNotificationsParams): void {
  const seenRef = useRef<{ sessionId: string; seenRequestIds: Set<string> } | null>(null);

  useEffect(() => {
    if (!enabled || !snapshot) {
      seenRef.current = null;
      return;
    }

    const currentRequestIds = snapshot.pendingInteractions.map(
      (interaction) => interaction.interactionId,
    );
    const currentSeen = seenRef.current;
    if (!currentSeen || currentSeen.sessionId !== snapshot.sessionId) {
      seenRef.current = {
        sessionId: snapshot.sessionId,
        seenRequestIds: new Set(currentRequestIds),
      };
      return;
    }

    if (platform) {
      const payloads = collectPendingInteractionNotificationPayloads({
        snapshot,
        seenRequestIds: currentSeen.seenRequestIds,
        formatMessage,
      });
      for (const payload of payloads) {
        showTaskNotification(platform, payload);
      }
    }

    // 壳通知联动：上一快照里发过通知的 interaction 现在“已不在 pendingInteractions”
    // = 用户已在页面回答 → 壳侧“需要你的处理”通知撤掉。判定用差集而不是
    // “pending 为空且之前非空”：多交互场景部分回答也要撤，且切会话（sessionId 变化）
    // 走上面的重置分支不误发。浏览器/桌面无壳时 notifyShellInteractionCleared 静默跳过。
    const consumedInteraction = currentSeen.seenRequestIds
      .values()
      .some(
        (requestId) =>
          !snapshot.pendingInteractions.some((interaction) => interaction.interactionId === requestId),
      );
    if (consumedInteraction) {
      notifyShellInteractionCleared();
    }

    for (const requestId of currentRequestIds) {
      currentSeen.seenRequestIds.add(requestId);
    }
  }, [enabled, formatMessage, platform, snapshot]);
}

/**
 * 壳常驻通知计数清零：用户回到 App 且页面获得焦点时，若存在已通知过的
 * 终态任务（completed/failed），向壳发 tasks-consumed 清零“已完成 M”。
 *
 * 挂点选择说明：终态通知由 useWorkspaceTerminalTaskNotifications 的 sessions-index
 * 边沿驱动（previousStatus→status），通知到达即视为“已告知”；这里在用户回到前台
 * 且看过页面（visibilitychange visible + document.hasFocus）后清零，语义 =
 * “用户回到 App 查看过结果”。壳未注入（浏览器/桌面）时静默跳过。
 */
export function useShellTasksConsumedReporter(params: {
  enabled: boolean;
}): void {
  const { enabled } = params;

  // 挂点选择说明：终态通知由 useWorkspaceTerminalTaskNotifications 的
  // sessions-index 边沿驱动并已落地平台通知；这里不重复订阅 sessions-index，
  // 只在“用户回到 App 且页面获得焦点”时刻发一次 tasks-consumed（无参清零信号，
  // 壳侧幂等）。tasks-consumed 是清零而非按 taskId 精确销账，因此无需登记 taskId。
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      notifyShellTasksConsumed();
    };
    document.addEventListener("visibilitychange", onVisible);
    // 挂载时若页面已可见且聚焦（刷新回前台），同样清一次。
    onVisible();
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
}

// SessionPhase 的运行态/终态集合（packages/shared/src/zcode-protocol-v4/snapshot.ts
// sessionPhaseSchema：draft / prewarming / running / completedSuccess /
// completedInterrupted / error）。运行态口径与 taskListRowActivity 的
// "回合在跑"一致（prewarming+running）；draft 既非运行也非终态，不触发任何信号。
const SHELL_RUNNING_PHASES: ReadonlySet<SessionPhase> = new Set(["prewarming", "running"]);
const SHELL_TERMINAL_PHASES: ReadonlySet<SessionPhase> = new Set([
  "completedSuccess",
  "completedInterrupted",
  "error",
]);

function shellLifecycleSignalForPhase(phase: SessionPhase): "started" | "finished" | null {
  if (SHELL_RUNNING_PHASES.has(phase)) return "started";
  if (SHELL_TERMINAL_PHASES.has(phase)) return "finished";
  return null;
}

interface ShellTaskLifecycleReporterParams {
  workspacePath: string;
  workspaceIdentity?: string;
  endpointKey?: string | null;
  enabled: boolean;
  rpcReady: boolean;
}

/**
 * APK 壳常驻通知"运行中 N / 已完成 M"真实计数的页面侧信号源。
 *
 * 数据源与 useWorkspaceTerminalTaskNotifications 同源（当前 workspace 的
 * sessions-index）：对比 previous/current 的 phase，非运行态 → prewarming/running
 * 发 task-started，任意态 → 终态发 task-finished。壳侧收到后 running+1 /
 * running-1+completedUnread+1 并刷新速览；页面侧不维护计数，事实以
 * sessions-index 为准，壳侧计数漂移由 tasks-consumed 清零机制兜底。
 *
 * 基线补发：壳在每次主文档开始加载（onPageStarted）清零 running 计数，因此
 * 页面刷新/重连后，基线帧里已是运行态的会话必须补发一次 task-started，速览
 * 才能恢复；每会话每基线只补一次（记账防重），终态会话不补发 finished。
 *
 * 记账：ledgerRef 按 sessionId 记录"最后一次发出的信号"，同一迁移只发一次
 * （sessions-index 重复帧/conflation 重放不会重复加减壳侧计数）；signatures
 * 变化（workspace/endpoint 切换）与订阅重建时清账并重新走基线补发，避免跨
 * workspace 用旧边沿。flat 侧栏列表与 grouped workspace 列表共用本 hook：
 * 它挂在 App 层，覆盖当前 workspace scope，两个列表的行都是同一
 * sessions-index 的投影。
 *
 * 门控：与 useShellTasksConsumedReporter 同用 notificationEnabled（壳通知联动
 * 同一产品面，用户关通知就不向壳报数）；started/finished 对称跳过，不会产生
 * 单边 +1/-1 漂移。无壳环境（浏览器/桌面）发送端内部静默跳过。
 */
export function useShellTaskLifecycleReporter({
  workspacePath,
  workspaceIdentity: rawWorkspaceIdentity,
  endpointKey: rawEndpointKey,
  enabled,
  rpcReady,
}: ShellTaskLifecycleReporterParams): void {
  const { zcodeAgentService } = useServices();
  const workspaceIdentity = trimOptional(rawWorkspaceIdentity);
  const endpointKey = trimOptional(rawEndpointKey);
  const workspaceKey = workspaceIdentity ?? workspacePath;
  const signature = useMemo(
    () =>
      buildWorkspaceNotificationSignature({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(endpointKey ? { endpointKey } : {}),
      }),
    [endpointKey, workspaceIdentity, workspacePath],
  );
  const [indexState, setIndexState] = useState<SessionsIndexNotificationState>({
    signature,
    sessions: [],
    status: "idle",
  });
  // sessionId → 最后一次发出的信号（"started" | "finished"）。基线帧对当前已是
  // 运行态的会话补发一次 task-started（壳侧 onPageStarted 清零了 running 计数，
  // 页面刷新/重连后必须重发，速览才能恢复"运行中 N"；每会话每基线只补一次，
  // 记账防重）。此后只在信号类别变化的边沿发送（started→finished 正常推进，
  // finished→started 重跑）。
  const lastSignalBySessionIdRef = useRef<Map<string, "started" | "finished"> | null>(null);

  useEffect(() => {
    lastSignalBySessionIdRef.current = null;
    setIndexState({ signature, sessions: [], status: "idle" });
  }, [signature]);

  useEffect(() => {
    if (!enabled || !rpcReady) {
      lastSignalBySessionIdRef.current = null;
      setIndexState({ signature, sessions: [], status: "idle" });
      return;
    }

    const registryScope: SessionsIndexScope = {
      workspaceKey,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(endpointKey ? { endpointKey } : {}),
    };
    const store = acquireSessionsIndex(registryScope, zcodeAgentService);
    const syncState = () => {
      setIndexState({
        signature,
        sessions: store.getSessions(),
        status: store.getStatus(),
      });
    };
    const unsubscribe = store.subscribe(syncState);
    syncState();

    return () => {
      unsubscribe();
      releaseSessionsIndex(registryScope, store);
    };
  }, [
    enabled,
    endpointKey,
    rpcReady,
    signature,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeAgentService,
  ]);

  useEffect(() => {
    if (!enabled || indexState.signature !== signature || indexState.status !== "live") {
      return;
    }

    const lastSignalBySessionId = lastSignalBySessionIdRef.current;
    if (!lastSignalBySessionId) {
      // 基线帧：给当前已是运行态的会话补发 task-started（壳刷新后计数已清零，
      // 缺这步速览会一直显示"空闲"直到下一次边沿）。终态/草稿会话只记账不发——
      // 壳侧 running 已是 0，补发 finished 会把计数打穿成"已完成 +N"。
      const baseline = new Map<string, "started" | "finished">();
      let resumedCount = 0;
      for (const session of indexState.sessions) {
        const signal = shellLifecycleSignalForPhase(session.phase);
        if (!signal) continue;
        baseline.set(session.sessionId, signal);
        if (signal === "started") {
          notifyShellTaskStarted();
          resumedCount += 1;
        }
      }
      lastSignalBySessionIdRef.current = baseline;
      if (resumedCount > 0) {
        logger.info(
          `[shell-lifecycle] 基线帧补发 task-started ×${resumedCount}（刷新后恢复常驻速览计数）`,
        );
      }
      return;
    }

    // 每会话每迁移恰好一条信号（协议是无参计数：一条 = ±1），按会话逐一发送；
    // 同帧多会话迁移也不得合并成一条，否则壳侧计数少计。
    for (const session of indexState.sessions) {
      const signal = shellLifecycleSignalForPhase(session.phase);
      if (!signal || lastSignalBySessionId.get(session.sessionId) === signal) continue;
      lastSignalBySessionId.set(session.sessionId, signal);
      if (signal === "started") {
        notifyShellTaskStarted();
      } else {
        notifyShellTaskFinished();
      }
    }
  }, [enabled, indexState, signature]);
}

