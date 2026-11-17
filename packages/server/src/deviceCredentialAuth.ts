/* eslint-disable max-lines -- 设备凭据鉴权的逻辑与配对页 HTML 集中一处，便于独立单测与审计。 */
/* 设备凭据鉴权（spec: packages/server/specs/device-credential-auth.md）
 * 替换旧单 token 模式（直接切换，无兼容开关）。不变量 1-6 见 spec §不变量。
 *
 * 模块划分：本文件持有全部逻辑（设备注册表持久化、配对码、短期会话、CSRF、
 * WS 撤销注册表），http.ts 只做接线。
 *
 * 安全设计：
 * - 会话以 sha256(sessionToken) 为 key、csrf 也存摘要，并落盘 sessions.json（同样只有
 *   摘要）——内存快照与磁盘泄露同样拿不到可用凭据，服务重启后会话不丢；
 * - 一切秘密比较都在摘要层做 timingSafeEqual；
 * - devices.json 原子写（tmp wx+0600 → rename），拒符号链接、1MiB 上限、加载 chmod 自愈；
 * - 撤销先落盘再杀会话/WS；
 * - 会话寿命 = min(now+12h, deviceExpiresAt)；
 * - 会话校验逐请求重查设备注册表（撤销即时的机制保证）；
 * - 会话 Cookie 四件套（含 __Host- 变体）；配对码全局单窗口；
 * - renew/probe 更新 lastSeenAt 并整表落盘，不延长设备寿命；
 * - 全部新端点 body ≤ 16KiB；
 * - 静默自愈（续期是服务端的职责，客户端无需配合）：会话失效但请求带
 *   续期 Cookie 时，服务端凭设备凭据隐式换发新会话（trySilentRenew），正常路径零开销；
 * - 会话淘汰/清理/撤销与 WS 注册表同事件对齐：被淘汰或过期的会话其活跃 socket 一并
 *   close(4401)（撤销路径由 killDeviceSessions 覆盖，其余路径在删除记录处内联关闭）。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { setCookie } from "hono/cookie";
import { formatLogPrefix } from "@zcode/shared";

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:device-auth", process.pid), ...args);

/* ---------- TTL（写进 spec §协议，改动需同步 spec）---------- */
const DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 设备凭据 90 天（滑动窗口：renew 顺延）
const DEVICE_TTL_ABSOLUTE_MS = 365 * 24 * 60 * 60 * 1000; // 滑动上限：自创建起 365 天兜底
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 会话 12 小时（封顶于设备寿命）
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 配对码 10 分钟、单次、全局单窗口
/* 限流：单人自部署，限流只保留"防在线爆破"的底线，
 * 不再可能挡住正常使用。redeem 码是 72bit 随机+单次，爆破本就无意义；
 * renew/probe 凭据 256bit。窗口内次数放宽到百级，仅防脚本滥用打满日志。 */
const REDEEM_RATE_WINDOW_MS = 10 * 60 * 1000;
const REDEEM_RATE_MAX = 100; // redeem：100 次 / 10 分钟 / IP
const RENEW_RATE_WINDOW_MS = 10 * 60 * 1000;
const RENEW_RATE_MAX = 600; // renew：600 次 / 10 分钟 / IP（浏览器 6h 一次，绰绰有余）
const PROBE_RATE_WINDOW_MS = 10 * 60 * 1000;
const PROBE_RATE_MAX = 600;
const TOUCH_DEBOUNCE_MS = 5_000; // 已鉴权请求 lastSeenAt 触碰的落盘去抖
const MAX_BODY_BYTES = 16 * 1024; // 全部新端点 body 上限
/* CSRF 强制开关：默认强制校验 x-zcode-csrf 双提交 token。
 * 应急回退：env ZCODE_CSRF_ENFORCE=0/false/off 回到「只下发不强制」旧语义
 * （部署侧改 systemd 环境后重启生效；正常部署永远不需要）。 */
const CSRF_ENFORCE_OFF_VALUES = new Set(["0", "false", "off"]);
const MAX_REGISTRY_BYTES = 1024 * 1024; // devices.json / sessions.json 加载上限
const SESSION_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 过期会话清理 + 落盘周期
/* /api/me/files/download 的文件大小与限流上限。 */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100MB
const DOWNLOAD_RATE_WINDOW_MS = 10 * 60 * 1000;
const DOWNLOAD_RATE_MAX = 30; // 30 次 / 10 分钟 / IP
/* /api/me/preview/proxy 的限流 / 超时 / HTML 内联阈值。 */
const PREVIEW_RATE_WINDOW_MS = 10 * 60 * 1000;
const PREVIEW_RATE_MAX = 60; // 60 次 / 10 分钟 / IP（页面资源也走代理，档位高于下载）
const PREVIEW_UPSTREAM_TIMEOUT_MS = 15_000;
const PREVIEW_HTML_INLINE_MAX_BYTES = 2 * 1024 * 1024; // ≤2MB 的 HTML 才读全量注入 <base>
/* /api/me/usage-summary：限流档位与预览一致（页面轮询型）。 */
const USAGE_RATE_WINDOW_MS = 10 * 60 * 1000;
const USAGE_RATE_MAX = 60; // 60 次 / 10 分钟 / IP

export const SESSION_COOKIE_NAME = "zcode_device_session";
export const SESSION_COOKIE_HOST_NAME = "__Host-zcode_device_session";
export const CSRF_COOKIE_NAME = "zcode_device_csrf";
export const CSRF_COOKIE_HOST_NAME = "__Host-zcode_device_csrf";
export const RENEW_COOKIE_NAME = "zcode_device_renew";
export const CSRF_HEADER_NAME = "x-zcode-csrf";
export const ADMIN_SECRET_HEADER = "x-zcode-admin";
const DEFAULT_ADMIN_SECRET_PATH = "/etc/zcode/zcode-admin.secret";
/** 撤销/过期/淘汰会话时主动关闭 WS 的 close code（http.ts 的 ping 循环复用同一码）。 */
export const WS_REVOKE_CLOSE_CODE = 4401;

/** 错误 body 统一 {error:<code>}，错误码用固定字面量。 */
type ErrorCode =
  | "authentication_failed"
  | "device_revoked"
  | "device_expired"
  | "rate_limited"
  | "forbidden";

/* ---------- 存储结构 ---------- */

interface DeviceRecord {
  id: string; // 32 hex
  label: string; // ≤64 字符
  tokenDigest: string; // sha256 hex（不变量1：磁盘只有摘要）
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  /** 临时设备（ttlHours 配对码兑换）：到期自然失效，renew 不顺延寿命。 */
  temporary: boolean;
}

interface DeviceStoreFile {
  version: 1;
  instanceId: string; // 64 hex，首次创建时生成后固化
  devices: DeviceRecord[];
}

interface PairingCode {
  digest: Buffer;
  label: string;
  expiresAt: number;
}

/** 内存会话（key 与 csrf 都存摘要）。 */
interface DeviceSessionRecord {
  deviceId: string;
  csrfDigest: string;
  expiresAt: number;
}

/** sessions.json 持久化结构：key/csrfDigest 均为摘要，磁盘上绝不出现明文 token（不变量1）。 */
interface SessionRecordFile {
  version: 1;
  sessions: Array<{
    key: string; // sha256(sessionToken) hex
    deviceId: string; // 32 hex
    csrfDigest: string; // sha256 hex
    expiresAt: number; // epoch ms
  }>;
}

/** WS 撤销注册表所需的 socket 最小接口（ws.WebSocket 天然满足）。 */
export interface GuardSocket {
  on(event: string, listener: () => void): unknown;
  close(code?: number, reason?: string): void;
}

interface PairingCode {
  digest: Buffer;
  label: string;
  expiresAt: number;
  /** 提供了 ttlHours 的配对码：redeem 出的设备 temporary=true、expiresAt = now + ttl。 */
  ttlHours: number | null;
}

export interface DeviceCredentialAuthOptions {
  /** 数据根（devices.json 落在 `<dataBaseDir>/.zcode/devices.json`）。 */
  dataBaseDir: string;
  /** 管理密钥路径，默认 /etc/zcode/zcode-admin.secret；可被 env ZCODE_ADMIN_SECRET_FILE 覆盖。 */
  adminSecretPath?: string;
  /** 测试注入时钟。 */
  now?: () => number;
  /**
   * /api/me/pending-summary 数据源：返回本部署 workspace 的
   * 挂起交互 / 运行中任务 / 完成未读计数。由 http.ts 装配层注入（闭包 services.get）；
   * 未注入时该端点返回 503（服务端未装配数据源，壳侧应退回 probe reachable 语义）。
   * 抛错按 500 处理，不吞进零值——假零会让前台服务漏报"有任务完成"。
   */
  pendingSummarySource?: () => Promise<{
    pendingInteractions: number;
    runningTasks: number;
    completedUnread: number;
    /** 最近一条挂起交互的脱敏摘要（可选）；无挂起或取不到时整体缺席。 */
    pendingDigest?: { kind: "permission" | "userInput"; text: string };
  }>;
  /**
   * /api/me/files/download 允许下载的工作区根目录集合。由 http.ts 装配层注入
   * （resolveServerWorkspaces 的路径 + 会话后台目录）；未注入时下载端点 503。
   * 校验在端点内做：realpath 解析（防 symlink 逃逸）后必须落在任一根内。
   */
  workspaceRootsProvider?: () => string[];
  /**
   * /api/me/preview/proxy 开关：默认启用（回环-only 防线内建于端点）；
   * 显式传 false 可关闭（例如未来纯桌面装配不需要）。
   */
  previewProxyEnabled?: boolean;
  /**
   * /api/me/usage-summary 数据源。由 http.ts 装配层注入；
   * 未注入时端点 503。返回值形状即端点 200 body（见 spec 追加节）。
   * 抛错按 500 处理——用量页假零比 500 更误导（用户会以为今天没跑任务）。
   */
  usageSummarySource?: () => Promise<{
    todayTokens: number;
    todayRequests: number;
    rpm: number;
    tpm: number;
    hourly24h: Array<{ hourISO: string; tokens: number }>;
    generatedAt: number;
  }>;
  /**
   * CSRF 强制开关：缺省按 env ZCODE_CSRF_ENFORCE 判定，
   * env 缺省 = 强制（undefined/"1"/"true"/其它非关闭值都强制）。测试用显式
   * 参数固定语义，不依赖进程 env。仅影响 middleware 的保护面校验；
   * /api/me 通道的 CSRF 强制不受此开关影响（它本就独立强制）。
   */
  csrfEnforce?: boolean;
}

export interface DeviceCredentialAuth {
  /** 公开路由（配对/renew/probe/管理端点），必须在保护中间件之前挂载。 */
  routes: Hono;
  /** /api/me/* 设备自助管理通道（自带会话校验 + CSRF 强制 + 临时设备 403）。
   * 必须在保护中间件**之后**挂载：app.use("*", auth.middleware) 后 app.route("/", auth.meRoutes)。 */
  meRoutes: Hono;
  /** 会话 Cookie + CSRF 保护面（/api/* 与 /ws*），含失效自愈。 */
  middleware: MiddlewareHandler;
  wsGuard: {
    /** 会话是否有效（未过期且所属设备存在未过期；逐次重查注册表）。 */
    assertValid: (sessionToken: string) => boolean;
    /** 注册活跃 WS；撤销设备时被 close（不变量4）。返回解绑函数。 */
    registerSocket: (sessionToken: string, socket: GuardSocket) => () => void;
  };
  /** 从请求 Cookie 取会话 token（长期凭据绝不进 URL/Cookie 之外的通道，不变量2）。 */
  sessionTokenFromContext: (c: Context) => string | null;
  /** 会话当前是否有效（纯查询，无副作用）。 */
  isAuthenticatedRequest: (c: Context) => boolean;
  /**
   * SPA 入口页判定（自愈机制）：会话有效 → true；会话失效但请求带续期
   * Cookie 且设备健在 → 换发新会话（Set-Cookie 已写入响应）→ true；否则 false（跳配对页）。
   */
  admitOrRenew: (c: Context) => Promise<boolean>;
  /**
   * WS 升级 Origin 白名单判定：Origin 与请求同源（或缺失=非浏览器
   * 客户端，见模块级 isWsOriginAllowed 注释）→ true；否则 http.ts 拒绝升级（403）。
   */
  isWsOriginAllowed: (c: Context) => boolean;
  /** 停止周期任务并等待挂起写链排空（测试 fixture 清理 / 优雅关闭用）。 */
  dispose: () => Promise<void>;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 比较在摘要层做，长度不等直接 false，等长才走常量时间。 */
function digestEquals(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** token 形态：43 字符 base64url（randomBytes(32)），壳端正则按此写死。 */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function normalizeLabel(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 64) : "";
}

/** 目录包含判定（与 http.ts resolveStaticFile 同语义；realpath 之后调用）。 */
function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

/** 回环地址判定（v4 127.0.0.0/8 + v6 ::1；node:net isIP 分类）。 */
function isLoopbackIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a] = address.split(".").map(Number);
    return a === 127;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower === "[::1]";
  }
  return false;
}

/* ---------- WS 升级 Origin 白名单（CSWSH 主防线）----------
 * OWASP WebSocket CS：浏览器握手必带 Origin 且页面 JS 不可伪造，握手校验白名单
 * 是跨站 WebSocket 劫持（CSWSH）的主防线；SameSite=Strict 只是补充。
 *
 * 「缺失 Origin 放行」的判定依据：
 * - 浏览器（CSWSH 的唯一威胁载体）发出的 WebSocket 握手**恒带** Origin，
 *   且任何页面脚本都无法删除/篡改它——"带 Origin 但不在白名单"才是攻击形态；
 * - 缺失 Origin 的是非浏览器客户端（本机工具/CLI/测试台）：它们的 Cookie 获取
 *   与 Origin 无关，会话 Cookie 本身 + SameSite=Strict + 逐请求重查注册表
 *   仍是闸门。拒绝缺失会误杀本机/CLI 合法客户端，而不构成新的绕过口
 *   （攻击者若能种 Cookie，已经能直接调 API，不需要 WS）。
 * - Origin 头非法（不能 URL 解析）→ 拒（fail closed）。
 *
 * 默认判定是「同源」而非硬编码站点名：Origin 的 host:port 必须等于本次请求的
 * Host（ZCODE_TRUST_PROXY=1 时改用 X-Forwarded-Host / X-Forwarded-Proto——这两个头
 * 默认可被客户端伪造，只有部署方确认反代已显式覆盖后才允许信任，见
 * isTrustedProxyEnabled 注释）。这样任何自部署无需改源码，仓库里也不出现具体部署
 * 的域名。显式例外只留本机调试入口（localhost / 127.0.0.1 及 dev 端口 5173、
 * 服务端口 3030）；跨域部署用 env ZCODE_WS_ALLOWED_ORIGINS（逗号分隔）追加。 */

/** 回环 host 名（任意端口都算本机调试入口；这属于"非浏览器同机工具"的等价面，
 * 与"缺失 Origin 放行"同一理由——回环请求不经过公网，Cookie 也不对回环域外发）。 */
const WS_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** 本机调试的显式例外端口（vite dev 5173 / 服务端口 3030；其它端口走同源判定）。 */
const WS_LOOPBACK_PORTS: ReadonlySet<string> = new Set(["5173", "3030"]);

/** env 追加白名单（跨域部署用）：逗号分隔 origin，去尾斜杠；每次读取现解析
 * （判定在握手时点调用，频度极低，不做缓存）。 */
function wsExtraAllowedOrigins(): ReadonlySet<string> {
  const extra = process.env["ZCODE_WS_ALLOWED_ORIGINS"] ?? "";
  return new Set(
    extra
      .split(",")
      .map((value) => value.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

/** 请求视角的 host:port 与 scheme。反代头（X-Forwarded-Host/Proto）**只在显式开启
 * ZCODE_TRUST_PROXY 时才参与**：这两个头默认会被 nginx
 * 原样透传，客户端可伪造——默认不信意味着即使反代侧漏配 `proxy_set_header`，
 * 伪造头也拿不到同源判定。开启条件：部署方确认反代已显式覆盖这两个头（见
 * deploy/nginx-zcode.conf 的自检清单）后设 ZCODE_TRUST_PROXY=1。 */
function isTrustedProxyEnabled(): boolean {
  const raw = process.env["ZCODE_TRUST_PROXY"]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

function requestAuthority(req: {
  header: (name: string) => string | undefined;
}): { hostPort: string; scheme: string } {
  const trustProxy = isTrustedProxyEnabled();
  const forwardedHost = trustProxy
    ? req.header("x-forwarded-host")?.split(",")[0]?.trim()
    : undefined;
  const hostHeader = req.header("host")?.trim();
  const forwardedProto = trustProxy
    ? req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase()
    : undefined;
  const scheme = forwardedProto || "http";
  return { hostPort: (forwardedHost || hostHeader || "").toLowerCase(), scheme };
}

/** host:port 归一：补 scheme 的默认端口语义（80/443 视为无端口），便于比较。 */
function normalizeAuthorityForCompare(authority: string, scheme: string): string {
  const defaultPort = scheme === "https" ? "443" : "80";
  const lastColon = authority.lastIndexOf(":");
  // IPv6 字面量（多个冒号）不在此拆端口——同源比较按字符串整体进行足够，
  // IPv6 反代场景由 X-Forwarded-Host 与 Origin 两侧同形保证可比。
  if (lastColon > authority.lastIndexOf("]")) {
    const port = authority.slice(lastColon + 1);
    if (port === defaultPort) {
      return authority.slice(0, lastColon);
    }
  }
  return authority;
}

/** 单侧 origin/authority 是否等于请求自身（同源），或命中 env 追加白名单。 */
function originMatchesRequest(originUrl: URL, requestHostPort: string): boolean {
  const originScheme = originUrl.protocol.replace(":", "");
  const originAuthority = normalizeAuthorityForCompare(originUrl.host.toLowerCase(), originScheme);
  if (originAuthority === requestHostPort) {
    return true;
  }
  return wsExtraAllowedOrigins().has(originUrl.origin);
}

/**
 * WS 升级 Origin 判定（纯函数，单测直接覆盖）：
 * - 无 Origin/Referer（非浏览器客户端）→ true（理由见上方模块注释）；
 * - Origin 与请求同源（host:port 相等，scheme 由 X-Forwarded-Proto 推导参与
 *   默认端口归一；scheme 不同本身经由端口/归一差异体现——http vs https 默认
 *   端口不同即不同 authority）→ true；
 * - Origin host 是回环名（localhost/127.0.0.1/[::1]）且端口属调试端口集 → true
 *   （本机调试例外；任意端口都放行的只有"请求本身就是回环"的同源路径）；
 * - Origin 在 env 追加白名单 → true；
 * - 其余（跨站 origin / 非法 origin）→ false（拒绝升级）。
 * Referer 只在 Origin 缺席时作次级证据：老 WebView 可能只带 Referer——
 * 取其 origin 部分参与同一判定。
 */
export function isWsOriginAllowed(
  req: { header: (name: string) => string | undefined },
  originHeader: string | undefined,
  refererHeader?: string,
): boolean {
  const requestAuthorityParts = requestAuthority(req);
  const requestHostPort = normalizeAuthorityForCompare(
    requestAuthorityParts.hostPort,
    requestAuthorityParts.scheme,
  );
  const candidate = originHeader?.trim() || refererHeader?.trim() || "";
  if (!candidate) {
    return true; // 两头都缺：非浏览器客户端，放行（会话校验照旧）
  }
  let originUrl: URL;
  try {
    originUrl = new URL(candidate);
  } catch {
    return false; // Origin/Referer 存在但非法：fail closed
  }
  const originHost = originUrl.hostname.toLowerCase();
  const originPort = originUrl.port || (originUrl.protocol === "https:" ? "443" : "80");
  // 回环调试例外：浏览器/工具在本机对 localhost 调试时 Origin 与 Host 都是回环，
  // 已被同源判定覆盖；这里放的是"Origin 是回环而请求视角 host 不同"的残余形态
  // （如本机工具经反代头干扰）。端口限定调试端口集，不给任意回环端口开门。
  if (WS_LOOPBACK_HOSTS.has(originHost) && WS_LOOPBACK_PORTS.has(originPort)) {
    return true;
  }
  return originMatchesRequest(originUrl, requestHostPort);
}

/** 预览端点的扩展名 Content-Type（白名单；未知一律 octet-stream，nosniff 兜底）。 */
function previewContentType(lowerPath: string): string {
  for (const [ext, mime] of PREVIEW_MIME_TYPES) {
    if (lowerPath.endsWith(ext)) return mime;
  }
  return "application/octet-stream";
}

const PREVIEW_MIME_TYPES: ReadonlyArray<readonly [string, string]> = [
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/plain; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".wasm", "application/wasm"],
];

/**
 * hostname 是否解析到回环（SSRF 防线 2）。IPv4/IPv6 字面量直接判定；
 * 域名经 DNS 解析，任一解析结果非回环即拒绝（fail closed）。
 */
async function isLoopbackHost(hostname: string): Promise<boolean> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) {
    return true;
  }
  if (isIP(bare) !== 0) {
    return isLoopbackIp(bare);
  }
  const records = await dnsLookup(bare, { all: true, verbatim: true });
  return records.length > 0 && records.every((record) => isLoopbackIp(record.address));
}

/** 给上游 ReadableStream 套字节上限；读满上限即取消上游（无界流防御）。 */
function limitStream(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  if (!body) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  }
  let served = 0;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (served >= maxBytes) {
        await reader.cancel();
        controller.close();
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      served += value.byteLength;
      if (served > maxBytes) {
        await reader.cancel();
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      void reader.cancel().catch(() => undefined);
    },
  });
}

interface IncomingEnv {
  incoming?: { socket?: { remoteAddress?: string | null } };
}

function clientIpFrom(c: Context): string {
  const header = c.req.header("x-real-ip");
  if (header?.trim()) {
    return header.trim();
  }
  const socketAddr = (c.env as IncomingEnv | undefined)?.incoming?.socket?.remoteAddress;
  return socketAddr?.trim() || "unknown";
}

/** 读取 JSON body 并强制 16KiB 上限（null = 超限）。 */
async function readJsonBody(c: Context): Promise<Record<string, unknown> | null> {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 限流器工厂：redeem / renew / probe 三件套独立计数。 */
/* 限流器工厂的 key 表上限：公网环境 key（源 IP）由攻击者控制，无上限的 Map 会被
 * "换 IP 刷一次就消失"的流量撑大。4096 个 key 足以覆盖正常 NAT 出口与扫描噪声；
 * 对齐 dsh-mobile BoundedRateLimiter 的 fail-closed 思路并放宽到公网规模。 */
const RATE_LIMITER_MAX_KEYS = 4096;
/** 周期性全表清扫间隔（调用次数计）：过期 key 只在同 IP 复访时惰性清理不够——
 * "来过一次就消失"的 IP 会占住 key 表；每 64 次调用顺带清一轮过期 key。 */
const RATE_LIMITER_SWEEP_INTERVAL_CALLS = 64;

/**
 * 限流器工厂：redeem / renew / probe / download / preview 各自独立计数。
 * key 表有界（RATE_LIMITER_MAX_KEYS）：满时拒绝**新** key（fail-closed，对齐 dsh-mobile），
 * 已有 key 的计数不受影响。
 * 误伤说明：若 4096 个不同源 IP 在窗口内真实竞争（超大 NAT 出口 + 攻击流量同时存在），
 * 第 4097 个新 IP 会被直接拒绝直到老 key 过期。单人自部署的正常流量远达不到该量级，
 * 宁可对极端 NAT 池 fail-closed 也不给攻击者无界内存。
 * 导出仅供单测（meExtendedEndpoints.test.ts 的 key 上限用例）；生产路径全部走闭包实例。
 */
export function makeRateLimiter(windowMs: number, max: number) {
  const attempts = new Map<string, number[]>();
  let callsSinceSweep = 0;
  /** 全表清扫：删掉窗口内没有任何时间戳的 key（惰性清理的补充，防"一次性 IP"占位）。 */
  function sweepExpired(t: number): void {
    for (const [key, timestamps] of attempts) {
      const recent = timestamps.filter((ts) => t - ts < windowMs);
      if (recent.length === 0) {
        attempts.delete(key);
      } else if (recent.length !== timestamps.length) {
        attempts.set(key, recent);
      }
    }
  }
  return {
    limited(ip: string): boolean {
      const t = Date.now();
      if (++callsSinceSweep >= RATE_LIMITER_SWEEP_INTERVAL_CALLS) {
        callsSinceSweep = 0;
        sweepExpired(t);
      }
      const existing = attempts.get(ip);
      if (existing === undefined) {
        // 表满时不再接纳新 key（与 hit 的 fail-closed 同判）——否则攻击者只打
        // limited()（不发正式请求）也能以 set 速度 > 清扫速度撑大表（实测 10 万 IP
        // 峰值 65536+ key）。无记录 key 按"无历史"判定：recent.length(0) >= max
        // 为 false，即放行本轮；该 IP 真正发出请求时 hit() 会再次尝试接纳。
        if (attempts.size >= RATE_LIMITER_MAX_KEYS) {
          return false;
        }
        attempts.set(ip, []);
        return false;
      }
      const recent = existing.filter((ts) => t - ts < windowMs);
      attempts.set(ip, recent);
      return recent.length >= max;
    },
    hit(ip: string): void {
      const t = Date.now();
      if (attempts.has(ip)) {
        const recent = attempts.get(ip)!.filter((ts) => t - ts < windowMs);
        recent.push(t);
        attempts.set(ip, recent);
        return;
      }
      // 新 key：表满时 fail-closed（拒绝接纳，本次 hit 丢弃——limited() 已先返回 true，
      // 正常调用序 limited→hit 下这里只发生在攻击流量侧）。先清扫一轮再判，过期 key
      // 腾位后新 key 仍可正常接纳。
      if (attempts.size >= RATE_LIMITER_MAX_KEYS) {
        sweepExpired(t);
        if (attempts.size >= RATE_LIMITER_MAX_KEYS) {
          return;
        }
      }
      attempts.set(ip, [t]);
    },
    /** 测试观测：当前 key 表大小。 */
    size(): number {
      return attempts.size;
    },
  };
}

export async function createDeviceCredentialAuth(
  options: DeviceCredentialAuthOptions,
): Promise<DeviceCredentialAuth> {
  const dataBaseDir = options.dataBaseDir;
  const registryDir = join(dataBaseDir, ".zcode");
  const registryPath = join(registryDir, "devices.json");
  const registryTmpPath = `${registryPath}.tmp`;
  // 会话持久化（续期是服务端的职责）：重启不再强制全端重配对。
  // 与 devices.json 同目录、同一套原子写模式；磁盘上只有摘要（key/csrfDigest），不变量1 不变。
  const sessionsPath = join(registryDir, "sessions.json");
  const sessionsTmpPath = `${sessionsPath}.tmp`;
  // 密钥路径 deploy 侧通过 env 指定，运行时读取，值不由服务端管理。
  const adminSecretPath =
    options.adminSecretPath?.trim() ||
    process.env["ZCODE_ADMIN_SECRET_FILE"]?.trim() ||
    DEFAULT_ADMIN_SECRET_PATH;
  const now = options.now ?? Date.now;
  const pendingSummarySource = options.pendingSummarySource;
  const usageSummarySource = options.usageSummarySource;
  const workspaceRootsProvider = options.workspaceRootsProvider;
  const isPreviewProxyEnabled = options.previewProxyEnabled !== false;
  // CSRF 强制：显式参数 > env > 默认强制。关闭值见
  // CSRF_ENFORCE_OFF_VALUES 注释——这是一键回退开关，不是常驻配置面。
  const csrfEnforce =
    options.csrfEnforce ??
    (() => {
      const raw = process.env["ZCODE_CSRF_ENFORCE"]?.trim().toLowerCase();
      return !(raw !== undefined && CSRF_ENFORCE_OFF_VALUES.has(raw));
    })();

  /* 启用条件（不允许裸奔）：有管理密钥或已有设备注册表，二者必居其一；
   * 都没有说明部署缺了引导步骤，直接启动失败而不是无鉴权监听。 */
  if (!existsSync(adminSecretPath) && !existsSync(registryPath)) {
    throw new Error(
      `[device-credential-auth] 拒绝启动：既无管理密钥（${adminSecretPath}）也无设备注册表（${registryPath}）。` +
        `请以 root 创建 /etc/zcode/zcode-admin.secret（600）后重启；设备凭据鉴权恒开，无"关闭"开关。`,
    );
  }

  const store: DeviceStoreFile = { version: 1, instanceId: "", devices: [] };
  // 原子写 = tmp(wx, 0600) + 末尾换行 + rename；写入前再查符号链接。
  // 链式声明必须在 loadRegistry() 之前：首次创建/补 instanceId 时会立即落盘。
  let writeChain: Promise<void> = Promise.resolve();
  await loadRegistry();
  // 注意：loadSessions() 的调用在下方 sessions 段声明之后（函数体引用 const sessions，
  // 必须避开 TDZ）。

  /** 加载时拒符号链接、限 1MiB、chmod 600 自愈；缺失视为空表。 */
  async function loadRegistry(): Promise<void> {
    let info;
    try {
      info = await lstat(registryPath); // lstat：符号链接在此暴露
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        store.instanceId = randomBytes(32).toString("hex");
        await persistDevices(); // 首次创建：固化 instanceId 与空表
        return;
      }
      throw err;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`[device-credential-auth] devices.json 是符号链接，拒绝加载（防写入逃逸）`);
    }
    if (info.size > MAX_REGISTRY_BYTES) {
      throw new Error(
        `[device-credential-auth] devices.json 超过 ${MAX_REGISTRY_BYTES} 字节上限，拒绝加载`,
      );
    }
    const raw = await readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DeviceStoreFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.devices)) {
      throw new Error(
        `[device-credential-auth] devices.json 结构非法（version=${String(parsed.version)}）`,
      );
    }
    for (const entry of parsed.devices) {
      if (typeof entry?.id !== "string" || typeof entry?.tokenDigest !== "string") {
        continue;
      }
      store.devices.push({
        id: entry.id,
        label: typeof entry.label === "string" ? entry.label.slice(0, 64) : "未命名设备",
        tokenDigest: entry.tokenDigest,
        createdAt: Number(entry.createdAt) || 0,
        expiresAt: Number(entry.expiresAt) || 0,
        lastSeenAt: Number(entry.lastSeenAt) || 0,
        // 老记录（temporary 字段出现之前）缺省 false：正式设备语义。
        temporary: entry.temporary === true,
      });
    }
    // instanceId 固化在文件顶层；旧结构缺失时补生成并回写。
    if (typeof parsed.instanceId === "string" && /^[0-9a-f]{64}$/.test(parsed.instanceId)) {
      store.instanceId = parsed.instanceId;
    } else {
      store.instanceId = randomBytes(32).toString("hex");
      await persistDevices();
    }
    // 权限自愈（历史文件可能不是 600）。
    if ((info.mode & 0o777) !== 0o600) {
      await chmod(registryPath, 0o600);
    }
  }

  /* 原子写 = tmp(wx, 0600) + 末尾换行 + rename；写入前再查符号链接。 */
  async function persistDevicesLocked(): Promise<void> {
    const target = await lstat(registryPath).catch(() => null);
    if (target?.isSymbolicLink()) {
      throw new Error(`[device-credential-auth] devices.json 是符号链接，拒绝覆盖`);
    }
    await mkdir(registryDir, { recursive: true });
    await rm(registryTmpPath, { force: true });
    const handle = await open(registryTmpPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(store)}\n`, { encoding: "utf8" });
    } finally {
      await handle.close();
    }
    await rename(registryTmpPath, registryPath);
  }
  function persistDevices(): Promise<void> {
    writeChain = writeChain.then(persistDevicesLocked, persistDevicesLocked);
    return writeChain;
  }

  let lastFlushAt = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  /** 已鉴权请求的 lastSeenAt 触碰用去抖落盘（观测数据，进程退出丢最后几秒可接受）。 */
  function scheduleTouchPersist(): void {
    const t = now();
    if (t - lastFlushAt >= TOUCH_DEBOUNCE_MS) {
      lastFlushAt = t;
      void persistDevices().catch((err: unknown) => {
        console.error("[device-credential-auth] devices.json 写入失败", err);
      });
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        lastFlushAt = now();
        void persistDevices().catch((err: unknown) => {
          console.error("[device-credential-auth] devices.json 写入失败", err);
        });
      }, TOUCH_DEBOUNCE_MS);
      flushTimer.unref?.();
    }
  }

  /* ---------- 短期会话（持久化 sessions.json；重启后凭摘要恢复）----------
   * key: sha256(sessionToken)。磁盘文件同构（SessionRecordFile）：只有摘要，
   * 明文 token 永不落盘（不变量1）。恢复的会话 csrfDigest 照旧参与 CSRF 校验。 */
  const sessions = new Map<string, DeviceSessionRecord>(); // key: sha256(sessionToken)

  // 会话恢复：文件缺失 = 空表；结构非法抛错拒启；加载时过滤已过期会话。
  // （放在 sessions 声明之后、注册表已加载完毕，此处 store.devices 已就绪。）
  await loadSessions();

  /** 会话落盘走同一条 writeChain（与 devices.json 串行，避免并发交错 rename）。 */
  function persistSessions(): Promise<void> {
    writeChain = writeChain.then(persistSessionsLocked, persistSessionsLocked);
    return writeChain;
  }

  /* 同款原子写：tmp(wx, 0600) + 末尾换行 + rename；写入前拒符号链接；1MiB 上限。 */
  async function persistSessionsLocked(): Promise<void> {
    const payload: SessionRecordFile = {
      version: 1,
      sessions: [...sessions.entries()].map(([key, session]) => ({
        key,
        deviceId: session.deviceId,
        csrfDigest: session.csrfDigest,
        expiresAt: session.expiresAt,
      })),
    };
    const target = await lstat(sessionsPath).catch(() => null);
    if (target?.isSymbolicLink()) {
      throw new Error(`[device-credential-auth] sessions.json 是符号链接，拒绝覆盖`);
    }
    await mkdir(registryDir, { recursive: true });
    await rm(sessionsTmpPath, { force: true });
    const handle = await open(sessionsTmpPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(payload)}\n`, { encoding: "utf8" });
    } finally {
      await handle.close();
    }
    await rename(sessionsTmpPath, sessionsPath);
  }

  /** 启动加载：文件缺失 = 空表（不报错）；结构非法抛错拒启（与 devices.json 一致 fail-closed）；过期会话不恢复。 */
  async function loadSessions(): Promise<void> {
    let info;
    try {
      info = await lstat(sessionsPath); // lstat：符号链接在此暴露
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return; // 首次启动 / 从未产生会话：空表即可
      }
      throw err;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`[device-credential-auth] sessions.json 是符号链接，拒绝加载（防写入逃逸）`);
    }
    if (info.size > MAX_REGISTRY_BYTES) {
      throw new Error(
        `[device-credential-auth] sessions.json 超过 ${MAX_REGISTRY_BYTES} 字节上限，拒绝加载`,
      );
    }
    const raw = await readFile(sessionsPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionRecordFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
      throw new Error(
        `[device-credential-auth] sessions.json 结构非法（version=${String(parsed.version)}）`,
      );
    }
    const t = now();
    for (const entry of parsed.sessions) {
      if (
        typeof entry?.key !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.key) ||
        typeof entry?.deviceId !== "string" ||
        typeof entry?.csrfDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.csrfDigest)
      ) {
        continue; // 单条畸形：跳过而不是拒启（会话是易失数据，宁缺毋错）
      }
      const expiresAt = Number(entry.expiresAt) || 0;
      if (expiresAt <= t) {
        continue; // 加载时过滤已过期会话
      }
      sessions.set(entry.key, { deviceId: entry.deviceId, csrfDigest: entry.csrfDigest, expiresAt });
    }
    // 权限自愈（历史文件可能不是 600）。
    if ((info.mode & 0o777) !== 0o600) {
      await chmod(sessionsPath, 0o600);
    }
  }

  /**
   * 清过期会话。删除记录的同时关闭其活跃 WS——否则过期会话的
   * socket 会活到连接自然断（撤销"即时生效"在过期场景漏风）。
   * 返回是否有删除，供周期任务判断是否需要落盘。
   */
  function pruneSessions(): boolean {
    const t = now();
    let removed = false;
    for (const [key, session] of sessions) {
      if (session.expiresAt <= t) {
        sessions.delete(key);
        removed = true;
        closeSocketsForKey(key);
      }
    }
    return removed;
  }

  /** 关闭某个会话 key 名下的全部 WS 并摘除注册表项（killDeviceSessions 的单 key 版）。 */
  function closeSocketsForKey(key: string): void {
    const set = wsRegistry.get(key);
    if (!set) {
      return;
    }
    for (const socket of set) {
      try {
        socket.close(WS_REVOKE_CLOSE_CODE, "session expired");
      } catch {
        // 关闭失败不影响清理语义（连接随后会被对端/心跳清理）
      }
    }
    wsRegistry.delete(key);
  }

  /** 每设备会话上限与最旧淘汰（多标签/壳共存后防内存膨胀）。
   * 被淘汰会话的活跃 WS 同步 close(4401)——记录死了 socket 不能还活着，
   * 否则 MAX_SESSIONS_PER_DEVICE 触发后 killDeviceSessions 找不到它们，撤销即时性破洞。 */
  const MAX_SESSIONS_PER_DEVICE = 16;
  function evictOldestSessions(deviceId: string): void {
    const owned: Array<{ key: string; expiresAt: number }> = [];
    for (const [key, session] of sessions) {
      if (session.deviceId === deviceId) {
        owned.push({ key, expiresAt: session.expiresAt });
      }
    }
    if (owned.length < MAX_SESSIONS_PER_DEVICE) {
      return;
    }
    owned.sort((a, b) => a.expiresAt - b.expiresAt);
    for (const entry of owned.slice(0, owned.length - MAX_SESSIONS_PER_DEVICE + 1)) {
      sessions.delete(entry.key);
      closeSocketsForKey(entry.key);
    }
    void persistSessions().catch((err: unknown) => {
      console.error("[device-credential-auth] sessions.json 写入失败", err);
    });
  }

  /** 会话寿命封顶于设备寿命；key/csrf 均以摘要入内存。创建后同步落盘。 */
  function createSession(device: DeviceRecord): {
    sessionToken: string;
    csrfToken: string;
    expiresAt: number;
  } {
    pruneSessions();
    evictOldestSessions(device.id);
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const expiresAt = Math.min(now() + SESSION_TTL_MS, device.expiresAt);
    sessions.set(sha256Hex(sessionToken), {
      deviceId: device.id,
      csrfDigest: sha256Hex(csrfToken),
      expiresAt,
    });
    void persistSessions().catch((err: unknown) => {
      console.error("[device-credential-auth] sessions.json 写入失败", err);
    });
    return { sessionToken, csrfToken, expiresAt };
  }

  // 每 6h 顺带清一次过期会话；有删除才落盘（无变化时写盘纯属磨损）。
  const sessionPruneTimer: NodeJS.Timeout = setInterval(() => {
    if (pruneSessions()) {
      void persistSessions().catch((err: unknown) => {
        console.error("[device-credential-auth] sessions.json 写入失败", err);
      });
    }
  }, SESSION_PRUNE_INTERVAL_MS);
  sessionPruneTimer.unref?.();

  function findDeviceByToken(deviceToken: string): DeviceRecord | undefined {
    const digest = sha256Hex(String(deviceToken ?? ""));
    const t = now();
    return store.devices.find((d) => d.expiresAt > t && digestEquals(d.tokenDigest, digest));
  }

  /**
   * 每次校验都重查注册表——撤销/过期即时生效的机制保证。
   * 检查顺序保证错误码可区分（壳靠它切换 UI）：
   * 记录不存在 → authentication_failed；设备已删 → device_revoked；
   * 设备已过期 → device_expired；设备健在但会话到期 → authentication_failed。
   * 会话记录不因撤销/失败而删除（设备已从注册表移除，记录永不可用，
   * 由 expiresAt 自然清理）——否则首查之后错误码退化为 authentication_failed。
   */
  function resolveSession(
    sessionToken: string,
  ):
    | { ok: true; session: DeviceSessionRecord; device: DeviceRecord }
    | { ok: false; code: ErrorCode } {
    const record = sessions.get(sha256Hex(sessionToken));
    if (!record) {
      return { ok: false, code: "authentication_failed" };
    }
    const device = store.devices.find((d) => d.id === record.deviceId);
    if (!device) {
      return { ok: false, code: "device_revoked" }; // 会话在、注册表无此设备 = 已被撤销
    }
    if (device.expiresAt <= now()) {
      return { ok: false, code: "device_expired" };
    }
    if (record.expiresAt <= now()) {
      return { ok: false, code: "authentication_failed" }; // 设备健在，只是会话到期
    }
    return { ok: true, session: record, device };
  }

  /* ---------- WS 撤销注册表：sha256(sessionToken) → sockets ---------- */
  const wsRegistry = new Map<string, Set<GuardSocket>>();

  function registerSocket(sessionToken: string, socket: GuardSocket): () => void {
    const key = sha256Hex(sessionToken);
    let set = wsRegistry.get(key);
    if (!set) {
      set = new Set();
      wsRegistry.set(key, set);
    }
    set.add(socket);
    const detach = () => {
      set?.delete(socket);
      if (set && set.size === 0) {
        wsRegistry.delete(key);
      }
    };
    socket.on("close", detach);
    socket.on("error", detach);
    let unregistered = false;
    return () => {
      if (!unregistered) {
        unregistered = true;
        detach();
      }
    };
  }

  /**
   * 撤销即时生效（不变量4）：按会话 key 关闭该设备全部 WS。
   * 会话持久化后：撤销时从内存 + sessions.json 一并移除该设备全部会话
   * （removeSessionsForDevice），WS 关闭放在最后一步——前面任何一步抛错也不漏杀 socket。
   * resolveSession 的 device_revoked 分支仍保留：重启恢复的会话若其设备已不在注册表
   * （崩溃发生在 devices.json 落盘后、sessions.json 清理前），恢复后仍判 device_revoked。
   */
  function killDeviceSessions(keys: Iterable<string>): void {
    for (const key of keys) {
      const set = wsRegistry.get(key);
      if (set) {
        for (const socket of set) {
          try {
            socket.close(WS_REVOKE_CLOSE_CODE, "device revoked");
          } catch {
            // 关闭失败不影响撤销语义（连接随后会被对端/心跳清理）
          }
        }
        wsRegistry.delete(key);
      }
    }
  }

  /**
   * 撤销路径的会话清理：从内存移除该设备全部会话并落盘 sessions.json，
   * 返回受影响的会话 key 列表（供随后的 killDeviceSessions 关闭 WS）。
   * 注意：不在此处关 socket——调用方保证 WS 关闭是最后一步（顺序要求：先落盘，
   * 再清会话，再杀 WS；顺序不可反）。
   */
  async function removeSessionsForDevice(deviceId: string): Promise<string[]> {
    const affected: string[] = [];
    for (const [key, session] of sessions) {
      if (session.deviceId === deviceId) {
        affected.push(key);
        sessions.delete(key);
      }
    }
    if (affected.length > 0) {
      await persistSessions();
    }
    return affected;
  }

  /* ---------- 配对码（只存摘要，10 分钟、单次、全局单窗口）---------- */
  const pairingCodes: PairingCode[] = [];

  function prunePairingCodes(): void {
    const t = now();
    for (let i = pairingCodes.length - 1; i >= 0; i--) {
      if (pairingCodes[i]!.expiresAt <= t) {
        pairingCodes.splice(i, 1);
      }
    }
  }

  function consumePairingCode(input: string): PairingCode | null {
    prunePairingCodes();
    const digest = sha256Hex(String(input ?? ""));
    for (let i = 0; i < pairingCodes.length; i++) {
      const entry = pairingCodes[i]!;
      if (digestEquals(entry.digest.toString("hex"), digest)) {
        pairingCodes.splice(i, 1); // 单次使用：命中即焚
        return entry;
      }
    }
    return null;
  }

  /* ---------- Cookie（四件套：普通名 + __Host- 变体）----------
   * 用 hono/cookie 的 setCookie：多个 Set-Cookie 必须各自 append（c.header 会互相覆盖）。
   * __Host- 前缀要求 Secure + Path=/ + 无 Domain，参数天然满足。 */

  function setSessionCookies(
    c: Context,
    session: { sessionToken: string; csrfToken: string; expiresAt: number },
  ): void {
    const maxAge = Math.max(1, Math.floor((session.expiresAt - now()) / 1000));
    for (const name of [SESSION_COOKIE_NAME, SESSION_COOKIE_HOST_NAME]) {
      setCookie(c, name, session.sessionToken, {
        path: "/",
        secure: true,
        sameSite: "Strict",
        httpOnly: true,
        maxAge,
      });
    }
    for (const name of [CSRF_COOKIE_NAME, CSRF_COOKIE_HOST_NAME]) {
      // CSRF cookie 非 HttpOnly：页面 JS 需读取后回填 x-zcode-csrf 头。
      setCookie(c, name, session.csrfToken, {
        path: "/",
        secure: true,
        sameSite: "Strict",
        maxAge,
      });
    }
  }

  function clearSessionCookies(c: Context): void {
    for (const name of [SESSION_COOKIE_NAME, SESSION_COOKIE_HOST_NAME]) {
      setCookie(c, name, "", {
        path: "/",
        secure: true,
        sameSite: "Strict",
        httpOnly: true,
        maxAge: 0,
      });
    }
    for (const name of [CSRF_COOKIE_NAME, CSRF_COOKIE_HOST_NAME]) {
      setCookie(c, name, "", { path: "/", secure: true, sameSite: "Strict", maxAge: 0 });
    }
  }

  /* ---------- 管理端点双闸（本机 socket + admin secret，缺一 403）---------- */

  function isLoopbackAddress(value: string): boolean {
    return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
  }

  function isAdminSourceLocal(c: Context): boolean {
    const socketAddr = (c.env as IncomingEnv | undefined)?.incoming?.socket?.remoteAddress;
    const realIp = c.req.header("x-real-ip")?.trim();
    if (socketAddr != null && socketAddr !== "") {
      // 有 socket 事实（一切真实请求）：非回环直接拒；nginx 经回环转发但
      // x-real-ip 声明外部来源也拒（不变量5：拒绝网络来源，含经 nginx 的请求）。
      if (!isLoopbackAddress(socketAddr)) {
        return false;
      }
      return !realIp || isLoopbackAddress(realIp);
    }
    if (realIp) {
      // 无 socket（仅测试环境的 app.request 通道）：只信头声明的回环。
      return isLoopbackAddress(realIp);
    }
    return false; // 无法证明本机 → fail closed
  }

  async function readAdminSecret(): Promise<string | null> {
    try {
      return (await readFile(adminSecretPath, "utf8")).trim();
    } catch {
      return null; // 读失败视为无 secret（fail closed）
    }
  }

  async function requireAdmin(c: Context): Promise<Response | null> {
    if (!isAdminSourceLocal(c)) {
      return c.json({ error: "forbidden" satisfies ErrorCode }, 403);
    }
    const secret = await readAdminSecret();
    const presented = c.req.header(ADMIN_SECRET_HEADER) ?? "";
    // 密钥比较也在摘要层做常量时间比较。
    if (!secret || !digestEquals(sha256Hex(presented.trim()), sha256Hex(secret))) {
      return c.json({ error: "forbidden" satisfies ErrorCode }, 403);
    }
    return null;
  }

  /* ---------- 公开路由（挂在保护中间件之前）---------- */

  const redeemLimiter = makeRateLimiter(REDEEM_RATE_WINDOW_MS, REDEEM_RATE_MAX);
  const renewLimiter = makeRateLimiter(RENEW_RATE_WINDOW_MS, RENEW_RATE_MAX);
  const probeLimiter = makeRateLimiter(PROBE_RATE_WINDOW_MS, PROBE_RATE_MAX);

  const routes = new Hono();

  /* 配对页：零依赖单页（文案由 deploy 侧修订；fetch 指向 /api/pairing/redeem）。 */
  routes.get("/api/pairing/page", (c) => c.html(PAIRING_PAGE_HTML));

  routes.post("/api/pairing/redeem", async (c) => {
    const ip = clientIpFrom(c);
    if (redeemLimiter.limited(ip)) {
      return c.json({ error: "rate_limited" satisfies ErrorCode }, 429);
    }
    redeemLimiter.hit(ip);

    const body = await readJsonBody(c);
    if (body === null) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    const code = typeof body.code === "string" ? body.code : "";
    const entry = consumePairingCode(code);
    if (!entry) {
      // 无效/过期/复用一律同一响应（不泄露是哪一种）；验收场景期待 403。
      return c.json({ error: "authentication_failed" satisfies ErrorCode }, 403);
    }
    const label = entry.label || normalizeLabel(body.label) || "未命名设备";

    // 临时设备（需求规格）：配对码带 ttlHours（正整数 1..168）→ 兑换出的设备
    // temporary=true，expiresAt = now + ttl（忽略 90 天滑动窗口），到期自然失效。
    const t = now();
    const deviceToken = randomToken();
    const isTemporary = typeof entry.ttlHours === "number";
    const device: DeviceRecord = {
      id: randomBytes(16).toString("hex"),
      label,
      tokenDigest: sha256Hex(deviceToken), // 不变量1：磁盘只落摘要
      createdAt: t,
      expiresAt: isTemporary ? t + entry.ttlHours! * 3_600_000 : t + DEVICE_TTL_MS,
      lastSeenAt: t,
      temporary: isTemporary,
    };
    store.devices.push(device);
    await persistDevices();

    const session = createSession(device);
    setSessionCookies(c, session);
    // 续期与浏览器保活（方案 A）：浏览器配对后种一个
    // 长期 HttpOnly「续期 Cookie」（值 = deviceToken 本身，但**只允许调 renew**，
    // 不能当会话用——renew 端点接受 body 或该 Cookie 作凭据）。泄露它得到的
    // 与手机壳 Keystore 凭据同级：每设备、可单独撤销、立即失效，不等于管理员能力。
    // SameSite=Strict + HttpOnly + Secure；不进 URL、页面 JS 不可读。
    // 临时设备也种（服务端自愈依赖它）：Max-Age = 设备剩余寿命，到期 Cookie 自灭。
    setCookie(c, RENEW_COOKIE_NAME, deviceToken, {
      path: "/",
      secure: true,
      sameSite: "Strict",
      httpOnly: true,
      maxAge: Math.max(1, Math.floor((device.expiresAt - t) / 1000)),
    });
    log(`paired device ${device.id} (label=${JSON.stringify(device.label)})`);
    return c.json({
      instanceId: store.instanceId,
      deviceId: device.id,
      deviceToken, // 不变量2：长期凭据只在 POST 响应体回显一次，绝不进 URL/Cookie 之外的通道
      deviceExpiresAt: device.expiresAt,
      sessionToken: session.sessionToken,
      csrfToken: session.csrfToken,
      sessionExpiresAt: session.expiresAt,
      // 需求规格要求：手机壳原生发起 redeem/renew，
      // 响应的 Set-Cookie 到不了 WebView 的 Cookie 罐，壳需要按名字注入——
      // 响应体显式告知 Cookie 名（缺省名即本模块常量）。
      sessionCookieName: SESSION_COOKIE_NAME,
      csrfCookieName: CSRF_COOKIE_NAME,
    });
  });

  routes.post("/api/auth/renew", async (c) => {
    const ip = clientIpFrom(c);
    if (renewLimiter.limited(ip)) {
      return c.json({ error: "rate_limited" satisfies ErrorCode }, 429);
    }
    renewLimiter.hit(ip);

    const body = await readJsonBody(c);
    if (body === null) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    // 凭据来源：body.deviceToken（手机壳/显式调用）优先；缺省回退续期 Cookie
    // （方案 A：浏览器 redeem 时种下的长期 HttpOnly Cookie，只允许调 renew）。
    const deviceToken =
      typeof body.deviceToken === "string" && body.deviceToken
        ? body.deviceToken
        : (parseCookieHeader(c.req.header("cookie")).get(RENEW_COOKIE_NAME) ?? "");
    // 不保留 tombstone：未知与已撤销一律同一响应（需求规格 §5）。
    const device = findDeviceByToken(deviceToken);
    if (!device) {
      // 续期 Cookie 对应的设备已撤销/过期时顺带清掉该 Cookie（fail closed + 清理）
      if (!device && parseCookieHeader(c.req.header("cookie")).get(RENEW_COOKIE_NAME)) {
        setCookie(c, RENEW_COOKIE_NAME, "", {
          path: "/",
          secure: true,
          sameSite: "Strict",
          httpOnly: true,
          maxAge: 0,
        });
      }
      return c.json({ error: "authentication_failed" satisfies ErrorCode }, 401);
    }
    const t = now();
    device.lastSeenAt = t; // 更新 lastSeenAt 并整表落盘
    // 临时设备（需求规格）：renew 只更新 lastSeenAt + 换发会话，
    // 不顺延 expiresAt（短命设备活到自然到期）、不重发续期 Cookie（寿命只减不增）。
    if (!device.temporary) {
      // 续期与浏览器保活：滑动窗口——renew 顺延设备寿命再给
      // DEVICE_TTL_MS，绝对上限 CREATED_AT + DEVICE_TTL_ABSOLUTE_MS 兜底（365 天）。
      // 语义变为「连续 DEVICE_TTL 天不活动才失效」；手动撤销仍然即时生效。
      device.expiresAt = Math.min(t + DEVICE_TTL_MS, device.createdAt + DEVICE_TTL_ABSOLUTE_MS);
    }
    await persistDevices();
    // 多会话共存（实测修正）：同设备的多个标签页/壳各自持会话，
    // renew 轮换作废旧会话会造成互踢死循环（A renew → B 的会话作废 401 → B renew →
    // A 作废……）。改为 renew 只新增自己的会话，同设备旧会话保留至各自自然过期
    // （上限淘汰防膨胀）；设备撤销时统一失效（逐请求重查 + killDeviceSessions）。
    const session = createSession(device);
    setSessionCookies(c, session);
    if (!device.temporary) {
      // 方案 A 补丁（复核发现）：滑动窗口顺延了设备寿命，但续期 Cookie 的
      // Max-Age 还是 redeem 时的旧值——第 89 天 renew 顺延 90 天后，浏览器手里的续期
      // Cookie 只剩 1 天寿命，第 91 天 Cookie 过期 → 浏览器被迫重新配对，而设备还活着。
      // renew 成功时同步重发续期 Cookie（Max-Age = 顺延后的剩余寿命），保持"连续 90 天
      // 不活动才掉线"的语义真正成立。手机壳走 body.deviceToken 路径时该 Cookie 无意义
      //（壳不依赖浏览器 Cookie 罐），重发无害。
      setCookie(c, RENEW_COOKIE_NAME, deviceToken, {
        path: "/",
        secure: true,
        sameSite: "Strict",
        httpOnly: true,
        maxAge: Math.max(1, Math.floor((device.expiresAt - t) / 1000)),
      });
    }
    return c.json({
      instanceId: store.instanceId,
      deviceId: device.id,
      sessionToken: session.sessionToken,
      csrfToken: session.csrfToken,
      sessionExpiresAt: session.expiresAt,
    });
  });

  routes.post("/api/auth/probe", async (c) => {
    const ip = clientIpFrom(c);
    if (probeLimiter.limited(ip)) {
      return c.json({ error: "rate_limited" satisfies ErrorCode }, 429);
    }
    probeLimiter.hit(ip);

    const body = await readJsonBody(c);
    if (body === null) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    const deviceToken = typeof body.deviceToken === "string" ? body.deviceToken : "";
    const device = findDeviceByToken(deviceToken);
    if (!device) {
      return c.json({ error: "authentication_failed" satisfies ErrorCode }, 401);
    }
    device.lastSeenAt = now(); // probe 不开会话，但更新 lastSeenAt
    await persistDevices();
    // 任务计数与待回复摘要随探针捎带（壳 FGS 兜底通知用）：pending-summary 同源数据，
    // 数据源缺席（未装配）时字段整体缺席——壳按"旧服务端"处理，静默跳过差分。
    // 计数与待回复摘要查询失败不阻断 probe 主语义（连接状态），单独降级为缺席。
    // pendingInteractions = 等待用户回复的挂起数（权限确认 + 用户输入）：页面通道
    // 在 App 切后台（WebView onPause）后停摆，待回复提醒只能靠探针这条兜底。
    // pendingDigest 是最近一条挂起交互的单行脱敏摘要；无挂起或取不到时随计数一起缺席。
    let probeExtras:
      | {
          pendingInteractions: number;
          runningTasks: number;
          completedUnread: number;
          pendingDigest?: { kind: "permission" | "userInput"; text: string };
        }
      | undefined;
    if (pendingSummarySource) {
      try {
        const summary = await pendingSummarySource();
        probeExtras = {
          pendingInteractions: summary.pendingInteractions,
          runningTasks: summary.runningTasks,
          completedUnread: summary.completedUnread,
          ...(summary.pendingDigest ? { pendingDigest: summary.pendingDigest } : {}),
        };
      } catch (error) {
        log(`probe task counts unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return c.json({
      instanceId: store.instanceId,
      deviceId: device.id,
      deviceExpiresAt: device.expiresAt,
      ...(probeExtras ?? {}),
    });
  });

  /* ---------- 管理路由（双闸）---------- */

  routes.post("/api/admin/pairing-code", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) {
      return denied;
    }
    const body = await readJsonBody(c);
    if (body === null) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    const label = normalizeLabel(body.label);
    if (!label) {
      return c.json({ error: "label is required" }, 400);
    }
    // 临时设备（需求规格）：ttlHours 提供即临时码；正整数 1..168 之外一律拒绝。
    const ttlHours = parseTtlHours(body.ttlHours);
    if (ttlHours === "invalid") {
      return c.json({ error: "ttlHours must be an integer between 1 and 168" }, 400);
    }
    const created = createPairingCode(label, ttlHours);
    return c.json({
      code: created.code,
      expiresAt: created.expiresAt,
      ...(ttlHours ? { temporary: true, ttlHours } : {}),
    });
  });

  routes.get("/api/admin/devices", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) {
      return denied;
    }
    const devices = [...store.devices]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ id, label, createdAt, expiresAt, lastSeenAt, temporary }) => ({
        id,
        label,
        createdAt,
        expiresAt,
        lastSeenAt,
        temporary,
      }));
    return c.json({ devices });
  });

  routes.post("/api/admin/devices/revoke", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) {
      return denied;
    }
    const body = await readJsonBody(c);
    if (body === null) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    const id = typeof body.id === "string" ? body.id : "";
    const revokedId = await revokeDeviceById(id);
    if (!revokedId) {
      return c.json({ error: "device_not_found" }, 404);
    }
    return c.json({ ok: true, id: revokedId });
  });

  /**
   * 撤销设备（admin 与 /api/me 共用）：顺序不可反——先落盘 devices.json 删记录，
   * 再从内存 + sessions.json 移除该设备全部会话，最后关闭其全部 WS（不变量4 即时生效）。
   * 返回被撤销的 id；未知 id 返回 null（不保留 tombstone）。
   */
  async function revokeDeviceById(id: string): Promise<string | null> {
    const index = store.devices.findIndex((d) => d.id === id);
    if (index < 0) {
      return null;
    }
    const [removed] = store.devices.splice(index, 1);
    if (!removed) {
      return null; // 不可达（index 已判 >=0），类型收窄用
    }
    await persistDevices(); // 第一步：设备注册表先落盘
    const affectedKeys = await removeSessionsForDevice(removed.id); // 第二步：清会话（内存+磁盘）
    killDeviceSessions(affectedKeys); // 第三步：关 WS
    log(`revoked device ${removed.id} (label=${JSON.stringify(removed.label)})`);
    return removed.id;
  }

  /** ttlHours 解析（admin 与 /api/me 配对码共用）：缺省 null=正式设备；非法返回 "invalid"。 */
  function parseTtlHours(value: unknown): number | null | "invalid" {
    if (value === undefined) {
      return null;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 168) {
      return "invalid";
    }
    return parsed;
  }

  /** 创建配对码（admin 与 /api/me 共用；全局单窗口——新码作废全部旧码）。 */
  function createPairingCode(
    label: string,
    ttlHours: number | null,
  ): { code: string; expiresAt: number } {
    pairingCodes.length = 0;
    const code = randomBytes(9).toString("base64url"); // 12 字符、72 bit 熵
    const expiresAt = now() + PAIRING_CODE_TTL_MS;
    pairingCodes.push({ digest: Buffer.from(sha256Hex(code), "hex"), label, expiresAt, ttlHours });
    log(
      `pairing code created (label=${JSON.stringify(label)}${ttlHours ? `, temporary=${ttlHours}h` : ""})`,
    );
    return { code, expiresAt };
  }

  /* ---------- /api/me/* 设备自助管理通道（网页设备管理页后端）----------
   * 需求规格：不再要求 root 本机 curl 才能发配对码/撤销。挂载在保护中间件
   * **之后**（http.ts：app.use("*", middleware) → app.route("/", meRoutes)），不进
   * PUBLIC_API_PATHS。这组路由自身校验（纵深防御，不依赖 middleware 顺序）：
   * 会话必须有效；所属设备 temporary → 一律 403（fail-closed，临时设备无管理权）；
   * POST 必须带 x-zcode-csrf 且与会话 csrfDigest 摘要层常量时间匹配（GET 不要求）。
   * CSRF 从「暂不强制」升级为「对 /api/me 强制」：新通道只影响本管理页，
   * middleware 里对既有保护面的暂缓逻辑保持不动。 */
  const meRoutes = new Hono();

  // 中间件限定 /api/me/*（不是 use("*")）：meRoutes 被挂载在根路径，
  // use("*") 会误伤 bots webhook 等同 app 的其它路由（它们无会话是常态）。
  meRoutes.use("/api/me/*", async (c, next) => {
    const token = sessionTokenFromContext(c);
    const resolved = token ? resolveSession(token) : null;
    if (!token || !resolved || !resolved.ok) {
      return c.json({ error: "authentication_failed" satisfies ErrorCode }, 401);
    }
    if (resolved.device.temporary) {
      return c.json({ error: "forbidden" satisfies ErrorCode }, 403);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const presented = c.req.header(CSRF_HEADER_NAME) ?? "";
      if (!presented || !digestEquals(sha256Hex(presented), resolved.session.csrfDigest)) {
        return c.json({ error: "forbidden" satisfies ErrorCode }, 403);
      }
    }
    await next();
  });

  meRoutes.get("/api/me/devices", (c) => {
    const devices = [...store.devices]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ id, label, createdAt, expiresAt, lastSeenAt, temporary }) => ({
        id,
        label,
        createdAt,
        expiresAt,
        lastSeenAt,
        temporary,
      }));
    return c.json({ devices });
  });

  meRoutes.post("/api/me/devices/revoke", async (c) => {
    const body = await readJsonBody(c);
    if (body === null) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    const id = typeof body.id === "string" ? body.id : "";
    // 撤销「当前自己」也允许（前端会确认）：revokeDeviceById 统一走三步序，
    // 自己的会话记录一并清除，本请求的后续 handler 拿不到会话也无妨（响应已定）。
    const revokedId = await revokeDeviceById(id);
    if (!revokedId) {
      return c.json({ error: "device_not_found" }, 404);
    }
    return c.json({ ok: true, id: revokedId });
  });

  meRoutes.post("/api/me/devices/rename", async (c) => {
    const body = await readJsonBody(c);
    if (body === null) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    const id = typeof body.id === "string" ? body.id : "";
    const label = normalizeLabel(body.label);
    if (!label) {
      return c.json({ error: "label is required" }, 400);
    }
    const device = store.devices.find((d) => d.id === id);
    if (!device) {
      return c.json({ error: "device_not_found" }, 404);
    }
    device.label = label;
    await persistDevices();
    return c.json({ ok: true, id: device.id, label: device.label });
  });

  meRoutes.post("/api/me/pairing-code", async (c) => {
    const body = await readJsonBody(c);
    if (body === null) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    const label = normalizeLabel(body.label);
    if (!label) {
      return c.json({ error: "label is required" }, 400);
    }
    const ttlHours = parseTtlHours(body.ttlHours);
    if (ttlHours === "invalid") {
      return c.json({ error: "ttlHours must be an integer between 1 and 168" }, 400);
    }
    const created = createPairingCode(label, ttlHours);
    return c.json({
      code: created.code,
      expiresAt: created.expiresAt,
      ...(ttlHours ? { temporary: true, ttlHours } : {}),
    });
  });

  /* ---------- /api/me/pending-summary ----------
   * APK 前台服务在 WebView 冻结时感知"有没有任务完成/待处理"的轻量轮询端点。
   * GET（CSRF 豁免：轮询走导航外的普通 GET，无副作用）；meRoutes 中间件已校验
   * 会话（临时设备也允许读——只读计数，无管理语义，与 /api/me/devices 同级）。
   * 响应形状（写入 spec：packages/server/specs/device-credential-auth.md §pending-summary）：
   *   200 { pendingInteractions: number, runningTasks: number, completedUnread: number,
   *         pendingDigest?: { kind: "permission" | "userInput", text: string } }
   *   503 { error: "summary_unavailable" }  未装配数据源（数据源注入是部署选项）
   *   500 { error: "summary_failed" }       数据源抛错（fail loud，不喂假零）
   * 计数语义：pendingInteractions = 权限确认 + 用户输入挂起数（内存事实）；
   * runningTasks = tasks-index 中 status=running 的任务数；
   * completedUnread = status=completed 且 unreadAt 非空的任务数（error 不并入）。
   * pendingDigest（可选）是最近一条挂起交互的单行脱敏摘要，无挂起/取不到时整体缺席。 */
  meRoutes.get("/api/me/pending-summary", async (c) => {
    if (!pendingSummarySource) {
      return c.json({ error: "summary_unavailable" }, 503);
    }
    try {
      const summary = await pendingSummarySource();
      return c.json(summary);
    } catch (error) {
      log(`pending-summary source failed: ${error instanceof Error ? error.message : String(error)}`);
      return c.json({ error: "summary_failed" }, 500);
    }
  });

  /* ---------- /api/me/workspaces/register ----------
   * 用户浏览器里打开的项目 workspace（setting.json 恢复链恢复的 tab）不在 server
   * 启动时宣告的根集合里——文件树对它们下载/预览一律 403。前端在打开文件树时
   * 静默注册一次，server 把 realpath 归一后的根并入 download/preview 的包含判定。
   * 约束：设备会话内建（meRoutes 中间件）+ CSRF 强制；只收绝对路径且必须真实存在
   * （realpath 成功才算注册成功——不存在的目录没有可授权的内容）；内存 Set 持有，
   * 重启即失，由前端下次打开文件树时重新注册；上限 64 个根（单人场景远够，
   * 防异常客户端刷表）。未装配 workspaceRootsProvider 时 503（与其他端点同语义）。
   *   200 {registered: true, root: <realpath>} | 400 invalid_path | 403 forbidden
   *   （路径不可读/realpath 失败按 400 计——注册语义是"宣告一个真实存在的目录"，
   *    与 download 的 404（目标文件不存在）不同层）| 429 rate_limited | 503 unavailable */
  const registeredWorkspaceRoots = new Set<string>();
  const WORKSPACE_REGISTER_MAX_ROOTS = 64;
  const workspaceRegisterLimiter = makeRateLimiter(60_000, 30);
  meRoutes.post("/api/me/workspaces/register", async (c) => {
    const ip = clientIpFrom(c);
    if (workspaceRegisterLimiter.limited(ip)) {
      return c.json({ error: "rate_limited" }, 429);
    }
    workspaceRegisterLimiter.hit(ip);
    if (!workspaceRootsProvider) {
      return c.json({ error: "download_unavailable" }, 503);
    }
    const body = await readJsonBody(c);
    const rawPath = typeof body?.path === "string" ? body.path : "";
    if (!rawPath || !isAbsolute(rawPath)) {
      return c.json({ error: "invalid_path" }, 400);
    }
    const requestedPath = resolve(rawPath);
    let realPath: string;
    try {
      const dirStat = await stat(requestedPath);
      if (!dirStat.isDirectory()) {
        return c.json({ error: "invalid_path" }, 400);
      }
      realPath = await realpath(requestedPath);
    } catch {
      return c.json({ error: "invalid_path" }, 400);
    }
    if (registeredWorkspaceRoots.size >= WORKSPACE_REGISTER_MAX_ROOTS && !registeredWorkspaceRoots.has(realPath)) {
      return c.json({ error: "too_many_roots" }, 400);
    }
    registeredWorkspaceRoots.add(realPath);
    return c.json({ registered: true, root: realPath });
  });

  /* ---------- /api/me/files/download ----------
   * agent 产物/报告的手机侧取回通道。GET（CSRF 豁免：下载走导航/锚点，不带自定义头）。
   * ?path=<绝对路径> 必须落在 workspaceRootsProvider 声明的工作区内：
   * realpath 解析（含全部父目录，符号链接逃逸在此暴露）后再做目录包含判定。
   * 约束：仅普通文件、大小 ≤ 100MB、每 IP 30 次 / 10 分钟；目录列举与通配一律拒绝。
   * 响应：流式 body + Content-Disposition: attachment（RFC 5987 filename*）。
   *   200 文件流 | 400 invalid_path（缺参/非绝对路径）| 403 forbidden（越界/穿越）
   *   404 not_found | 413 too_large | 429 rate_limited | 503 download_unavailable（未装配根集合） */
  const downloadLimiter = makeRateLimiter(DOWNLOAD_RATE_WINDOW_MS, DOWNLOAD_RATE_MAX);
  meRoutes.get("/api/me/files/download", async (c) => {
    const ip = clientIpFrom(c);
    if (downloadLimiter.limited(ip)) {
      return c.json({ error: "rate_limited" }, 429);
    }
    downloadLimiter.hit(ip);

    const resolved = await resolveWorkspaceFile(c.req.query("path") ?? "");
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, resolved.status);
    }
    const { realPath, size } = resolved;
    if (size > MAX_DOWNLOAD_BYTES) {
      return c.json({ error: "too_large" }, 413);
    }
    const fileName = basename(realPath);
    // RFC 5987：非 ASCII 文件名用 filename* 承载；attachment 强制下载而非内联渲染
    //（防 <svg>/<html> 产物在站点域内被当文档打开）。
    const encodedName = encodeURIComponent(fileName);
    c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodedName}`);
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Length", String(size));
    c.header("X-Content-Type-Options", "nosniff");
    const handle = await open(realPath, "r");
    const stream = handle.createReadStream();
    // 流结束/出错都要关句柄；Hono 消费 ReadableStream 后自动 finalizer。
    stream.on("close", () => {
      void handle.close().catch(() => undefined);
    });
    return c.body(stream as unknown as ReadableStream);
  });

  /**
   * workspace 文件解析（download 与 preview/file 共用的校验链）：
   * 绝对路径 → resolve → realpath（符号链接逃逸在此暴露）→ 必须落在
   * workspaceRootsProvider 任一根内。返回 200/400/403/404 之一的错误响应或解析结果。
   * 越界与路径穿越同一响应（403），不泄露目标存在性。
   */
  async function resolveWorkspaceFile(
    rawPath: string,
  ): Promise<
    | { ok: false; status: 400 | 403 | 404 | 503; error: "invalid_path" | "forbidden" | "not_found" | "download_unavailable" }
    | { ok: true; realPath: string; size: number }
  > {
    if (!workspaceRootsProvider) {
      return { ok: false, status: 503, error: "download_unavailable" };
    }
    if (!rawPath || !isAbsolute(rawPath)) {
      return { ok: false, status: 400, error: "invalid_path" };
    }
    // decodeURIComponent 在这里不做：调用方各自的入口已解码一次；二次解码会把
    // %2e%2e 之类的编码穿越在 realpath 前引入。realpath 消解一切间接引用（symlink/..），是唯一权威。
    const requestedPath = resolve(rawPath);
    let realPath: string;
    try {
      realPath = await realpath(requestedPath);
    } catch {
      return { ok: false, status: 404, error: "not_found" };
    }
    // 根集合先 realpath 归一——root 本身是符号链接时，目标的 realpath 已离开
    // 声明路径，不归一会把合法文件误拒（403）。root 不存在/不可解析时保留 resolve
    // 形态（该 root 下本就取不到文件，包含判定照旧失败）。
    // 注册根（/api/me/workspaces/register）并入判定：注册时已 realpath 归一，
    // 直接并入即可（Set 保证无重复）。
    const roots = await Promise.all(
      [...workspaceRootsProvider(), ...registeredWorkspaceRoots].map(async (root) => {
        const resolved = resolve(root);
        return (await realpath(resolved).catch(() => resolved)) as string;
      }),
    );
    const insideRoot = roots.some((root) => isInsideDirectory(root, realPath));
    if (!insideRoot) {
      // 越界与路径穿越同一响应：不泄露"目标是否存在在别处"的事实。
      return { ok: false, status: 403, error: "forbidden" };
    }
    let fileStat;
    try {
      fileStat = await stat(realPath);
    } catch {
      return { ok: false, status: 404, error: "not_found" };
    }
    if (!fileStat.isFile()) {
      return { ok: false, status: 404, error: "not_found" };
    }
    return { ok: true, realPath, size: fileStat.size };
  }

  /* ---------- /api/me/preview/proxy（服务端半边）----------
   * agent 起的 dev server / 产出的 HTML 在手机 WebView 里打不开（远端主机上没有
   * 浏览器可达的 localhost）——由本服务端代理回环地址。
   * SSRF 防线（顺序即防线）：
   *   1. 仅 http/https scheme；
   *   2. hostname 先经 DNS 解析（node:dns lookup all），每个解析结果都必须是
   *      回环地址（127.0.0.0/8 / ::1）——拒绝内网地址、拒绝解析到非回环的域名；
   *   3. fetch redirect:"manual"，不跟随重定向（跟随会让校验过的主机把请求带去别处）；
   *   4. 响应体 ≤ 100MB（与下载端点同档）。
   * HTML ≤ 2MB 时注入 <base href>，让页面相对资源（css/js/图片）走同一条代理
   * 路径——这是 WebView 可用性的关键；超过阈值的 HTML 与非 HTML 一律原样流式透传。
   *   200 代理流 | 400 invalid_url | 403 forbidden_target | 429 rate_limited
   *   502 upstream_unreachable | 504 upstream_timeout | 503 proxy_unavailable（未装配） */
  const previewLimiter = makeRateLimiter(PREVIEW_RATE_WINDOW_MS, PREVIEW_RATE_MAX);
  meRoutes.get("/api/me/preview/proxy", async (c) => {
    if (!isPreviewProxyEnabled) {
      return c.json({ error: "proxy_unavailable" }, 503);
    }
    const ip = clientIpFrom(c);
    if (previewLimiter.limited(ip)) {
      return c.json({ error: "rate_limited" }, 429);
    }
    previewLimiter.hit(ip);

    const rawUrl = c.req.query("url") ?? "";
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      return c.json({ error: "invalid_url" }, 400);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return c.json({ error: "invalid_url" }, 400);
    }
    const loopback = await isLoopbackHost(target.hostname).catch(() => false);
    if (!loopback) {
      return c.json({ error: "forbidden_target" }, 403);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PREVIEW_UPSTREAM_TIMEOUT_MS);
    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(target, {
        method: c.req.method,
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: c.req.header("accept") ?? "*/*" },
      });
    } catch (error) {
      clearTimeout(timeout);
      const aborted = error instanceof Error && error.name === "AbortError";
      return c.json({ error: aborted ? "upstream_timeout" : "upstream_unreachable" }, aborted ? 504 : 502);
    }
    clearTimeout(timeout);
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const contentLength = upstream.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_DOWNLOAD_BYTES) {
      return c.json({ error: "too_large" }, 413);
    }
    // 重定向透传状态与 Location（Location 仍指向回环，由前端决定是否再走代理）。
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location") ?? "";
      return c.json({ error: "upstream_redirect", location }, upstream.status as 301 | 302 | 303 | 307 | 308);
    }
    const isHtml = contentType.includes("text/html");
    if (!isHtml) {
      // 非 HTML：流式透传（Content-Type 原样；大小上限已由 content-length 预检，
      // 无 content-length 的流式响应由 limitStream 上限兜底——读满即断，防无界流）。
      // 注意：body 只允许消费一次，这里读的是"还没被读过"的原生流。
      return c.body(limitStream(upstream.body, MAX_DOWNLOAD_BYTES), 200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      });
    }
    // HTML：先按 content-length 预判——超过内联阈值就不读 body（一次消费原则，
    // 修复：此前先 arrayBuffer() 消费掉 body 再对同一 body limitStream，
    // closed+locked 的流 getReader() 同步抛 TypeError → 必 500）。预判通过才
    // 读全量注入 <base>；无 content-length 的响应保守走读全量路径（上限内注入，
    // 超限把已读 buffer 原样返回——绝不二次消费）。
    const declaredLength = contentLength ? Number(contentLength) : null;
    if (declaredLength !== null && declaredLength > PREVIEW_HTML_INLINE_MAX_BYTES) {
      return c.body(limitStream(upstream.body, MAX_DOWNLOAD_BYTES), 200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      });
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.byteLength > PREVIEW_HTML_INLINE_MAX_BYTES) {
      // body 已读完（无法再流式），把已读内容原样返回即可——语义等同透传。
      return c.body(buffer, 200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      });
    }
    const baseHref = `${target.protocol}//${target.host}${target.pathname.replace(/[^/]*$/, "")}`;
    const html = buffer.toString("utf8");
    // 上游页面自带 <base> 时不再注入（双 base 的解析行为未定义，以页面为准）。
    if (/<base\s/i.test(html)) {
      return c.body(html, 200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      });
    }
    const baseTag = `<base href="${baseHref}">`;
    const injected = html.includes("<head")
      ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
      : `${baseTag}${html}`;
    return c.html(injected);
  });

  /* ---------- /api/me/preview/file/<encodeURIComponent(绝对路径)> ----------
   * workspace 内文件的内容预览（与 files/download 同一条校验链：resolve→realpath→
   * 根包含判定；穿越/symlink 逃逸 403/404 不区分存在性）。与 ?url= 回环代理分支并存：
   * 前端传的是 workspace 内文件绝对路径（row.path/target.path），不是 http URL。
   * 关键设计（路径段而非 query）：HTML 预览注入的 <base href> 指向「所在目录的路径段
   * 形式端点」——query 形式在浏览器相对解析时会丢 query（URL("css/x.css",
   * "https://h/api/me/preview/proxy?path=/dir/") → /api/me/preview/css/x.css，资源
   * 回不来），路径段形式下相对资源 css/app.js 自动解析为
   * /api/me/preview/file/<encoded-dir>/css/app.js，服务端解码该段拼出文件路径再走
   * 同一条校验链，资源闭环。
   * 非 HTML 与 >2MB HTML：按扩展名 Content-Type 原样返回（无需 base）。
   *   200 内容 | 400 invalid_path | 403 forbidden | 404 not_found
   *   413 too_large（>100MB，与下载同档）| 429 rate_limited | 503 download_unavailable */
  meRoutes.get("/api/me/preview/file/*", async (c) => {
    const ip = clientIpFrom(c);
    if (previewLimiter.limited(ip)) {
      return c.json({ error: "rate_limited" }, 429);
    }
    previewLimiter.hit(ip);

    // Hono 通配参数含原始编码段；先解码回绝对路径（调用方约定 encodeURIComponent 整段）。
    const wildcard = c.req.path.slice("/api/me/preview/file/".length);
    let rawPath: string;
    try {
      rawPath = decodeURIComponent(wildcard);
    } catch {
      return c.json({ error: "invalid_path" }, 400);
    }
    const resolved = await resolveWorkspaceFile(rawPath);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, resolved.status);
    }
    const { realPath, size } = resolved;
    if (size > MAX_DOWNLOAD_BYTES) {
      return c.json({ error: "too_large" }, 413);
    }
    const lowerName = realPath.toLowerCase();
    const isHtmlFile = lowerName.endsWith(".html") || lowerName.endsWith(".htm");
    const contentType = previewContentType(lowerName);
    if (!isHtmlFile || size > PREVIEW_HTML_INLINE_MAX_BYTES) {
      // 非 HTML 与超大 HTML：原样流式返回（无需 <base>；浏览器按扩展名/MIME 处理）。
      const handle = await open(realPath, "r");
      const stream = handle.createReadStream();
      stream.on("close", () => {
        void handle.close().catch(() => undefined);
      });
      return c.body(stream as unknown as ReadableStream, 200, {
        "Content-Type": contentType,
        "Content-Length": String(size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      });
    }
    // HTML ≤ 2MB：读全量注入 <base> 指向「所在目录」的路径段端点，相对资源闭环
    // 回到本端点（解码段 + 相对段拼接后走同一条校验链）。文件名段必须保留在 href 末尾
    // 的 / 之前为空——base 以目录收尾，浏览器把相对段直接接到 encoded-dir 之后。
    const dir = realPath.slice(0, realPath.lastIndexOf("/") || 1);
    const baseHref = `/api/me/preview/file/${encodeURIComponent(dir)}/`;
    const buffer = await readFile(realPath);
    const html = buffer.toString("utf8");
    const baseTag = `<base href="${baseHref}">`;
    const injected = html.includes("<head")
      ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
      : `${baseTag}${html}`;
    return c.body(injected, 200, {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
  });

  /* ---------- /api/me/usage-summary ----------
   * UI /usage 页的手机端轻量聚合。GET（CSRF 豁免）、60 次 / 10 分钟 / IP。
   * 响应形状（写入 spec 追加节）：
   *   200 { todayTokens, todayRequests, rpm, tpm,
   *         hourly24h: [{ hourISO, tokens }]（24 桶不足补零）, generatedAt }
   * hourISO 为带本地时区偏移的 ISO 8601（如 2026-01-01T00:00:00+08:00），前端
   * new Date(hourISO) 直接本地渲染；today 聚合锚定服务器本地时区今日 00:00；
   * rpm/tpm 为最近 60 分钟滑动窗口（请求数 / token 数）。
   *   401 中间件统一语义 | 429 rate_limited | 500 usage_failed（fail loud 不喂假零）
   *   503 usage_unavailable（部署未装配数据源） */
  const usageLimiter = makeRateLimiter(USAGE_RATE_WINDOW_MS, USAGE_RATE_MAX);
  meRoutes.get("/api/me/usage-summary", async (c) => {
    if (!usageSummarySource) {
      return c.json({ error: "usage_unavailable" }, 503);
    }
    const ip = clientIpFrom(c);
    if (usageLimiter.limited(ip)) {
      return c.json({ error: "rate_limited" }, 429);
    }
    usageLimiter.hit(ip);
    try {
      const summary = await usageSummarySource();
      return c.json(summary);
    } catch (error) {
      log(`usage-summary source failed: ${error instanceof Error ? error.message : String(error)}`);
      return c.json({ error: "usage_failed" }, 500);
    }
  });

  /* ---------- 会话保护中间件（/api/* 与 /ws*）---------- */

  function isProtectedPath(pathname: string): boolean {
    return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
  }

  const PUBLIC_API_PATHS = new Set([
    "/api/pairing/page",
    "/api/pairing/redeem",
    "/api/auth/renew",
    "/api/auth/probe",
  ]);

  function isPublicApiPath(pathname: string): boolean {
    if (PUBLIC_API_PATHS.has(pathname) || pathname.startsWith("/api/admin/")) {
      return true;
    }
    // Bot 平台 webhook 回调（POST /api/bots/:provider[/:botId]）：调用方是外部
    // 机器人平台（Telegram 等），永远不会有设备会话；该通道由 handleBotCallback
    // 里的 x-zcode-bot-secret 做业务鉴权，不能被会话模型误伤（桌面回调通道）。
    // 前缀匹配覆盖 /api/bots/webhook 与 /api/bots/:provider/:botId 两种形态。
    return pathname.startsWith("/api/bots/");
  }

  // /ws/host（desktop-continuous trusted host 通道）：鉴权模型是「30 秒一次性
  // capability 票据」（hostCapability.issue/consume），与设备会话正交——桌面本地
  // Host 没有也不需要有设备会话 Cookie。会话中间件对该路径放行，由 http.ts 里
  // 注册在其后的 capability 中间件做它自己的鉴权（fail closed：票无效 401）。
  // 本部署（纯自托管）没有桌面客户端，此通道无实际流量；豁免是为了语义正确。
  function isSessionExemptPath(pathname: string): boolean {
    return pathname === "/ws/host";
  }

  /* ---------- 服务端静默自愈（续期是服务端的职责，客户端无需配合）---------- */

  /** 同一请求内自愈换发的新 sessionToken（Context → 新 token）：
   * /ws 的 socket 注册、/api/me 的会话校验都要拿到**换发后**的凭据，
   * 否则注册进撤销注册表的是已失效的旧 token，撤销即时性破洞。 */
  const healedTokens = new WeakMap<Context, string>();

  /**
   * 会话失效时的隐式续期：凭续期 Cookie（值 = deviceToken，只允许调 renew 的凭据）
   * 换发新会话。供 middleware（保护面自愈）与 admitOrRenew（SPA 入口页判定）复用。
   * - 设备撤销/过期/续期 Cookie 缺失 → null（调用方照旧 401，错误码语义不变）；
   * - 成功 → createSession + 会话 Cookie 四件套 + 续期 Cookie（滑动顺延，临时设备除外，
   *   与显式 renew 完全同语义）+ lastSeenAt 落盘，返回设备记录；
   * - 不走 renewLimiter：自愈是请求自身的隐式续期，不占显式 renew 的限流配额；
   * - 换发的新 token 记入 healedTokens，供同一请求内后续 handler 取用。
   */
  async function trySilentRenew(c: Context): Promise<DeviceRecord | null> {
    const deviceToken = parseCookieHeader(c.req.header("cookie")).get(RENEW_COOKIE_NAME);
    if (!deviceToken) {
      return null; // 无凭据请求：照旧 401，不改变任何错误码语义
    }
    const device = findDeviceByToken(deviceToken);
    if (!device) {
      // 设备已撤销/过期：顺带清掉续期 Cookie（fail closed，与显式 renew 行为一致）
      setCookie(c, RENEW_COOKIE_NAME, "", {
        path: "/",
        secure: true,
        sameSite: "Strict",
        httpOnly: true,
        maxAge: 0,
      });
      return null;
    }
    const t = now();
    device.lastSeenAt = t;
    if (!device.temporary) {
      // 滑动窗口与显式 renew 同语义：顺延 90 天、365 天绝对上限兜底。
      device.expiresAt = Math.min(t + DEVICE_TTL_MS, device.createdAt + DEVICE_TTL_ABSOLUTE_MS);
    }
    await persistDevices();
    const session = createSession(device);
    setSessionCookies(c, session);
    if (!device.temporary) {
      setCookie(c, RENEW_COOKIE_NAME, deviceToken, {
        path: "/",
        secure: true,
        sameSite: "Strict",
        httpOnly: true,
        maxAge: Math.max(1, Math.floor((device.expiresAt - t) / 1000)),
      });
    }
    healedTokens.set(c, session.sessionToken);
    return device;
  }

  function sessionTokenFromContext(c: Context): string | null {
    // 本请求刚自愈过：返回换发后的新 token（/ws socket 注册用；见 healedTokens 注释）
    const healed = healedTokens.get(c);
    if (healed) {
      return healed;
    }
    const cookies = parseCookieHeader(c.req.header("cookie"));
    const token = cookies.get(SESSION_COOKIE_NAME) || cookies.get(SESSION_COOKIE_HOST_NAME);
    return token || null;
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (!isProtectedPath(pathname) || isPublicApiPath(pathname) || isSessionExemptPath(pathname)) {
      await next();
      return;
    }
    const token = sessionTokenFromContext(c);
    const resolved = token ? resolveSession(token) : null;
    /* CSRF 强制（已生效，取代"只下发暂不强制"的旧待办）：
     * 全部**带 Cookie 会话**的状态变更请求（POST/PUT/PATCH/DELETE）必须校验
     * 双提交 token：请求头 x-zcode-csrf 与会话 csrfDigest 摘要层常量时间匹配。
     * 缺失/不匹配 → 403 forbidden，handler 不执行（无副作用）。
     * 校验位置在自愈分支**之前**：trySilentRenew 会换发
     * 新会话并放行请求——若把校验放在它后面，"会话失效 + 带续期 Cookie"的自愈 POST
     * 就绕过了 CSRF。会话有效路径的正常 csrfDigest 与自愈换发前旧会话的 csrfDigest
     * 在这里都没有可用会话时无法比较，因此自愈候选请求按"校验后再换发"处理：
     * 请求必须携带与**续期 Cookie 所属设备**无关的合法会话头才可被自愈放行——
     * 实际上自愈场景旧会话已失效、没有可比较的 csrfDigest，故对"自愈 + 状态变更"
     * 一律要求先显式 renew（错误码 403 而非静默换发）。这是收窄而非放宽：
     * 自愈本来只服务 GET 场景（页面轮询/入口页），POST 走显式 renew 是既有语义。
     * - GET/HEAD 无状态变更，不校验（下载/预览/轮询的导航型请求也不带自定义头）；
     * - WS 升级是 GET 语义，CSRF 防线由 WS Origin 白名单承担（本文件 isWsOriginAllowed）；
     * - 豁免面不进本 middleware（isPublicApiPath/isSessionExemptPath），逐条理由：
     *   · /api/pairing/redeem、/api/auth/renew、/api/auth/probe——自救通道，凭据在
     *     body（deviceToken），调用方（APK 原生 HttpURLConnection、relay 本地会话）
     *   · 无 Cookie、无会话，双提交无从谈起；CSRF 防护由"凭据不自动携带"承担；
     *   · /api/pairing/page、/api/admin/*——GET/无会话语义（admin 双闸另算）；
     *   · /api/bots/*——外部机器人平台 webhook 回调，业务鉴权 x-zcode-bot-secret，
     *     调用方永不持有设备会话；/ws/host——capability 票鉴权，与设备会话正交。
     * - 应急回退：ZCODE_CSRF_ENFORCE=0 回到只下发语义（见 csrfEnforce 注释）；
     * - CSRF cookie 仅作预留通道（页面 JS 读 cookie 写头），服务端只认请求头。 */
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method.toUpperCase());
    if (csrfEnforce && mutating) {
      if (resolved?.ok) {
        const presented = c.req.header(CSRF_HEADER_NAME) ?? "";
        if (!presented || !digestEquals(sha256Hex(presented), resolved.session.csrfDigest)) {
          return c.json({ error: "forbidden" satisfies ErrorCode }, 403);
        }
      } else if (parseCookieHeader(c.req.header("cookie")).get(RENEW_COOKIE_NAME)) {
        // 会话失效但带续期 Cookie——这是自愈的候选请求，
        // 自愈会静默换发新会话并放行。自愈只服务 GET 语义（页面轮询/SPA 入口页），
        // mutating 请求在这里 fail closed（403），自愈分支从此不可能放行有副作用的请求。
        return c.json({ error: "forbidden" satisfies ErrorCode }, 403);
      }
      // 其余无凭据的 mutating 请求：不带续期 Cookie，自愈救不活——照旧落到下方
      // 401 分支（保留 authentication_failed 的可区分错误码语义，壳靠它切 UI）。
    }
    if (!token || !resolved || !resolved.ok) {
      // 自愈：会话失效但带续期 Cookie 且设备健在 → 静默换发新会话放行。
      // 会话有效时不进这条路径（正常路径零开销）；无凭据请求照旧 401。
      // mutating 请求已在上面被 403 拦截，走到这里的自愈只可能是 GET/HEAD。
      const healed = await trySilentRenew(c);
      if (healed) {
        healed.lastSeenAt = now();
        scheduleTouchPersist();
        await next();
        return;
      }
      clearSessionCookies(c);
      return c.json(
        {
          error: (resolved && !resolved.ok
            ? resolved.code
            : "authentication_failed") satisfies ErrorCode,
        },
        401,
      );
    }
    resolved.device.lastSeenAt = now();
    scheduleTouchPersist();
    await next();
  };

  function isAuthenticatedRequest(c: Context): boolean {
    const token = sessionTokenFromContext(c);
    if (!token) {
      return false;
    }
    return resolveSession(token).ok;
  }

  /**
   * SPA 入口页判定（http.ts 静态处理器用）：会话有效 → true；会话失效但可自愈 →
   * 换发新会话（Set-Cookie 已写入响应，302/200 都会带上）→ true；否则 false（跳配对页）。
   * isAuthenticatedRequest 保持纯查询不动（别处仍在用）。
   */
  async function admitOrRenew(c: Context): Promise<boolean> {
    const token = sessionTokenFromContext(c);
    if (token && resolveSession(token).ok) {
      return true;
    }
    return (await trySilentRenew(c)) !== null;
  }

  function assertSessionValid(sessionToken: string): boolean {
    return resolveSession(sessionToken).ok;
  }

  /** WS 升级 Origin 判定：读请求的 Origin/Referer 与请求自身
   * Host（含反代头）做同源判定，走模块级纯函数 isWsOriginAllowed
   * （单测用最小 req 存根直接覆盖纯函数；http.ts 三处升级工厂经本方法调用）。 */
  function isWsOriginAllowedForContext(c: Context): boolean {
    return isWsOriginAllowed(c.req, c.req.header("origin"), c.req.header("referer"));
  }

  /** 停止周期任务并等待挂起的写链排空（测试 fixture 清理与优雅关闭用：落盘不丢、rm 不竞态）。 */
  async function dispose(): Promise<void> {
    clearInterval(sessionPruneTimer);
    await writeChain.catch(() => {});
  }

  return {
    routes,
    meRoutes,
    middleware,
    wsGuard: { assertValid: assertSessionValid, registerSocket },
    sessionTokenFromContext,
    isAuthenticatedRequest,
    admitOrRenew,
    isWsOriginAllowed: isWsOriginAllowedForContext,
    dispose,
  };
}

/* ---------- 配对页 HTML（文案由 deploy 侧提供；fetch 调 /api/pairing/redeem）---------- */

const PAIRING_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'">
<title>连接到这台电脑</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; display: flex;
         min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
  main { max-width: 22rem; padding: 2rem; width: 100%; }
  h1 { font-size: 1.15rem; margin: 0 0 .5rem; }
  p { font-size: .85rem; opacity: .65; line-height: 1.6; margin: 0 0 1.25rem; }
  p.footnote { margin-top: 1.25rem; margin-bottom: 0; font-size: .75rem; opacity: .5; }
  input { width: 100%; box-sizing: border-box; font-size: 1.05rem; letter-spacing: .08em;
          padding: .7rem .9rem; border-radius: .6rem; border: 1px solid #8886;
          background: transparent; }
  button { width: 100%; margin-top: .9rem; font-size: 1rem; padding: .7rem;
           border-radius: .6rem; border: 0; cursor: pointer;
           background: #4f6ef2; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  #msg { font-size: .85rem; margin-top: .9rem; min-height: 1.2em; }
  .err { color: #e5484d; }
</style>
</head>
<body>
<main>
  <h1>连接到这台电脑</h1>
  <p>输入电脑端生成的配对码，把这台设备设为受信任设备。配对码 10 分钟内有效，只能使用一次。</p>
  <form id="f">
    <input id="code" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="配对码" required>
    <button type="submit" id="go">配对</button>
    <div id="msg"></div>
  </form>
  <p class="footnote">换设备或删过记录？需要重新配对，旧连接会同时失效。</p>
</main>
<script>
  var f = document.getElementById('f'), b = document.getElementById('go'),
      m = document.getElementById('msg'), c = document.getElementById('code');
  f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    b.disabled = true; m.textContent = ''; m.className = '';
    fetch('/api/pairing/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: c.value.trim() })
    }).then(function (r) {
      if (r.ok) {
        m.textContent = '配对成功，正在进入…'; m.className = '';
        setTimeout(function () { location.replace('/'); }, 500);
        return;
      }
      // 429 = 限流；其余（403 无效/过期/复用、5xx、网络异常）统一按"重新生成一个"引导
      m.textContent = (r.status === 429)
        ? '尝试太频繁了，请等一分钟再试。'
        : '配对码无效或已过期。请在这台电脑上重新生成一个，再试一次。';
      m.className = 'err';
      b.disabled = false;
    }).catch(function () {
      m.textContent = '配对码无效或已过期。请在这台电脑上重新生成一个，再试一次。';
      m.className = 'err';
      b.disabled = false;
    });
  });
  c.focus();
</script>
</body>
</html>`;
