// 按 endpoint + workspaceKey 复用的 SessionsIndexStore 注册表（引用计数）——多 pane / 多列表
// 消费者并行订阅的地基：同一 endpoint 同一 workspace 的多个消费者共享一条 sessions-index 订阅
// （侧栏切数据源时，useGlobalTaskList 这类处理 workspace scope 数组、无法逐 scope 调 hook 的
// 消费者走这里）。与 SessionDataLayer 的 per-session acquire/release 同构。
// 复用键加 endpoint 维度——remote shard（web/手机远控/SSH workspace）的 sessions-index
// 走各自 endpoint 的 agentService proxy，同 workspaceKey 不同 endpoint 不能共用 store。
import type { IZCodeAgentService } from "@zcode/services";
import { logger } from "@/logger.js";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { findRemoteWorkspaceSessionIdForAgentService } from "@/store/remoteWorkspaceSessionStore.js";
import {
  createAgentSessionsIndexTransport,
  type SessionsIndexTransport,
} from "@/v4/agentSessionsIndexTransport.js";
import { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";

/** 注册表需要的 agentService 窄面（= transport 的依赖面，便于测试注入）。 */
export type SessionsIndexAgentService = Pick<
  IZCodeAgentService,
  | "subscribeSessionsIndexV4"
  | "resyncSessionsIndexV4"
  | "helloConversationV4"
  | "initializeConversationV4"
  | "unsubscribeSessionsIndexV4"
  | "onDynamicSessionsIndexFrame"
  | "onAgentRuntimeRestarted"
>;

interface RegistryEntry {
  key: string;
  agentService: SessionsIndexAgentService;
  agentServiceGeneration: number;
  store: SessionsIndexStore;
  refCount: number;
  /** 热换底重订用：按当前 scope 重建 transport（同一 agentService proxy，新 socket）。 */
  createTransport: () => SessionsIndexTransport;
  scope: SessionsIndexScope;
}

const registry = new Map<string, RegistryEntry>();
const entriesByStore = new WeakMap<SessionsIndexStore, RegistryEntry>();
/** 已上报过的 endpoint 不一致 scope；同一 scope 反复 acquire（重渲染/多消费者）只落一条日志。 */
const reportedScopeEndpointMismatches = new Set<string>();

/** 本机 endpoint 的保留键（与 task list shardKey 口径一致）。 */
export const LOCAL_SESSIONS_INDEX_ENDPOINT = "__base__";

export interface SessionsIndexScope {
  /** workspace 复用键（= services resolveWorkspaceKey 口径：workspaceIdentity ?? workspacePath）。 */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** endpoint 维度：remote shard 的 remoteSessionId；缺省 = 本机 __base__。 */
  endpointKey?: string;
}

/**
 * 诊断：scope 声明的 endpoint 必须与 agentService 实际所属的远程 session 一致，否则同一个
 * 远程 workspace 会被登记成两个条目、对同一 topic 发两条订阅，而 CLI 对同 connection/topic 只保留
 * 最新一条——先到的订阅被静默替换，侧栏从此收不到帧且没有任何错误。这类键不一致
 * （如 Settings tab 覆盖时 Root 丢掉 remoteSessionId）在生产日志里没有任何 renderer 痕迹，只能靠
 * RPC 指纹反推；这里用 lifecycle 通道落盘，让同类键不一致在用户日志里直接可见。只记录、不改键。
 */
function reportScopeEndpointMismatch(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
): void {
  const remoteSessionId = findRemoteWorkspaceSessionIdForAgentService(agentService);
  if (!remoteSessionId) return;
  const endpointKey = scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT;
  if (endpointKey === remoteSessionId) return;
  const reportKey = `${endpointKey}\0${scope.workspaceKey}\0${remoteSessionId}`;
  if (reportedScopeEndpointMismatches.has(reportKey)) return;
  reportedScopeEndpointMismatches.add(reportKey);
  logger.lifecycle.warn("[v4-sessions-index] scope endpoint 与远程代理归属不一致", {
    event: "v4.sessions_index.scope_endpoint_mismatch",
    endpointKey,
    remoteSessionId,
    workspaceKey: scope.workspaceKey,
    workspacePath: scope.workspacePath,
  });
}

function createSessionsIndexTransport(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
) {
  const workspaceIdentity = scope.workspaceIdentity?.trim();
  return createAgentSessionsIndexTransport(agentService, {
    workspacePath: scope.workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
}

/** 注册表条目键 = endpoint + workspaceKey（同 workspaceKey 不同 endpoint 不共用）。 */
export function buildSessionsIndexEntryKey(
  scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  agentService?: SessionsIndexAgentService,
): string {
  const entryKey = `${scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT}\0${scope.workspaceKey}`;
  return agentService
    ? `${entryKey}\0service-generation:${remoteAgentServiceGeneration(agentService)}`
    : entryKey;
}

/** 取/建某 endpoint+workspace 的共享 sessions-index store，refCount++（首次 acquire 发起订阅）。 */
export function acquireSessionsIndex(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
): SessionsIndexStore {
  reportScopeEndpointMismatch(scope, agentService);
  const entryKey = buildSessionsIndexEntryKey(scope);
  const incomingServiceGeneration = remoteAgentServiceGeneration(agentService);
  const existing = registry.get(entryKey);
  if (existing?.agentService === agentService) {
    existing.refCount += 1;
    return existing.store;
  }
  if (
    existing &&
    existing.agentService !== agentService &&
    incomingServiceGeneration > existing.agentServiceGeneration
  ) {
    // service proxy 换代（远程 attachment 重连 / web base 软重连）：复用同一 store，
    // 按 generation 单向、串行切换 transport。store generation 会同步 detach 旧
    // transport 并让迟到结果失效。本地 __base__ 换代不再 delete+close（那是整树
    // 重挂语义），与远程同样原地 replace——sessions 面板状态跨换代存续。
    existing.refCount += 1;
    existing.agentService = agentService;
    existing.agentServiceGeneration = incomingServiceGeneration;
    const transport = createSessionsIndexTransport(scope, agentService);
    // 任何中间 proxy 的 subscribe 都可能永久 pending，换代不能排队等待
    // 前一条 I/O。store generation 会同步 detach 旧 transport，并让迟到结果自行失效。
    void existing.store.replaceTransport(transport).catch((error) => {
      logger.warn("[v4-sessions-index] transport replacement failed", error);
    });
    return existing.store;
  }
  if (existing) {
    if (existing.agentService === agentService) {
      // buildSessionsIndexEntryKey 带了 generation 时不会走到这里；不带 generation
      // 的调用方（同 scope 不同 key 组合）按同 service 复用。
      existing.refCount += 1;
      return existing.store;
    }
    // generation 不满足单向切换（迟到/回退的旧 proxy）：清场重建，防止 transport
    // 被切回旧代。旧 consumer 后续 cleanup 仍按 store 身份精确 release。
    registry.delete(entryKey);
    if (existing.refCount <= 0) {
      existing.store.close();
      entriesByStore.delete(existing.store);
    }
  }
  const store = new SessionsIndexStore();
  const transport = createSessionsIndexTransport(scope, agentService);
  // 初始 subscribe 可能在旧 RPC proxy 被销毁后永久 pending。换代队列不能
  // 等待这条旧 I/O；replaceTransport 会用 store generation 失效其迟到结果。
  void store.connect(transport, { forceSnapshot: true });
  const entry: RegistryEntry = {
    key: entryKey,
    agentService,
    agentServiceGeneration: incomingServiceGeneration,
    store,
    refCount: 1,
    createTransport: () => createSessionsIndexTransport(scope, agentService),
    scope,
  };
  registry.set(entryKey, entry);
  entriesByStore.set(store, entry);
  return store;
}

/** refCount--，归零则 close + 移除（退订 + 解监听）。 */
/**
 * 底层传输热换底（web 软重连 hot-swap）后广播：sessions-index store 强制重订
 * （同一 transport 对象、新 socket），恢复订阅流。
 */
export function notifySessionsIndexSwapped(): void {
  for (const entry of registry.values()) {
    void entry.store.replaceTransport(entry.createTransport(), { force: true }).catch((error) => {
      logger.warn("[v4-sessions-index] hot-swap re-subscribe failed", error);
    });
  }
}

export function releaseSessionsIndex(
  scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  store: SessionsIndexStore,
): void {
  const entryKey = buildSessionsIndexEntryKey(scope);
  const entry = entriesByStore.get(store);
  if (!entry || entry.key !== entryKey) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.store.close();
    entriesByStore.delete(entry.store);
    if (registry.get(entryKey) === entry) registry.delete(entryKey);
  }
}
