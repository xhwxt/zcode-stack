/** 文件下载/预览代理的前端半边（服务端端点由服务端代理实现）：
 *
 * - 下载：GET /api/me/files/download?path=<绝对路径>（会话 Cookie 鉴权，attachment 响应）。
 *   用隐藏 <a download> 触发浏览器原生下载：同源 Cookie 自动携带，不需要额外头；
 *   HEAD 预检对已知失败态（未上线/会话失效/不可访问/超限/限流）先 toast 说明，
 *   不让用户面对浏览器打开的 JSON 错误页。
 * - 网页预览：GET /api/me/preview/proxy?url=<file:// 绝对路径或本机地址>
 *   （回环白名单代理）。直接开新标签即可——WebView 里 window.open 已修好。
 *
 * 两个入口都是"发意图"：绝对路径必须是 agent 主机上的路径（workspacePath 下）。
 *
 * 本模块不是 React 组件，取 locale 用 ErrorBoundary.resolveBoundaryLocale 同款做法：
 * localStorage 偏好 → navigator 语言 → 默认语言，直接查 locale 表。
 */
import { DEFAULT_LOCALE } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";

export const WEB_FILE_DOWNLOAD_ENDPOINT = "/api/me/files/download";

/** 文件树 workspace 注册端点：
 * 浏览器里打开的项目 workspace（setting.json 恢复链恢复的 tab）不在 server
 * 启动时宣告的根集合里，文件树对它们下载/预览一律 403。打开文件树时静默
 * POST /api/me/workspaces/register 一次，server 把 realpath 归一后的根并入
 * download/preview 的包含判定。服务端语义（commit f2f3a15）：
 *   200 {registered:true, root} | 400 invalid_path/too_many_roots
 *   | 403 forbidden | 429 rate_limited | 503 unavailable。
 * 注册表在 server 内存中、重启即失——**每次文件树挂载都要注册一次**，不做
 * "已注册过"缓存；重复注册幂等无害。全部失败（网络/401/429…）只 logger.warn，
 * 不 toast 不阻塞文件树。 */
const WORKSPACE_REGISTER_ENDPOINT = "/api/me/workspaces/register";

function readCsrfCookie(): string {
  const prefix = "zcode_device_csrf=";
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) {
      return decodeURIComponent(value.slice(prefix.length));
    }
  }
  return "";
}

export async function registerWorkspaceForFileTransfer(workspacePath: string): Promise<void> {
  try {
    await fetch(WORKSPACE_REGISTER_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-zcode-csrf": readCsrfCookie(),
      },
      body: JSON.stringify({ path: workspacePath }),
    });
  } catch (error) {
    logger.warn("[workspaceFileTransfer] workspace 注册失败（下载/预览可能 403）", {
      workspacePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveModuleLocale(): "zh-CN" | "en-US" {
  if (typeof localStorage !== "undefined" && typeof localStorage.getItem === "function") {
    try {
      const storedPreference = localStorage.getItem("zcode-locale-preference");
      if (storedPreference === "zh-CN" || storedPreference === "en-US") {
        return storedPreference;
      }
    } catch {
      // 存储层异常（测试环境的占位对象等）：回退 navigator，与 ErrorBoundary 同策略。
    }
  }
  if (typeof navigator !== "undefined") {
    return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  }
  if (DEFAULT_LOCALE === "en-US") {
    return "en-US";
  }
  return "zh-CN";
}

function formatModuleMessage(id: string): string {
  const locale = resolveModuleLocale();
  const messages = locale === "en-US" ? enUS : zhCN;
  return messages[id] ?? id;
}

export function buildWebFileDownloadUrl(absolutePath: string): string {
  return `${WEB_FILE_DOWNLOAD_ENDPOINT}?path=${encodeURIComponent(absolutePath)}`;
}

export function buildWebPreviewProxyUrl(absolutePath: string): string {
  // 路径段式端点（服务端契约见 packages/server/specs/device-credential-auth.md）：
  // 整条绝对路径编码为一段，HTML 响应注入的 <base href> 也用路径段形式——
  // query 形式（?url=...）会被浏览器相对解析丢掉 query，页面相对资源回不来。
  return `/api/me/preview/file/${encodeURIComponent(absolutePath)}`;
}

/** 与 web 包 openWebUrlWithSameOriginNavigation 同语义的 ui 侧版本。
 *  APK WebView 壳对 window.open（_blank）走 onCreateWindow harvester，同源链接
 *  （HTML 预览代理 /api/me/preview/file/...）实测被拦成外链确认框；同源改为当前
 *  WebView 直接导航（壳 routeMainFrameTarget 对同源主帧恒放行），跨源保留 window.open。 */
function isSameOriginWebUrlForTransfer(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}

export function openUrlPreferSameOriginNavigation(url: string): void {
  if (isSameOriginWebUrlForTransfer(url)) {
    window.location.assign(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** 已知失败态 → toast 词条的映射：404/401/403/413/429 都不放过到 <a> 导航，
 *  否则浏览器会打开服务端的 JSON 错误页。其余状态码（200/405 等）视为端点可用，继续 <a>。 */
function downloadFailureMessageForStatus(status: number): string | null {
  switch (status) {
    case 404:
      return formatModuleMessage("workspaceFileTree.downloadUnavailable");
    case 401:
      return formatModuleMessage("workspaceFileTree.downloadAuthExpired");
    case 403:
      return formatModuleMessage("workspaceFileTree.downloadForbidden");
    case 413:
      return formatModuleMessage("workspaceFileTree.downloadTooLarge");
    case 429:
      return formatModuleMessage("workspaceFileTree.downloadRateLimited");
    default:
      return null;
  }
}

/**
 * 触发下载。流程：先 HEAD 探测端点对这次请求是否可用（已知失败态直接 toast 说明）；
 * 其余情况用隐藏 <a download> 触发下载。HEAD 不被支持时服务端会返回 405——
 * 视为"端点在"，继续走 <a>。
 */
export async function downloadWorkspaceFileViaApi(args: {
  absolutePath: string;
  downloadName: string;
}): Promise<void> {
  const url = buildWebFileDownloadUrl(args.absolutePath);
  try {
    const probe = await fetch(url, { method: "HEAD", credentials: "same-origin", cache: "no-store" });
    const failureMessage = downloadFailureMessageForStatus(probe.status);
    if (failureMessage) {
      toast(failureMessage);
      return;
    }
  } catch {
    // 网络失败不拦 <a> 导航：交给浏览器原生行为（可能只是瞬时断网）。
  }
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = args.downloadName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (error) {
    logger.warn("[workspaceFileTransfer] 下载触发失败", {
      path: args.absolutePath,
      error: error instanceof Error ? error.message : String(error),
    });
    toast(formatModuleMessage("workspaceFileTree.downloadFailed"));
  }
}

/** HTML 文件在新标签页打开（走回环代理）。宿主提供了 onOpenBrowserUrl（桌面 shell）
 *  时交给宿主，否则按既定语义打开：同源代理 URL 直接导航（APK 壳不再拦），
 *  跨源才 window.open 新标签。 */
export function openWorkspaceHtmlPreviewInNewTab(args: {
  absolutePath: string;
  onOpenBrowserUrl?: (url: string) => void;
}): void {
  const url = buildWebPreviewProxyUrl(args.absolutePath);
  if (args.onOpenBrowserUrl) {
    args.onOpenBrowserUrl(url);
    return;
  }
  openUrlPreferSameOriginNavigation(url);
}
