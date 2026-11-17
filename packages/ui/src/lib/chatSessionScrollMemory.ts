export interface ChatSessionScrollMemoryState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasPinnedToBottom?: boolean;
  /**
   * 行锚点：视口顶部覆盖行的身份与两个像素偏移。
   *
   * 为什么要按行锚定：距底像素差只在「内容总高度不变」时才对应同一行。切走再切回时
   * 历史补拉与首屏测高修正会大幅改变 scrollHeight（实测 5834→9734+），同样的距底
   * 距离落到几千行之外；行身份（turnId+rowId）不随总高度变化，恢复时按行顶
   * offsetTop 换算落点才是阅读位置的稳定等价量。
   *
   * - anchorRowOffsetPx：捕捉时行顶相对视口顶部的偏移（行顶在视口上方为负），
   *   还原时决定视口顶与行顶的距离。
   * - anchorRowOffsetInUnitPx：捕捉时行顶相对所属渲染单元顶部的偏移。恢复时刻
   *   锚点行通常不在挂载窗口内（虚拟列表只挂视口附近），无法直接量 DOM；但
   *   unit 的测量起点在虚拟测量缓存里，两者相加即得行顶 offsetTop。
   *
   * 四个字段同生共死：任一缺失/非法都视为无行锚点，恢复走距底像素法。
   * 旧记忆没有这些字段，自然走像素法（向后兼容）。
   */
  anchorRowTurnId?: string;
  anchorRowId?: number;
  anchorRowOffsetPx?: number;
  anchorRowOffsetInUnitPx?: number;
  updatedAt: number;
}

const CHAT_SESSION_SCROLL_MEMORY_MAX_ENTRIES = 200;

// 会话滚动记忆跨页面生命周期持久化（修复依据：刷新后对话滚动位置剧变——
// 原实现只有内存 Map，整页 reload/软重连后清零，只能按贴底语义跳到最新消息）。
// 镜像到 sessionStorage：key 前缀 zcode-scroll-memory:，LRU 上限 40 条，
// 控制低配手机上 5MB 配额压力；所有存取 try/catch，隐私模式/配额满静默降级
// 为纯内存行为。
const CHAT_SESSION_SCROLL_MEMORY_STORAGE_PREFIX = "zcode-scroll-memory:";
const CHAT_SESSION_SCROLL_MEMORY_STORAGE_MAX_ENTRIES = 40;
// 「pinned=false 但已在底部」的退化判定容差：略大于时间线底部锚定容差（48px）。
const CHAT_SESSION_SCROLL_MEMORY_BOTTOM_EPSILON_PX = 64;

const chatSessionScrollMemory = new Map<string, ChatSessionScrollMemoryState>();

function normalizeKeyPart(value?: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function readChatSessionScrollMemoryStorage(key: string): ChatSessionScrollMemoryState | null {
  try {
    const raw = window.sessionStorage.getItem(CHAT_SESSION_SCROLL_MEMORY_STORAGE_PREFIX + key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<ChatSessionScrollMemoryState> | null;
    if (
      !parsed ||
      typeof parsed.scrollTop !== "number" ||
      !Number.isFinite(parsed.scrollTop) ||
      typeof parsed.scrollHeight !== "number" ||
      !Number.isFinite(parsed.scrollHeight) ||
      typeof parsed.clientHeight !== "number" ||
      !Number.isFinite(parsed.clientHeight)
    ) {
      return null;
    }
    return {
      scrollTop: parsed.scrollTop,
      scrollHeight: parsed.scrollHeight,
      clientHeight: parsed.clientHeight,
      wasPinnedToBottom: parsed.wasPinnedToBottom === true ? true : undefined,
      // 行锚点字段全部可选且要求合法值：镜像可能来自旧版本写入（无字段）或被
      // 手工篡改；身份字段要求非空字符串、偏移要求有限数字，否则整体视为
      // 无行锚点，让恢复走距底像素法，而不是拿着半截身份猜位置。
      anchorRowTurnId:
        typeof parsed.anchorRowTurnId === "string" && parsed.anchorRowTurnId
          ? parsed.anchorRowTurnId
          : undefined,
      anchorRowId:
        typeof parsed.anchorRowId === "number" && Number.isFinite(parsed.anchorRowId)
          ? parsed.anchorRowId
          : undefined,
      anchorRowOffsetPx:
        typeof parsed.anchorRowOffsetPx === "number" && Number.isFinite(parsed.anchorRowOffsetPx)
          ? parsed.anchorRowOffsetPx
          : undefined,
      anchorRowOffsetInUnitPx:
        typeof parsed.anchorRowOffsetInUnitPx === "number" &&
        Number.isFinite(parsed.anchorRowOffsetInUnitPx)
          ? parsed.anchorRowOffsetInUnitPx
          : undefined,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

function pruneChatSessionScrollMemoryStorage(): void {
  try {
    const entries: Array<{ key: string; updatedAt: number }> = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const storageKey = window.sessionStorage.key(index);
      if (!storageKey?.startsWith(CHAT_SESSION_SCROLL_MEMORY_STORAGE_PREFIX)) {
        continue;
      }
      const state = readChatSessionScrollMemoryStorage(
        storageKey.slice(CHAT_SESSION_SCROLL_MEMORY_STORAGE_PREFIX.length),
      );
      entries.push({ key: storageKey, updatedAt: state?.updatedAt ?? 0 });
    }
    if (entries.length <= CHAT_SESSION_SCROLL_MEMORY_STORAGE_MAX_ENTRIES) {
      return;
    }
    entries.sort((a, b) => a.updatedAt - b.updatedAt);
    const overflow = entries.length - CHAT_SESSION_SCROLL_MEMORY_STORAGE_MAX_ENTRIES;
    for (let index = 0; index < overflow; index += 1) {
      window.sessionStorage.removeItem(entries[index]!.key);
    }
  } catch {
    // sessionStorage 不可用（隐私模式等）：静默降级为纯内存行为。
  }
}

function writeChatSessionScrollMemoryStorage(
  key: string,
  state: ChatSessionScrollMemoryState,
): void {
  try {
    window.sessionStorage.setItem(
      CHAT_SESSION_SCROLL_MEMORY_STORAGE_PREFIX + key,
      JSON.stringify(state),
    );
    pruneChatSessionScrollMemoryStorage();
  } catch {
    // 配额满 / 隐私模式：静默降级，内存 Map 仍是有效回退。
  }
}

function touchChatSessionScrollMemoryEntry(
  key: string,
  state: ChatSessionScrollMemoryState,
): ChatSessionScrollMemoryState {
  chatSessionScrollMemory.delete(key);
  chatSessionScrollMemory.set(key, state);
  return state;
}

function pruneChatSessionScrollMemory(): void {
  while (chatSessionScrollMemory.size > CHAT_SESSION_SCROLL_MEMORY_MAX_ENTRIES) {
    const oldestKey = chatSessionScrollMemory.keys().next().value;
    if (!oldestKey) {
      return;
    }

    chatSessionScrollMemory.delete(oldestKey);
  }
}

export function buildChatSessionScrollMemoryKey({
  workspacePath,
  workspaceIdentity,
  paneId,
  sessionId,
  taskId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  paneId?: string;
  sessionId?: string | null;
  taskId?: string | null;
}): string | null {
  const workspaceKey = normalizeKeyPart(workspaceIdentity) ?? normalizeKeyPart(workspacePath);
  const paneScope = normalizeKeyPart(paneId);
  const sessionScope = normalizeKeyPart(sessionId);
  const taskScope = normalizeKeyPart(taskId);
  if (!workspaceKey) {
    return null;
  }

  const rendererScope = paneScope ? `${workspaceKey}::pane:${paneScope}` : workspaceKey;

  if (sessionScope) {
    return `${rendererScope}::session:${sessionScope}`;
  }

  return taskScope ? `${rendererScope}::task:${taskScope}` : null;
}

export function readChatSessionScrollMemoryState(
  key: string | null,
): ChatSessionScrollMemoryState | null {
  if (!key) {
    return null;
  }

  const cached = chatSessionScrollMemory.get(key);
  if (cached) {
    return touchChatSessionScrollMemoryEntry(key, cached);
  }

  const persisted = readChatSessionScrollMemoryStorage(key);
  if (!persisted) {
    return null;
  }
  return touchChatSessionScrollMemoryEntry(key, persisted);
}

export function saveChatSessionScrollMemoryState(
  key: string | null,
  state: ChatSessionScrollMemoryState,
): void {
  if (!key) {
    return;
  }

  // 退化快照守卫（防污染）：wasPinnedToBottom=false 但落点已在底部
  // （距底 ≈0）是加载期 clamp/测高补偿产生的中间态，不是真实阅读位置。
  // 持久化它会在 reload 后把用户拽回底部/覆盖其真实位置——实测
  // 「刷新后回到会话中间随机位置」的污染源之一。真实阅读位置必然
  // 离底超过该容差（用户在底部时 following=true，pinned=true）。
  const maxScrollTop = Math.max(state.scrollHeight - state.clientHeight, 0);
  const clampedTop = Math.min(Math.max(state.scrollTop, 0), maxScrollTop);
  const distanceFromBottom = maxScrollTop - clampedTop;
  if (state.wasPinnedToBottom === false && distanceFromBottom <= CHAT_SESSION_SCROLL_MEMORY_BOTTOM_EPSILON_PX) {
    return;
  }

  touchChatSessionScrollMemoryEntry(key, state);
  writeChatSessionScrollMemoryStorage(key, state);
  pruneChatSessionScrollMemory();
}

export function resolveChatSessionScrollRestoreTop(
  state: Pick<ChatSessionScrollMemoryState, "scrollTop">,
  metrics: Pick<HTMLElement, "clientHeight" | "scrollHeight">,
): number {
  const maxScrollTop = Math.max(metrics.scrollHeight - metrics.clientHeight, 0);
  return Math.min(Math.max(state.scrollTop, 0), maxScrollTop);
}

/**
 * 距底锚定恢复（spec: packages/ui/specs/web-recovery.md）。
 *
 * 修复依据（实测：reload 后落点在会话中部随机位置）：绝对 scrollTop 隐含
 * 「内容总高度不变」假设。reload/软重连后 timeline 先渲染尾部窗口、历史行逐步
 * 前插，scrollHeight 与保存时刻不一致，绝对值被 maxScrollTop 夹紧后落在任意
 * 中间位置。阅读位置的稳定等价量是「距内容底部距离」：尾部窗口最先就绪，且
 * 用距底差换算后落点始终在最近内容区域附近——正是用户刷新前的阅读区域。
 * 同内容（会话内切回、无新消息）时与绝对恢复完全等价。
 */
export function resolveChatSessionScrollRestoreTopFromBottom(
  state: Pick<ChatSessionScrollMemoryState, "scrollTop" | "scrollHeight" | "clientHeight">,
  metrics: Pick<HTMLElement, "clientHeight" | "scrollHeight">,
): number {
  const savedMaxScrollTop = Math.max(state.scrollHeight - state.clientHeight, 0);
  const savedDistanceFromBottom = Math.max(
    savedMaxScrollTop - Math.min(Math.max(state.scrollTop, 0), savedMaxScrollTop),
    0,
  );
  const maxScrollTop = Math.max(metrics.scrollHeight - metrics.clientHeight, 0);
  return Math.max(maxScrollTop - savedDistanceFromBottom, 0);
}

/**
 * 行锚点可用性判定：四个字段同时合法才可按行恢复。
 *
 * 单独检查而不是在保存时整体写入，是为了让「旧镜像缺字段」「捕捉时窗口为空」
 * 这两类记忆在同一处收敛出同一个结论——回退距底像素法。
 */
export function hasChatSessionScrollRowAnchor(
  state: Pick<
    ChatSessionScrollMemoryState,
    "anchorRowTurnId" | "anchorRowId" | "anchorRowOffsetPx" | "anchorRowOffsetInUnitPx"
  >,
): boolean {
  return (
    typeof state.anchorRowTurnId === "string" &&
    state.anchorRowTurnId.length > 0 &&
    typeof state.anchorRowId === "number" &&
    Number.isSafeInteger(state.anchorRowId) &&
    typeof state.anchorRowOffsetPx === "number" &&
    Number.isFinite(state.anchorRowOffsetPx) &&
    typeof state.anchorRowOffsetInUnitPx === "number" &&
    Number.isFinite(state.anchorRowOffsetInUnitPx)
  );
}
