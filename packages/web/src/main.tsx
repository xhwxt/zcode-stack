/* eslint-disable max-lines -- Web 入口集中编排启动、路由与 workspace shell wiring，与 Root.tsx 同样先保持入口收口，避免跨层状态拆散。 */
import { createRoot } from "react-dom/client";
import {
  AppErrorBoundary,
  Root,
  ZCodeIntlProvider,
  generateMobileDeviceFingerprint,
  playTaskNotificationSound,
  setStreamClientId,
  type Theme,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import {
  connectViaHotSwapProtocol,
  connectViaWebSocket,
  withPageVisibility,
} from "@zcode/client";
import type { HotSwapConnection, WebSocketHeartbeatHandle } from "@zcode/client";
import { notifyConnectionSwappedAfterHotSwap, markWebTransportDisconnected } from "@zcode/ui/v4/connection-swap";
import { WebCallbackPage } from "./auth/WebCallbackPage.js";
import { createWebAuthService } from "./auth/webAuthService.js";
import { WEB_ZAI_OAUTH_CONFIG, resolveWebAuthDevReturnTo } from "./auth/webZaiOAuthConfig.js";
import { parseOAuthState, resolveSafeAppReturnTo } from "./auth/oauthStateCodec.js";
import { resolveWebCommunityUrl, resolveWebHelpConfig } from "./communityUrl.js";
import {
  ConversationShareLandingLoader,
  ConversationShareLandingStatus,
} from "./share/ConversationShareLandingPage.js";
import {
  ConversationSharePreviewClient,
  resolveConversationShareRouteLocale,
} from "./share/conversationSharePreviewClient.js";
import {
  isConversationSharePath,
  resolveConversationShareCodeFromPath,
} from "./share/conversationShareRoute.js";
import { DeviceManagerPage } from "./devices/DeviceManagerPage.js";
import { UsagePage } from "./usage/UsagePage.js";
import type { IPlatformService, RemoteTarget, ServerRemoteInfo } from "@zcode/shared";
import { WEB_DEFAULT_THEME, resolveWebInitialTheme } from "./webThemeSeed.js";
import { openWebUrlWithSameOriginNavigation } from "./lib/webUrlNavigation.js";

function resolveWebThemePreference(defaultTheme: Theme = WEB_DEFAULT_THEME): Theme {
  const saved = localStorage.getItem("zcode-theme");
  return resolveWebInitialTheme({ storedTheme: saved, defaultTheme });
}

// 初始化主题：默认 Zai dark，后续由 useTheme hook 接管
// system 模式下需要查询系统偏好；非 system 模式直接用存储值
{
  // 分享页没有本地主题配置时使用浅色，已有配置仍然沿用；其他 Web 页面继续默认深色。
  const applyWebThemeFromPreference = (): void => {
    const saved = resolveWebThemePreference(
      isConversationSharePath(window.location.pathname) ? "zai-light" : undefined,
    );
    const resolved =
      saved === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : saved === "dark" || saved === "zai-dark"
          ? "dark"
          : "light";
    const appliedTheme =
      saved === "system"
        ? resolved === "dark"
          ? "zai-dark"
          : "zai-light"
        : saved === "dark"
          ? "zai-dark"
          : saved === "light"
            ? "zai-light"
            : saved;
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
    document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
  };
  applyWebThemeFromPreference();
  // 多标签页主题同步：主题写入 localStorage("zcode-theme") 后其他标签页无感知，
  // 只能刷新才跟随。storage 事件在本标签页写入时不触发（规范行为）、在其他标签页触发，
  // 恰好就是"另一标签改了主题"的信号——收到后重跑同一套主题应用逻辑即可。
  window.addEventListener("storage", (event) => {
    if (event.key === "zcode-theme" && event.storageArea === window.localStorage) {
      applyWebThemeFromPreference();
    }
  });
}

async function resolveFeedbackUrl(): Promise<string | undefined> {
  return (await resolveWebHelpConfig()).feedback_url;
}

const root = createRoot(document.getElementById("root")!);
const webAuthService = createWebAuthService();

// 初始化 Web 端流式 clientId，确保所有 hook 在首次渲染前就使用稳定 ID
{
  setStreamClientId(generateMobileDeviceFingerprint());
}

interface WebBootstrapResult {
  wsUrl: string;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  initialTaskId?: string;
  restoreSession?: boolean;
  allowOpenWorkspace?: boolean;
}

function isWebOAuthCallback(params: URLSearchParams): boolean {
  return (
    ["/cn/share/callback", "/share/callback"].includes(window.location.pathname) &&
    params.has("state") &&
    (params.has("code") || params.has("error"))
  );
}

function renderWebAuthCallbackPage(): void {
  document.title = "ZCode - Sign In";
  const callbackState = parseOAuthState(
    new URLSearchParams(window.location.search).get("state") ?? "",
  );
  const safeRetryTarget = resolveSafeAppReturnTo(callbackState?.app_return_to);
  root.render(
    <WebCallbackPage
      authService={webAuthService}
      onSuccess={({ appReturnTo }) => {
        window.location.replace(appReturnTo ?? "/");
      }}
      onRetry={() => {
        window.location.replace(safeRetryTarget ?? "/");
      }}
    />,
  );
}

async function renderConversationSharePage(): Promise<void> {
  // 页面语言跟随路径前缀：/cn/share 中文，裸 /share 英文。
  const routeLocale = resolveConversationShareRouteLocale(window.location.pathname);
  // index.html 固定 lang="en"；不同步会让中文分享页对无障碍与浏览器翻译都报错语言。
  document.documentElement.lang = routeLocale;
  // 分享页必须设置 title：否则浏览器标签只显示 index.html 的通用标题。
  // 会话标题要等 preview 加载完，先给一个语言正确的兜底。
  document.title = routeLocale === "zh-CN" ? "ZCode 会话分享" : "ZCode Conversation Share";
  const shareCode = resolveConversationShareCodeFromPath(window.location.pathname);
  if (!shareCode) {
    root.render(
      <ConversationShareLandingStatus
        state={{ kind: "error", error: "invalid_contract" }}
        locale={routeLocale}
      />,
    );
    return;
  }

  const endpointOrigin =
    import.meta.env.VITE_ZCODE_BASE_URL?.trim().replace(/\/+$/u, "") || window.location.origin;
  const mockMode =
    import.meta.env.DEV && import.meta.env.VITE_CONVERSATION_SHARE_PREVIEW_MOCK === "true";
  // Share 加载失败不能只有通用 network 文案：需要区分 mock、endpoint 配置或跨域 fetch。
  // 这里只记录运行时路由与 endpoint，不记录完整 pathname，避免把 share code 写入日志。
  console.info("[conversation-share-web]", "preview_runtime_initialized", {
    browserOrigin: window.location.origin,
    routeKind: "canonical",
    endpointOrigin,
    transport: mockMode ? "mock" : "fetch",
  });
  const client = mockMode
    ? new (
        await import("./share/mockConversationSharePreviewClient.js")
      ).MockConversationSharePreviewClient()
    : new ConversationSharePreviewClient({ baseUrl: `${endpointOrigin}/api/v1` });
  const getMockToken = () =>
    mockMode && window.sessionStorage.getItem("zcode:share:mock-auth") === "owner"
      ? "mock-owner-token"
      : null;
  const onLogout = () => {
    if (mockMode) {
      window.sessionStorage.removeItem("zcode:share:mock-auth");
      window.location.reload();
      return;
    }
    void webAuthService.logout();
  };
  root.render(
    <ConversationShareLandingLoader
      shareCode={shareCode}
      client={client}
      getAccessToken={() => getMockToken() ?? webAuthService.getZCodeJwtToken()}
      onLogin={(provider) => {
        if (mockMode) {
          window.sessionStorage.setItem("zcode:share:mock-auth", "owner");
          window.location.reload();
          return;
        }
        webAuthService.startLogin({
          provider,
          appReturnTo: window.location.href,
          redirectUri: WEB_ZAI_OAUTH_CONFIG.shareRedirectUri,
          devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG),
        });
      }}
      onLogout={onLogout}
      locale={routeLocale}
      theme={resolveWebThemePreference("zai-light")}
    />,
  );
}

// 设备管理独立路由（/devices）：与 share 同构的独立页面，不进 Root 组件树。
// SPA 到达这里的前提是服务端静态 fallback 把 /devices 落到 index.html，而
// index.html 有 302 会话门禁——无会话的请求到不了这段代码，所以页面侧只需
// 处理"有会话但已过期"：DeviceManagerPage 启动时自己 renew 一次。
async function renderDeviceManagerPage(): Promise<void> {
  document.title = "ZCode - 设备管理";
  root.render(<DeviceManagerPage />);
}

// 用量独立路由（/usage）：与 /devices 同构的独立页面，不进 Root 组件树、不连 WS。
// 服务对象是不装状态栏插件（zusage）的浏览器用户——此前 token 用量只有状态栏可见。
// 数据走 GET /api/me/usage-summary（会话 Cookie 鉴权）；端点未上线时页面自显示
// "服务端未就绪"提示，不报错。服务端静态 fallback 是通用 SPA fallback，无需服务端改动。
async function renderUsagePage(): Promise<void> {
  document.title = "ZCode - 用量";
  root.render(<UsagePage />);
}

function createWebPlatform(): IPlatformService {
  return {
    canSelectFilePath: false,
    // Web 端无法打开系统目录选择框
    selectDirectory: () => Promise.resolve(null),
    // Web 端无法打开系统文件选择框
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,
    createTempTextAttachment: () =>
      Promise.reject(new Error("Temporary text attachments require a desktop host")),
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    onBotRemoteWorkspaceReconnected: () => () => {},
    // Web 端无多窗口管理
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    // TODO(web-remote-workspace): 普通 Web 模式先只保证 server 本地工作区可用。
    // 远程 WebSocket 只暴露部分 service，与 Root/RemoteServiceAccess 需要的完整
    // accessor 不匹配，直接打开 ?remote=<id> 会在项目向导或首屏卡住。
    connectRemote(options: RemoteTarget) {
      return Promise.resolve({
        success: false,
        error: `Remote connect is not supported in Web mode yet: ${options.kind}`,
      });
    },
    cancelPendingRemoteConnection: (_requestId?: string) => Promise.resolve(),
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () => Promise.resolve(false),
    listWSLDistros: () => Promise.resolve([]),
    listDockerContainers: () => Promise.resolve([]),
    listSSHConfigAliases: () => Promise.resolve([]),
    loadMcpFromUserDirectory: () => Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: () =>
      Promise.resolve({
        success: false,
        error: "MCP native directory management requires a desktop attachment",
      }),
    migrateLegacyCommonMcp: () =>
      Promise.resolve({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
    openExternal: (url) => {
      // 同源链接（/usage、/web-remote 等）在 APK WebView 壳里走 window.open
      // 会被 onCreateWindow harvester 拦成外链确认框；同源改当前页直接导航
      //（壳对同源主帧导航恒放行），跨源外链仍 window.open 新标签。
      openWebUrlWithSameOriginNavigation(url);
    },
    openFeedback: async () => {
      const feedbackUrl = await resolveFeedbackUrl();
      if (!feedbackUrl) {
        return;
      }
      // 同上——同源走当前页导航，跨源新标签（帮助/反馈链接通常跨源）。
      openWebUrlWithSameOriginNavigation(feedbackUrl);
    },
    openCommunity: async () => {
      const locale = document.documentElement.lang === "en-US" ? "en-US" : "zh-CN";
      const communityUrl = await resolveWebCommunityUrl(locale);
      if (!communityUrl) {
        return;
      }
      // 同上。
      openWebUrlWithSameOriginNavigation(communityUrl);
    },
    canOpenCommunity: async (locale) => {
      const communityUrl = await resolveWebCommunityUrl(locale);
      return typeof communityUrl === "string" && communityUrl.length > 0;
    },
    openInFileManager: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    openExternalFile: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    registerOAuthState: (_payload) => {},
    onOAuthCallback: () => () => {},
    onPaymentCallback: () => () => {},
    onShareImport: () => () => {},
    notifyRendererReady: () => {},
    reportTelemetryEvent: async () => {},
    reportArmsCustomEvent: () => Promise.resolve(),
    showTaskNotification: (payload) => {
      if (document.hasFocus()) {
        return;
      }

      if (
        typeof window.Notification === "undefined" ||
        window.Notification.permission !== "granted"
      ) {
        return;
      }

      try {
        new window.Notification(payload.title, {
          body: payload.body,
          silent: true,
        });
        void playTaskNotificationSound();
      } catch {
        // 浏览器通知不可用时静默忽略，避免打断主流程
      }
    },
    // Web 端不需要跨窗口 tab 管理
    syncWindowTabs: () => {},
    // Web 端没有宿主层 Dock / 任务栏徽标，保持空实现以兼容统一平台接口
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: () => () => {},
    exportLogs: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: (_options) =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: {
          originsImported: 0,
          entriesImported: 0,
          originsSkipped: 0,
          originsFailed: 0,
        },
        error: "chrome_import_not_supported" as const,
      }),
    clearEmbeddedBrowserData: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    // IPlatformService 新增更新提示能力后，Web fallback 没有同步补齐空实现，
    // 根级 typecheck 会直接失败，连与桌面端无关的改动都没法完成校验。
    // Web 端当前没有桌面更新器，先显式 no-op，保持接口完整且不改变现有行为。
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: (_locale) => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    getDeviceId: () => {
      // 旧桩用 navigator.platform + 屏幕尺寸拼接：同型号手机/同配置桌面浏览器得到
      // 完全相同的 ID，设备注册表里无法区分。改用首次生成 crypto.randomUUID()
      // 存 localStorage 后复用——每个浏览器 profile 天然唯一，清存储即新设备（可接受）。
      const STORAGE_KEY = "zcode:web:device-id";
      try {
        const existing = window.localStorage.getItem(STORAGE_KEY);
        if (existing) {
          return existing;
        }
      } catch {
        // localStorage 不可用（隐私模式等）：退化为每次会话内一次性随机 ID。
      }
      let generated: string;
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        generated = crypto.randomUUID();
      } else {
        // 极老浏览器兜底：UUID v4 手拼（crypto.getRandomValues 兼容面远大于 randomUUID）。
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6]! & 0x0f) | 0x40;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        generated = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, generated);
      } catch {
        // 写不进去就用本次生成的值，行为退化为"每次加载算一台新设备"。
      }
      return generated;
    },
  };
}

function resolveDefaultWsOrigin(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

async function resolveWebBootstrap(): Promise<WebBootstrapResult> {
  const params = new URLSearchParams(window.location.search);
  const remoteId = params.get("remote");
  const wsUrl = remoteId
    ? `${resolveDefaultWsOrigin()}/ws/remote/${remoteId}`
    : `${resolveDefaultWsOrigin()}/ws`;

  if (remoteId) {
    return { wsUrl };
  }

  try {
    // 鉴权语义（设备凭据 + 短期会话，规格 mobile/handoff/zcode-device-credential-spec.md §6/§7）：
    // 浏览器日常访问不再有任何 token——旧「URL 携带凭据」通道已删除（任何形式的旧 token 一律 401）。
    // 会话由服务端在配对 redeem 时种下（HttpOnly 会话 Cookie），/api/* 与 /ws 凭该 Cookie 鉴权，
    // 这里与 /ws 一致地凭同源会话 Cookie 取 server-info。无有效会话时服务端 401/302 到配对页，
    // 本函数照旧返回 { wsUrl }，由后续 /ws 连接失败/服务端跳转链路接管，不在客户端猜测跳转。
    const response = await fetch("/api/server-info", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) {
      return { wsUrl };
    }
    const serverInfo = (await response.json()) as Partial<ServerRemoteInfo>;
    const workspace = Array.isArray(serverInfo.workspaces) ? serverInfo.workspaces[0] : undefined;
    // 修复依据：web 直连页侧栏「任务」分组按已打开 workspace 的 scope 查询（useGlobalTaskList），
    // 桌面端靠 restoreSession 恢复 lastWorkspaceSession（含对话后台 tab）打开工作区；
    // web 端此前从不设置 restoreSession → 无 tab 打开 → 任务列表恒空。
    // 修法：启用 web 端会话恢复，与桌面端同一恢复链路（useTabPersistence 读
    // setting.json 的 lastWorkspaceSession/recentProjects 还原 tabs，含对话后台），
    // 「不在项目中工作」的对话由此出现在侧栏「任务」分组。
    // 不传 initialWorkspaceAbsPath：避免与恢复链路抢占（Root 的初始注入门禁在 web
    // 场景下存在死锁，实测 addTab 从未执行；恢复链路是桌面同款成熟路径）。
    return { wsUrl, restoreSession: true };
  } catch {
    return { wsUrl };
  }
}

function WebBootstrapErrorScreen({ message }: { message: string }) {
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-destructive" />
            <h1 className="text-ui-xs font-medium">
              {/^zh\b/i.test(navigator.language) ? "Web 启动失败" : "Web bootstrap failed"}
            </h1>
          </div>
          <p className="mt-2 break-all text-ui-xs/relaxed text-foreground-subtle">{message}</p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover"
            onClick={() => {
              window.location.reload();
            }}
          >
            {/^zh\b/i.test(navigator.language) ? "重试" : "Retry"}
          </button>
        </section>
      </div>
    </div>
  );
}

function renderWebBootstrapError(error: unknown): void {
  document.title = "ZCode - Web";
  root.render(
    <WebBootstrapErrorScreen message={error instanceof Error ? error.message : String(error)} />,
  );
}

// ── 连接守卫 + 软重连（手机后台断连恢复）──────────────────────────────────────
// 手机浏览器切后台数秒即可被系统冻结/回收 WebSocket；回前台时 socket 可能已死
// 且无任何提示（RPC 调用静默失败）。
//
// 设计（切后台回来不得出现刷新）：socket 关闭后按退避序列软重连，
// 重连期间旧 React 树保持可见（用户还能阅读已渲染内容）；成功后热换底
// （reconnect()，零 React 重渲），顶部横幅提示状态。state 一致性由服务端事实源
// + 原地恢复保证。**绝不整页 reload**——reload 与重连风暴保护已整体移除
//（实机日志实证：正常的前后台切换重连节奏就会触发风暴保护 reload，
// 打断使用；原地恢复语义下 React 树不重挂，reload 没有存在理由）。
// 锁屏（hidden）期间 socket 死亡不做任何操作；回前台时若 socket 已死则触发软重连。
// 秒切回（socket 健在）不触发任何重连（延续 8d4489c 修复）。

declare global {
  interface Window {
    __zcodeConnGuard?: { markSocketDead: () => void };
  }
}

// 软重连退避序列（毫秒）：耗尽后保持 8s 周期原地重试（见 startWebSoftReconnect）。
// 首试不等待（立即重连）：真断线（close 事件已到达）无需再等 1s；
// 后续 0.5/1.5/4/8s 覆盖服务端重启窗口。
const SOFT_RECONNECT_DELAYS_MS = [0, 500, 1_500, 4_000, 8_000] as const;

interface WebReconnectBanner {
  element: HTMLDivElement;
  setMessage(message: string): void;
}

// 软重连状态横幅：固定顶部、不遮挡已渲染内容。惰性挂载：首试（立即重连）
// 大多在 1s 内成功，用户全程看不到任何提示。持续失败（>REPAIR_LINK_AFTER_ATTEMPTS 次）
// 时追加"重新配对"链接：长期重试文案会让用户干等，主动给出逃生门——
// 会话其实已失效但探测节流尚未判定的场景，用户可自己决定去重新配对。
const REPAIR_LINK_AFTER_ATTEMPTS = 5;

function mountWebReconnectBanner(): WebReconnectBanner {
  // 幂等：横幅惰性化后本函数会在多次失败尝试/退避耗尽时调用，已有横幅直接复用。
  const existing = document.getElementById("zcode-web-conn-banner");
  if (existing instanceof HTMLDivElement) {
    return {
      element: existing,
      setMessage(message: string) {
        existing.textContent = message;
      },
    };
  }
  const zh = /^zh\b/i.test(navigator.language);
  const el = document.createElement("div");
  el.id = "zcode-web-conn-banner";
  el.style.cssText =
    "position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:6px 16px;" +
    "text-align:center;background:#b45309;color:#fff;font:13px/1.4 system-ui,sans-serif;";
  el.textContent = zh ? "连接已断开，正在重新连接…" : "Connection lost, reconnecting…";
  document.body.appendChild(el);
  return {
    element: el,
    setMessage(message: string) {
      el.textContent = message;
    },
  };
}

/** 持续失败时在横幅尾部补一个"重新配对"链接（与横幅同款内联样式）。
 *  幂等：重复调用不会追加第二个链接。 */
function appendRepairLinkToBanner(attemptNo: number): void {
  const banner = document.getElementById("zcode-web-conn-banner");
  if (!banner || banner.querySelector("a[data-zcode-repair-link]")) {
    return;
  }
  const zh = /^zh\b/i.test(navigator.language);
  const link = document.createElement("a");
  link.dataset.zcodeRepairLink = "true";
  link.href = "/api/pairing/page";
  link.textContent = zh ? "重新配对" : "Re-pair";
  link.style.cssText = "color:#fff;font-weight:600;text-decoration:underline;margin-left:10px;";
  banner.appendChild(link);
}

function removeWebReconnectBanner(): void {
  document.getElementById("zcode-web-conn-banner")?.remove();
}

// 设备凭据链路的两个硬失败码（deviceCredentialAuth.ts）：
// - 4401 = 设备被撤销（killDeviceSessions 主动 close）；renew 也救不回来，直接去配对页。
// - 401  = 会话过期（/ws 升级拒绝）；先试 renewSessionQuietly 换新会话，
//   成功则继续软重连，失败（renew Cookie 也失效）同样是配对页。
const WS_DEVICE_REVOKED_CLOSE_CODE = 4401;

// 去重：一次跳转意图只执行一次（软重连循环、close 回调、renew 失败可能并发触发）。
let pairingRedirectArmed = false;

function redirectToPairingPage(reason: "device_revoked" | "session_expired"): void {
  if (pairingRedirectArmed) return;
  pairingRedirectArmed = true;
  // 横幅要常驻到跳转完成，避免用户看到"正在重新连接"的假状态。
  const zh = /^zh\b/i.test(navigator.language);
  mountWebReconnectBanner().setMessage(
    reason === "device_revoked"
      ? zh
        ? "此设备已被移除，正在转到重新配对…"
        : "This device was removed. Redirecting to pairing…"
      : zh
        ? "登录已失效，正在转到重新配对…"
        : "Session expired. Redirecting to pairing…",
  );
  window.location.replace("/api/pairing/page");
}

// 软重连循环内可重入：循环自己的 inflight 锁挡住并发，这里只做一次性跳转判定。
// 机制说明：WS 升级被中间件 401 拒绝时，@hono/node-ws 直接 socket.end("HTTP/1.1 401")，
// 浏览器侧拿不到 HTTP 状态（close code 恒 1006）。所以"是不是 401"不能从 close 事件
// 判读，必须用同源 /api/server-info 探测：ok=false 且非网络异常（服务在响应）即会话失效。
async function handleSoftReconnectUnauthorized(): Promise<void> {
  // 会话过期 ≠ 设备撤销：先按浏览器静默续期路径试一次。
  const renewed = await renewSessionQuietly();
  if (renewed) {
    return; // 新 Cookie 已就位，调用方继续下一轮重连。
  }
  // renew 失败 = 续期 Cookie 也失效或设备被撤销：确认 server 仍在应答（排除纯网络断）
  // 后跳配对页；server 不可达则保持横幅重试原语义（可能是网络问题，不是掉线）。
  const serverResponding = await probeServerInfoAlive();
  if (serverResponding) {
    redirectToPairingPage("session_expired");
  }
}

// 连接代际：每次新 WS open 递增。close 回调携带自己所属的代，
// **旧连接迟到的 close 不触发重连**——否则热换底后旧 socket 超时断开会
// 再次进入重连循环（实机实证：27 秒内 5 条 WS 反复重建，
// 每次换底 fail-closed 挂起请求，体感"断连"）。
let webSocketGeneration = 0;

function handleWebTransportClosed(generation: number, event: {
  wasClean: boolean;
  code: number;
}): void {
  if (generation !== webSocketGeneration) {
    // 旧连接的迟到 close：热换底已经处理过，忽略。
    return;
  }
  // 设备被撤销：服务端 killDeviceSessions 主动优雅 close（wasClean 可能为 true），
  // 判定必须以 close code 为准——4401 无论如何不进软重连循环（renew 救不了撤销），直达配对页。
  if (event.code === WS_DEVICE_REVOKED_CLOSE_CODE) {
    redirectToPairingPage("device_revoked");
    return;
  }
  // 正常关闭（主动登出/服务端优雅关闭）不自动重载，避免干扰正常流程。
  // 注意：手机切后台瞬间浏览器可能主动以 1001（going away）优雅关闭 ——
  // 这类"看似正常"的关闭在后台场景同样是断连，需要标记让回前台恢复路径处理。
  if (event.wasClean || event.code === 1000 || event.code === 1001) {
    // 断连时钟（横幅判据）：不管进不进软重连，socket 已死就从现在起算。
    // 主动登出路径同样置位——横幅随后会被登出页导航取代，无副作用。
    markWebTransportDisconnected();
    if (document.visibilityState === "hidden" && window.__zcodeConnGuard) {
      window.__zcodeConnGuard.markSocketDead();
    }
    return;
  }
  markWebTransportDisconnected();
  window.__zcodeConnGuard?.markSocketDead();
  if (document.visibilityState === "visible") {
    void startWebSoftReconnect();
  }
}

async function probeServerInfoAlive(): Promise<boolean> {
  // 同上（resolveWebBootstrap）：凭同源会话 Cookie 探活，不再拼任何 URL token。
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), 4_000);
  try {
    const response = await fetch("/api/server-info", {
      credentials: "same-origin",
      cache: "no-store",
      signal: ctl.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

// ── 浏览器静默续期（客户端半边）────────────────────────────
// 修复依据：服务端在 redeem 时种下 90 天续期 Cookie（zcode_device_renew，HttpOnly），
// 但此前页面没有任何代码去调 /api/auth/renew —— 会话 12h 一到就 401，浏览器被迫
// 重新配对（手机壳有 Keystore 凭据自己 renew，浏览器只能靠这里）。
// 策略：启动时尝试一次（会话还活着也无害，renew 会轮换并重发两枚 Cookie）；
// 之后每 6 小时（会话 12h 的一半）静默续期，活跃浏览器永不过期。
// 401 恢复路径（软重连失败后）也先试 renew 再判定真掉线。
//
// renew 节流：回前台不再无条件 renew——每次 renew 服务端都会签发新会话，
// 服务端每设备会话上限 16 条（MAX_SESSIONS_PER_DEVICE），频繁回前台会持续制造
// 新会话挤掉旧会话（其他 tab/壳被顶下线）。节流判据：server-info 探测会话仍有效
// 且按"上次 renew 时间 + 12h"估算未过半（>6h 剩余）时跳过；会话已死（401）则
// 立即 renew 抢救。fetch 响应头没有过期时间，用本地时间戳估算即可满足节流精度。
const SESSION_RENEW_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SESSION_TTL_ESTIMATE_MS = 12 * 60 * 60 * 1000;
const SESSION_RENEW_SKIP_THRESHOLD_MS = SESSION_TTL_ESTIMATE_MS / 2;
const SESSION_LAST_RENEW_STORAGE_KEY = "zcode:session:last-renew-at";

function readLastSessionRenewAt(): number {
  try {
    const raw = window.localStorage.getItem(SESSION_LAST_RENEW_STORAGE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function noteSessionRenewed(): void {
  try {
    window.localStorage.setItem(SESSION_LAST_RENEW_STORAGE_KEY, String(Date.now()));
  } catch {
    // localStorage 不可用时节流退化为"每次都 renew"，与旧行为一致，可接受。
  }
}

async function renewSessionQuietly(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/renew", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    // 200 = 拿到新会话（Set-Cookie 已由浏览器自动更新）；
    // 401 = 续期 Cookie 无效/设备被撤销（真掉线，让 302/配对页流程接管）。
    const ok = response.ok;
    if (ok) {
      noteSessionRenewed();
    }
    return ok;
  } catch {
    return false;
  }
}

async function probeSessionValid(): Promise<boolean> {
  // 与 probeServerInfoAlive 同源同凭据，但只回答"会话是否有效"（401 vs 网络异常分开）。
  try {
    const response = await fetch("/api/server-info", {
      credentials: "same-origin",
      cache: "no-store",
    });
    return response.ok;
  } catch {
    // 网络异常时无法证明会话死了；按无效处理走 renew 是安全方向
    //（renew 失败也不会比旧的无条件 renew 更差）。
    return false;
  }
}

/**
 * 回前台的续期决策：会话有效且估算剩余寿命 > 6h 时跳过 renew。
 * 返回 true = 已续期或判定需要续期并已执行；false = 会话健康，跳过。
 */
async function renewOnVisibleThrottled(): Promise<void> {
  const lastRenewAt = readLastSessionRenewAt();
  const elapsedSinceRenew = Date.now() - lastRenewAt;
  const withinHalfLife = elapsedSinceRenew < SESSION_RENEW_SKIP_THRESHOLD_MS;
  if (withinHalfLife) {
    // 估算寿命还剩 >6h：不再验证，直接跳过（省一次探测请求）。
    return;
  }
  const sessionValid = await probeSessionValid();
  if (sessionValid) {
    // 会话活着但已过半衰期：等下一个 6h 定时点 renew（保持原有节奏），
    // 回前台本身不再制造新会话。
    return;
  }
  // 会话已死（401）：立即 renew 抢救——这条路径与旧行为一致，保持不变。
  await renewSessionQuietly();
}

function installSessionAutoRenew(): void {
  void renewSessionQuietly();
  window.setInterval(() => void renewSessionQuietly(), SESSION_RENEW_INTERVAL_MS);
  // 回前台时按节流决策续期：会话健康则跳过，已死则立即 renew。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void renewOnVisibleThrottled();
    }
  });
}

// ── 同 socket 半开探测（回前台路径）─────────────────────────────────────────
// 修复依据：半开是 per-connection 的，
// HTTP 探测换了一根连接，测不出当前这条 socket 已死——「表面正常、实际已断」的根因。
// 判据全部来自应用正在用的那条连接（connectWebHotSwap 保存的心跳把手）：
// 1) 把手的 lastReceivedAt（任何收到的帧都算活性）在 HEARTBEAT_PROBE_FRESH_MS 内
//    → 连接活着，不重连；
// 2) 时间戳过期 → 补发一根探针，短暂等待回显/数据帧刷新时间戳；
// 3) 补探后仍未刷新 → 判死，走软重连。
const HEARTBEAT_PROBE_FRESH_MS = 20_000;
const HEARTBEAT_PROBE_WAIT_MS = 1_200;

// 最近一次建立的连接的心跳把手（重连成功后覆盖；null = 无监视器，退回 HTTP 探测）。
let webHeartbeatHandle: WebSocketHeartbeatHandle | null = null;

async function probeConnectionAliveOnSameSocket(): Promise<boolean> {
  const handle = webHeartbeatHandle;
  if (!handle) {
    // 没有监视器（如连接建立中/测试环境）：退回 HTTP 探测，语义与旧行为一致。
    return probeServerInfoAlive();
  }
  const before = handle.lastReceivedAt();
  if (Date.now() - before <= HEARTBEAT_PROBE_FRESH_MS) {
    return true;
  }
  handle.sendKeepAlive();
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), HEARTBEAT_PROBE_WAIT_MS);
  try {
    await new Promise<void>((resolve) => {
      const poll = window.setInterval(() => {
        if (handle.lastReceivedAt() !== before) {
          window.clearInterval(poll);
          resolve();
        }
      }, 250);
      ctl.signal.addEventListener("abort", () => {
        window.clearInterval(poll);
        resolve();
      });
    });
  } finally {
    window.clearTimeout(timer);
  }
  return handle.lastReceivedAt() !== before;
}

// ── 软重连状态机 ──────────────────────────────────────────────────────────
// 所有权：唯一入口 startWebSoftReconnect；inflight 防并发重入。
// 事件顺序：socket close → markSocketDead → visible 触发/回前台触发 →
// 指数退避重连 → 成功：热换底（reconnect()，零 React 重渲）、拆横幅。
// 软重连永不失败到 reload：退避走完持续 8s 周期重试（reload 路径已整体移除）。
let webSoftReconnectInflight = false;
let softReconnectAttemptNo = 0;

async function attemptSoftReconnectOnce(
  wsUrl: string,
  zh: boolean,
): Promise<boolean> {
  try {
    // 热换底：新连接的 protocol 换进既有 ChannelClient——accessor 对象身份不变，
    // React 树零重渲（用户感知=什么都没发生）。挂起 RPC fail-closed，
    // 事件订阅经 onWebReconnected 通知重挂。
    await new Promise<void>((resolve, reject) => {
      const generation = ++webSocketGeneration;
      connectViaWebSocket(wsUrl, {
        onOpenSocket: (ws) => {
          const stale = previousWebSocket;
          previousWebSocket = ws;
          if (stale && stale !== ws) {
            try {
              stale.close();
            } catch {
              // 已关闭时忽略。
            }
          }
        },
        onClose: (event) => handleWebTransportClosed(generation, event),
        heartbeat: withPageVisibility(() => document.visibilityState === "visible"),
        onHeartbeat: (handle) => {
          webHeartbeatHandle = handle;
        },
        onHeartbeatDead: () => {
          markWebTransportDisconnected();
          window.__zcodeConnGuard?.markSocketDead();
          if (document.visibilityState === "visible") {
            void startWebSoftReconnect();
          }
        },
        onOpenProtocol: (protocol) => {
          try {
            const buffered: any[] = [];
            protocol.onMessage((frame) => buffered.push(frame));
            bufferedReconnect = (p, frames) => {
              bufferedReconnect = undefined;
              webHotSwapConnection?.reconnect(p, frames);
            };
            bufferedFramesRef = buffered;
            // Initialize 帧大概率已到（server open 即发）——立即换底并重放。
            bufferedReconnect?.(protocol, buffered.splice(0));
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      }).catch(reject);
    });
    removeWebReconnectBanner();
    document.title = "ZCode - Web + Server";    notifyWebReconnected();
    return true;
  } catch {
    softReconnectAttemptNo += 1;
    // 横幅惰性化：第 2 次尝试失败才挂横幅——首试（立即重连）大多在 1s 内成功，
    // 用户完全无感；一旦走到第 2 次说明是真断线，此时再提示不迟。
    if (softReconnectAttemptNo >= 2) {
      mountWebReconnectBanner().setMessage(
        zh
          ? `连接已断开，正在重新连接…（第 ${softReconnectAttemptNo} 次尝试）`
          : "Connection lost, reconnecting…",
      );
    }
    // 持续失败逃生门：>5 次失败后横幅尾部出现"重新配对"链接——
    // 会话可能已失效但探测节流（每 3 次查一次）尚未判定，给用户手动出口。
    if (softReconnectAttemptNo > REPAIR_LINK_AFTER_ATTEMPTS) {
      appendRepairLinkToBanner(softReconnectAttemptNo);
    }
    return false;
  }
}

async function startWebSoftReconnect(): Promise<void> {
  if (webSoftReconnectInflight) return;
  webSoftReconnectInflight = true;
  softReconnectAttemptNo = 0;
  const zh = /^zh\b/i.test(navigator.language);
  // 横幅不再预先挂载（首试成功时用户全程看不到任何提示）；
  // attemptSoftReconnectOnce 第 2 次失败时经 mountWebReconnectBanner 挂载（幂等：已有则跳过）。
  try {
    const wsUrl = resolveDefaultWsOrigin() + "/ws";
    // 退避序列走完后保持 8s 周期原地重试（绝不整页 reload——reload 与风暴保护
    // 已整体移除）：网络/服务恢复的瞬间自动接上。server 不可用时页面
    // 停留在横幅状态（可继续阅读已渲染内容），恢复后无需任何手动操作。
    let i = 0;
    for (;;) {
      const delay = SOFT_RECONNECT_DELAYS_MS[i] ?? 8_000;
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      const ok = await attemptSoftReconnectOnce(wsUrl, zh);
      if (ok) return;
      if (i < SOFT_RECONNECT_DELAYS_MS.length - 1) i += 1;
      // 8s 死循环出口：连续重连失败时区分"会话已失效"。401 → renew →
      // 仍失败（server 在应答）即跳配对页，不再空转最长 6h 等定时 renew 来救。
      // 探测节流：每 3 次失败查一次，避免把探测本身变成新的风暴。
      if ((i + 1) % 3 === 0) {
        await handleSoftReconnectUnauthorized();
        if (pairingRedirectArmed) return;
      }
    }
  } finally {
    webSoftReconnectInflight = false;
  }
}

function installWebConnectionGuard(): void {
  let socketDiedWhileHidden = false;

  const recoverOnVisible = (): void => {
    if (document.visibilityState !== "visible") return;
    if (socketDiedWhileHidden) {
      socketDiedWhileHidden = false;
      void startWebSoftReconnect();
      return;
    }
    // socket 没报 close 也可能已被静默回收（半开连接）；回前台用同 socket 探测判死。
    // 判据来自应用正在用的那条连接（心跳时间戳 + 补发探针的回显）——
    // 不再用 HTTP fetch：换一根连接的探测测不出当前 socket 的半开。
    void probeConnectionAliveOnSameSocket().then((alive) => {
      if (!alive) {
        void startWebSoftReconnect();
      }
    });
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // socket 是否真死由 onClose 回调置位（close 桥）；hidden 期间到达的 close
      // 不能立即重连（冻结态不可见），转由回前台时的 recoverOnVisible 消费。
    } else {
      recoverOnVisible();
    }
  });
  window.addEventListener("online", () => {
    recoverOnVisible();
  });
  // socket 真死标记桥：transport onClose 到达时置位。
  window.__zcodeConnGuard = { markSocketDead: () => { socketDiedWhileHidden = true; } };
}

// ── 热换底连接 ──────────────────────────────────────────────────────────────
// accessor 对象身份恒定；软重连成功后经 reconnect() 换底，零 React 重渲。
let webHotSwapConnection: HotSwapConnection | null = null;
// 热换底之间的帧缓冲引用（reconnect 消费后清空）。
let bufferedReconnect: ((p: any, frames: any[]) => void) | undefined;
let bufferedFramesRef: unknown[] = [];

// 传输换代后需要上层重挂的事件订阅：沿用 RemoteServiceAccess 的 channel 名单不可行
// （订阅方各异），由 onReconnected 通知各监听方自行重订。订阅清单由 zustand/transport
// 层在收到通知后统一处理——这里只负责广播。
function notifyWebReconnected(): void {
  // 热换底成功：作废旧握手缓存（新 socket 在 server 端是新 scope，必须重发
  // hello+initialize）并广播 conversation/sessions-index store 携水位重订。
  // pane/滚动/投影原地存续。零 React 重渲。
  notifyConnectionSwappedAfterHotSwap();
}

// 上一个 WebSocket 实例：热换底后必须显式关闭，否则旧连接保持打开——
// server 端连接堆积、每条都被 ping/pong 清理 terminate、close 事件回流，
// 是重连/重载风暴的资源面根源。
let previousWebSocket: WebSocket | null = null;

async function connectWebHotSwap(
  wsUrl: string,
): Promise<HotSwapConnection> {
  return new Promise<HotSwapConnection>((resolve, reject) => {
    const generation = ++webSocketGeneration;
    connectViaWebSocket(wsUrl, {
      onOpenSocket: (ws) => {
        // 新连接已建立并接管：显式关闭上一条，杜绝旧连接堆积。
        const stale = previousWebSocket;
        previousWebSocket = ws;
        if (stale && stale !== ws) {
          try {
            stale.close();
          } catch {
            // 已关闭时忽略。
          }
        }
      },
      onClose: (event) => handleWebTransportClosed(generation, event),
      heartbeat: withPageVisibility(() => document.visibilityState === "visible"),
      onHeartbeat: (handle) => {
        webHeartbeatHandle = handle;
      },
      onHeartbeatDead: () => {
        markWebTransportDisconnected();
        window.__zcodeConnGuard?.markSocketDead();
        if (document.visibilityState === "visible") {
          void startWebSoftReconnect();
        }
      },
      onOpenProtocol: (protocol) => {
        // 帧缓冲：server 的 Initialize 在 WS open 瞬间已到达，而 ChannelClient
        // 绑定发生在 reconnect()（resetTransport）——缓冲期间的帧必须重放，
        // 否则 Initialize 丢失、握手永远无法完成（fault.connection.handshakeRequired）。
        const buffered: any[] = [];
        protocol.onMessage((frame) => buffered.push(frame));
        const connection = connectViaHotSwapProtocol(protocol);
        bufferedReconnect = (p, frames) => connection.reconnect(p, frames);
        bufferedFramesRef = buffered;
        resolve(connection);
      },
    }).catch(reject);
  });
}

async function bootstrapWebApp() {
  const params = new URLSearchParams(window.location.search);
  if (isWebOAuthCallback(params)) {
    renderWebAuthCallbackPage();
    return;
  }

  if (isConversationSharePath(window.location.pathname)) {
    await renderConversationSharePage();
    return;
  }

  if (window.location.pathname === "/devices") {
    await renderDeviceManagerPage();
    return;
  }

  if (window.location.pathname === "/usage") {
    await renderUsagePage();
    return;
  }

  let bootstrap: WebBootstrapResult;
  try {
    bootstrap = await resolveWebBootstrap();
  } catch (error) {
    renderWebBootstrapError(error);
    return;
  }

  try {
    installWebConnectionGuard();
    // 浏览器静默续期（客户端半边）：启动试一次 + 6h 周期 + 回前台触发。
    installSessionAutoRenew();
    // 热换底连接：accessor 对象身份恒定，软重连只换底层传输。
    // 这是"切后台回来零视觉变化"的最后一块——任何对象换代都会让 React
    // context 树重渲（用户感知为"界面闪一下重建"），热换底彻底消除它。
    const connection = await connectWebHotSwap(bootstrap.wsUrl);
    webHotSwapConnection = connection;
    const platform = createWebPlatform();
    document.title = "ZCode - Web + Server";

    // Root 常驻：软重连不再触碰任何 React 输入（services 对象永不更换）。
    root.render(
      <WebAppShell platform={platform} bootstrap={bootstrap} services={connection.services} />,
    );
  } catch (error) {
    renderWebBootstrapError(error);
  }
}

function WebAppShell({
  platform,
  bootstrap,
  services,
}: {
  platform: IPlatformService;
  bootstrap: WebBootstrapResult;
  services: ReturnType<typeof connectViaHotSwapProtocol>["services"];
}) {
  // services 身份恒定（热换底），无需 state。
  return (
    <AppErrorBoundary>
      <ZCodeIntlProvider
        settingService={services.settingService}
        broadcastService={services.broadcastService}
      >
        <Root
          services={services}
          platform={platform}
          initialWorkspaceAbsPath={bootstrap.initialWorkspaceAbsPath}
          initialWorkspaceIdentity={bootstrap.initialWorkspaceIdentity}
          initialWorkspacePurpose={bootstrap.initialWorkspacePurpose}
          initialTaskId={bootstrap.initialTaskId}
          restoreSession={bootstrap.restoreSession}
          allowOpenWorkspace={bootstrap.allowOpenWorkspace}
          preferDirectoryBrowser
          supportsEmbeddedBrowser={false}
          allowRemoteWorkspace={false}
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>
  );
}

void bootstrapWebApp();
