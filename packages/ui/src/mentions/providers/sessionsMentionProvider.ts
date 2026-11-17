// composer parity：`#` 会话候选的数据源从旧 zcodeSessionStore/taskQueryCache/remote*
// 店面切到 v4 sessions-index（useWorkspaceSessionsIndexItems，侧栏同源）。
// 旧店面在 v4 shell 下不再被会话列表填充，继续读会得到空面板；序列化与排序语义不变
// （collectSessionMentionItems 保留，供单测与聚合复用）。
import { useEffect, useMemo, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import { buildSessionMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";
import type { SessionMentionWorkspaceScope } from "@/mentions/mentionPanelRouting.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import {
  resolveWorkspaceServices,
  type WorkspaceServiceResolverState,
} from "@/lib/workspaceServiceResolver.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import {
  useWorkspaceSessionsIndexItems,
  type WorkspaceSessionsIndexScope,
} from "@/v4/useWorkspaceSessionsIndexItems.js";

const HASH_SESSION_MENTION_LIMIT_PER_WORKSPACE = 20;

interface SessionMentionItem extends MentionItem {
  /** 只在候选聚合阶段分桶，不写入 Lexical node 或 canonical mention。 */
  workspaceKey: string;
}

function compareSessionTasks(
  left: ZCodeTaskMeta,
  right: ZCodeTaskMeta,
  currentWorkspaceKey?: string,
) {
  if (currentWorkspaceKey) {
    const leftCurrent =
      buildTaskWorkspaceKey(left.workspacePath, left.workspaceIdentity) === currentWorkspaceKey;
    const rightCurrent =
      buildTaskWorkspaceKey(right.workspacePath, right.workspaceIdentity) === currentWorkspaceKey;
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
  }
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
  return left.title.localeCompare(right.title);
}

function getSessionLabel(task: ZCodeTaskMeta): string {
  const title = task.title.replace(/^#sess_[a-zA-Z0-9._-]+\s*/, "").trim();
  return title || "Untitled session";
}

function getWorkspaceLabel(task: ZCodeTaskMeta): string {
  const raw = task.workspacePath.trim() || task.workspaceIdentity?.trim() || "";
  return raw.split(/[\\/]/).filter(Boolean).at(-1) ?? raw;
}

function mapTaskToMentionItem(task: ZCodeTaskMeta, provider: ZCodeProvider): SessionMentionItem {
  const sessionId = task.taskId;
  const itemProvider = task.provider ?? provider;
  return {
    id: `session:${task.taskId}`,
    category: "sessions",
    label: getSessionLabel(task),
    description: getWorkspaceLabel(task),
    value: sessionId,
    markdown: buildSessionMentionMarkdown(sessionId, getSessionLabel(task)),
    keywords: [
      task.title,
      task.taskId,
      task.workspacePath,
      task.workspaceIdentity ?? "",
      task.model ?? "",
      itemProvider,
    ],
    workspaceKey: buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
  };
}

export function collectSessionMentionItems(
  tasks: ZCodeTaskMeta[],
  provider: ZCodeProvider,
  options: {
    workspacePath?: string;
    workspaceIdentity?: string;
  } = {},
): SessionMentionItem[] {
  const currentWorkspaceKey = options.workspacePath
    ? buildTaskWorkspaceKey(options.workspacePath, options.workspaceIdentity)
    : undefined;
  const taskBySessionId = new Map<string, ZCodeTaskMeta>();
  for (const task of tasks) {
    if (task.migrationSource) {
      continue;
    }
    const sessionId = task.taskId;
    const current = taskBySessionId.get(sessionId);
    if (!current || task.updatedAt > current.updatedAt) {
      taskBySessionId.set(sessionId, task);
    }
  }

  return [...taskBySessionId.values()]
    .sort((left, right) => compareSessionTasks(left, right, currentWorkspaceKey))
    .map((task) => mapTaskToMentionItem(task, provider));
}

function limitSessionMentionItemsPerWorkspace(items: SessionMentionItem[]): SessionMentionItem[] {
  const itemCountByWorkspaceKey = new Map<string, number>();
  return items.filter((item) => {
    const itemCount = itemCountByWorkspaceKey.get(item.workspaceKey) ?? 0;
    if (itemCount >= HASH_SESSION_MENTION_LIMIT_PER_WORKSPACE) return false;
    itemCountByWorkspaceKey.set(item.workspaceKey, itemCount + 1);
    return true;
  });
}

function buildSessionMentionScopes(params: {
  baseServices: IServiceAccessor;
  currentRemoteSessionId: string | null;
  currentServices: IServiceAccessor;
  currentWorkspaceIdentity?: string;
  currentWorkspacePath: string;
  enabled: boolean;
  serviceResolverState: WorkspaceServiceResolverState;
  workspaceTabs: WorkspaceTabState[];
}): WorkspaceSessionsIndexScope[] {
  if (!params.enabled) {
    return [];
  }

  const currentAgentService = params.currentServices.zcodeAgentService;
  const scopes: WorkspaceSessionsIndexScope[] = [];
  const seenWorkspaceKeys = new Set<string>();
  const candidates: Array<
    Pick<
      WorkspaceTabState,
      "remoteSessionId" | "remoteTarget" | "workspaceIdentity" | "workspacePath"
    >
  > = [
    {
      workspacePath: params.currentWorkspacePath,
      ...(params.currentWorkspaceIdentity
        ? { workspaceIdentity: params.currentWorkspaceIdentity }
        : {}),
      ...(params.currentRemoteSessionId ? { remoteSessionId: params.currentRemoteSessionId } : {}),
    },
    ...params.workspaceTabs,
  ];

  for (const candidate of candidates) {
    const workspaceKey = buildTaskWorkspaceKey(
      candidate.workspacePath,
      candidate.workspaceIdentity,
    );
    if (seenWorkspaceKeys.has(workspaceKey)) {
      continue;
    }

    const resolved = resolveWorkspaceServices(
      candidate,
      params.baseServices,
      params.serviceResolverState,
    );
    // 功能边界：# 引用最终由当前 Agent Host 的 SQLite session store 按 session id 读取。
    // 这里只聚合同一 agent service authority，避免把另一个远端 Host 的会话做成可选但不可读的引用；
    // 未连接 remote 也会在 resolver 处返回 null，不能回退到本地 base service。
    if (!resolved || resolved.services.zcodeAgentService !== currentAgentService) {
      continue;
    }

    seenWorkspaceKeys.add(workspaceKey);
    scopes.push({
      workspacePath: candidate.workspacePath,
      ...(candidate.workspaceIdentity ? { workspaceIdentity: candidate.workspaceIdentity } : {}),
      ...(resolved.remoteSessionId ? { endpointKey: resolved.remoteSessionId } : {}),
      agentService: resolved.services.zcodeAgentService,
    });
  }

  return scopes;
}

export function useSessionsMentionProvider(
  provider: ZCodeProvider,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  workspaceScope: SessionMentionWorkspaceScope,
  emptyText: string,
  title: string,
): MentionCategoryResult {
  const baseServices = useBaseWorkspaceServices();
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const serviceResolverState = useMemo(
    () => ({
      sessionsById,
      sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath,
    }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const {
    services: workspaceServices,
    remoteSessionId,
    isRemoteTarget,
  } = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  // `@` 与 `#` 复用 provider，但只有 `#` 能扩展到同 authority 的 workspace。
  // sessions-index registry 仍按 endpoint+workspaceKey 引用计数复用，不额外建立连接。
  const scopes = useMemo<WorkspaceSessionsIndexScope[]>(() => {
    if (!enabled || (isRemoteTarget && !remoteSessionId)) {
      return [];
    }
    if (workspaceScope === "current-workspace") {
      return [
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { endpointKey: remoteSessionId } : {}),
          // 远端必须显式携带已解析 endpoint 的 service，不能让本机 Host 查询远端路径。
          agentService: workspaceServices.zcodeAgentService,
        },
      ];
    }
    return buildSessionMentionScopes({
      baseServices,
      currentRemoteSessionId: remoteSessionId,
      currentServices: workspaceServices,
      currentWorkspaceIdentity: workspaceIdentity,
      currentWorkspacePath: workspacePath,
      enabled,
      serviceResolverState,
      workspaceTabs,
    });
  }, [
    baseServices,
    enabled,
    isRemoteTarget,
    remoteSessionId,
    serviceResolverState,
    workspaceIdentity,
    workspacePath,
    workspaceScope,
    workspaceServices,
    workspaceTabs,
  ]);
  const { items: indexMetas, hydratingEndpointKeys } = useWorkspaceSessionsIndexItems(scopes);

  // 已删除/已归档会话过滤（spec: packages/ui/specs/mention-sessions-deleted-filter.md）：
  // sessions-index 的权威源是 CLI session store（无 deleted/archived 组织态列），删除语义落在
  // tasks-index 的 tombstone 行，归档语义落在 tasks-index 的 archived 分区。侧栏经
  // fetchTaskListMembershipSets 已过滤（deletedIds/archivedIds，taskListMembershipSets.ts）；
  // 这里按相同 scope 平行拉取 tombstone + archived 分区做负向 join。任一 scope 服务不可用
  // 降级为该 scope 不过滤（宁多显示不可引用候选，不让负向 join 失败打挂 @ 菜单）。
  // 刷新跟随 membershipVersion（task_deleted/task_archived 事件 bump，与侧栏同一信号）。
  const membershipVersion = useTaskListMembershipVersion();
  const [excludedIds, setExcludedIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!enabled) {
      setExcludedIds(new Set());
      return;
    }
    let disposed = false;
    void (async () => {
      const results = await Promise.all(
        scopes.map((scope) => {
          // 与候选聚合同 scope 的 tasks-index 服务（本机 base；远端 scope 由
          // buildSessionMentionScopes 已按同一 authority 过滤）。
          const service = baseServices.zcodeTaskService;
          if (!service) return Promise.resolve([] as string[]);
          // 降级：任一负向集合读取失败该 scope 不过滤（spec 验收场景 3/6）。
          const deletedIds = service.listDeletedTaskIds
            ? service
                .listDeletedTaskIds({
                  workspacePath: scope.workspacePath,
                  ...(scope.workspaceIdentity
                    ? { workspaceIdentity: scope.workspaceIdentity }
                    : {}),
                })
                .catch(() => [] as string[])
            : Promise.resolve([] as string[]);
          const archivedIds = service.listArchivedTasks
            ? service
                .listArchivedTasks({
                  workspacePath: scope.workspacePath,
                  ...(scope.workspaceIdentity
                    ? { workspaceIdentity: scope.workspaceIdentity }
                    : {}),
                })
                .catch(() => [] as ZCodeTaskMeta[])
                .then((tasks) => tasks.map((task) => task.taskId))
            : Promise.resolve([] as string[]);
          return Promise.all([deletedIds, archivedIds]);
        }),
      );
      if (!disposed) {
        setExcludedIds(new Set(results.flat(2)));
      }
    })();
    return () => {
      disposed = true;
    };
  }, [baseServices, enabled, scopes, membershipVersion]);

  const allItems = useMemo(
    () =>
      collectSessionMentionItems(indexMetas, provider, {
        workspacePath,
        workspaceIdentity,
      }),
    [indexMetas, provider, workspaceIdentity, workspacePath],
  );

  const items = useMemo(() => {
    // 持久删除 tombstone + 归档分区过滤（spec 验收场景 1/5）：命中已删或已归档
    // 会话的候选在任何阶段（含搜索命中）都不出现，与侧栏同一负向语义。
    const visibleItems = excludedIds.size
      ? allItems.filter((item) => !excludedIds.has(item.value))
      : allItems;
    // mention filter 只排序/截取原对象；保留 SessionMentionItem 的 workspaceKey。
    const matchedItems = filterMentionItemsWithOptions(visibleItems, query, {
      limit: Number.POSITIVE_INFINITY,
      requireQuery: false,
    }) as SessionMentionItem[];
    // `#` 先搜索全部会话，再按 workspaceKey 独立限制结果；不能全局截断，
    // 否则当前 workspace 的优先排序会把其他 workspace 全部挤掉。
    return workspaceScope === "same-authority-workspaces"
      ? limitSessionMentionItemsPerWorkspace(matchedItems)
      : matchedItems;
  }, [allItems, excludedIds, query, workspaceScope]);

  return {
    items: enabled ? items : [],
    loading: enabled && hydratingEndpointKeys.length > 0,
    error: null,
    emptyText,
    title,
  };
}
