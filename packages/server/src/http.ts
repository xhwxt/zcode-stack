/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { homedir, hostname } from "node:os";
import { createRequire } from "node:module";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  ServiceCollection,
  IZCodeAgentService,
  IZCodeTaskService,
  IWindowControllerService,
  createZCodeAgentConnectionScope,
  IFileService,
  IGitService,
  ISystemService,
  ITerminalService,
  IBotsService,
  IProviderProvisioningTargetService,
  type ZCodeAgentPendingInteractionDigest,
} from "@zcode/services";
import { getDataBaseDir, getConversationWorkspaceDir } from "@zcode/services/node";
import {
  botProviders,
  formatLogPrefix,
  formatZodError,
  remoteTargetSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type BotProvider,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@zcode/shared";
import { connectRemote, createRemoteBackend, type RemoteConnection } from "./remote/index.js";
import { createHostCapabilityStore } from "./hostCapability.js";
import type { ServerWindowControllerRuntime } from "./windowControllerShim.js";
import { createDeviceCredentialAuth, type DeviceCredentialAuth } from "./deviceCredentialAuth.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
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

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

// ── WS 层 ping/pong 死连接清理 ─────────────────────────────────────────────
// 修复依据：这条链路此前零存活探测，
// 半开连接永远占用服务端资源、也无法通过 terminate 触发浏览器侧 close → 软重连。
// 浏览器网络栈自动回 pong（不依赖页面 JS 计时器，后台冻结页也能回）；连续 2 个
// 周期无 pong 即 terminate，浏览器收到 close 事件后走既有守卫/软重连路径。
// 该心跳同时覆盖直连页与远控页（relay 的 RPC 也是页面直连 server /ws）。
const WS_PING_INTERVAL_MS = 30_000;
const WS_PING_MISS_LIMIT = 4;
// 手机 Chrome 对后台页面的 WS ping 响应会被省电策略延迟/停止（实测
// 45-60s 即失联），2 次 miss（65s）会误杀仍可能活着的连接。放宽到 4 次
// （约 2.5 分钟）——页面进程真死时浏览器 close 事件仍会到达（客户端软重连
// 兜底），这里只是不再主动 terminate 还可能活着的连接。

function startWebSocketPingLoop(
  ws: WebSocket,
  // ping 周期顺带校验会话——会话 12h TTL 与临时设备的
  // expiresAt 此前只在握手时强制，活 WS 永不终止。回调返回 false（撤销/会话过期/
  // 设备过期）即 close(4401)；resolveSession 逐请求重查注册表，同一逻辑链。
  isSessionAlive?: () => boolean,
): () => void {
  let missedPongs = 0;
  let alive = false;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    ws.off("pong", onPong);
    ws.off("close", stop);
    ws.off("error", stop);
  };
  const onPong = () => {
    alive = true;
    // 诊断：pong 到达情况取证（真机"周期断连"的判别点）。
    console.log(`[ws-ping] pong received, alive=true, url=${ws.url ?? ""}`);
  };
  const timer = setInterval(() => {
    if (isSessionAlive && !isSessionAlive()) {
      stop();
      console.log(`[ws-ping] session no longer valid, closing, url=${ws.url ?? ""}`);
      try {
        ws.close(4401, "session no longer valid");
      } catch {
        ws.terminate();
      }
      return;
    }
    if (!alive) {
      missedPongs += 1;
      if (missedPongs >= WS_PING_MISS_LIMIT) {
        stop();
        console.log(`[ws-ping] terminate: missedPongs=${missedPongs}, url=${ws.url ?? ""}`);
        ws.terminate();
        return;
      }
    } else {
      missedPongs = 0;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      stop();
      ws.terminate();
    }
  }, WS_PING_INTERVAL_MS);
  ws.on("pong", onPong);
  ws.on("close", stop);
  ws.on("error", stop);
  return stop;
}

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  // 设备凭据鉴权接线（spec: packages/server/specs/device-credential-auth.md）：
  // 升级成功的 WS 登记进会话→socket 注册表，撤销设备时被服务端主动 close（I4）。
  wsGuard?: DeviceCredentialAuth["wsGuard"],
  sessionToken?: string | null,
  windowController?: ServerWindowControllerRuntime,
) {
  // 会话失效判定回调：ping 循环每 30s 调一次（撤销/会话过期/临时设备
  // 到期的活 WS 在下一个周期内被 close(4401)，不再只依赖握手时点校验）。
  const isSessionAlive =
    wsGuard && sessionToken ? () => wsGuard.assertValid(sessionToken) : undefined;
  startWebSocketPingLoop(ws, isSessionAlive);
  if (wsGuard && sessionToken) {
    wsGuard.registerSocket(sessionToken, ws); // ws.WebSocket 天然满足 GuardSocket 结构
  }
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const server = new LoggingChannelServer(rawServer, log);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // Window Controller 订阅必须与连接同生命周期：进程级单例的订阅表不随连接回收，
  // 死订阅会一直留在投影的 subscriber 表里，每条 delta 按订阅数逐份复制下发
  //（同一 delta 会按订阅数重复下发）。这里给每条连接一个私有 attachment，
  // 并在 socket 关闭时 dispose。
  const windowControllerScope = windowController?.createConnectionScope();
  if (windowControllerScope) {
    overrides.set(IWindowControllerService.channelName, windowControllerScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    void connectionScope?.dispose();
    windowControllerScope?.dispose();
    rawServer.dispose();
  });
}

/** 存储 web 模式下的远程连接，key 为随机 ID */
const remoteConnections = new Map<string, RemoteConnection>();

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface HttpServerOptions {
  serverId?: string;
  name?: string;
  host?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
  /**
   * Window Controller 运行时（entry-http.ts 注入）。注入后每条客户端 WS 连接各拿一个私有
   * attachment：订阅表与帧 emitter 连接私有、连接关闭即 dispose，帧不再按历史订阅数复制。
   * 不注入时退回进程级单例（订阅不随连接回收，仅适合无连接的内部调用方）。
   */
  windowController?: ServerWindowControllerRuntime;
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveServerId(options: HttpServerOptions): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ZCODE_SERVER_ID") || hostname() || "zcode-server"
  );
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  // 修复依据：web 直连页靠 initialWorkspacePurpose 打开 conversation tab，任务列表
  // 才有数据源（对齐桌面端 startupWorkspace.ts 语义）。对话后台目录宣告为
  // conversation，其余（用户 --workspace 指定的项目目录）为 project。
  const isConversationWorkspace = resolve(workspacePath) === resolve(getConversationWorkspaceDir());
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
      ...(isConversationWorkspace ? { workspacePurpose: "conversation" as const } : {}),
    },
  ];
}

function createServerInfo(options: HttpServerOptions): ServerRemoteInfo {
  return {
    serverId: resolveServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    // 设备凭据模式下不存在匿名访问（spec §启用条件：不允许裸奔，无关闭开关）。
    authRequired: true,
    workspaces: resolveServerWorkspaces(options),
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
    },
  };
}

/* ---------- 鉴权面判定（路径形状，鉴权语义在 deviceCredentialAuth.ts）---------- */

function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

function isStaticFallbackAllowed(pathname: string): boolean {
  return !isTokenProtectedPath(pathname);
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/* ---------- /api/me 数据源装配（pending-summary / files-download）---------- */

/**
 * /api/me/pending-summary 的数据源：聚合本部署 workspace 的三类计数。
 * - pendingInteractions：agent service 内存里的挂起反向交互（权限确认 + 用户输入）；
 * - runningTasks / completedUnread：tasks-index sqlite 的 status 投影
 *   （经 IZCodeTaskService.listTasks 只读，provider 过滤 glm = 本 runtime 全量写入方）。
 * - pendingDigest（可选）：最近一条挂起交互的脱敏摘要，供壳原生通知正文；
 *   无挂起交互或取不到摘要时整体缺席（与计数同语义）。
 * 服务缺失（如未装配 agent）返回零值而不是抛错——端点语义是"尽力告知"，
 * 结构性缺失不属于错误；数据源自身的运行时异常才向上抛（端点 500）。
 */
function buildPendingSummarySource(
  services: ServiceCollection,
  options: HttpServerOptions,
): () => Promise<{
  pendingInteractions: number;
  runningTasks: number;
  completedUnread: number;
  pendingDigest?: ZCodeAgentPendingInteractionDigest;
}> {
  return async () => {
    const workspaces = resolveServerWorkspaces(options);
    const workspacePath = workspaces[0]?.path;
    if (!workspacePath) {
      return { pendingInteractions: 0, runningTasks: 0, completedUnread: 0 };
    }
    const agentService = services.getOptional(IZCodeAgentService);
    let pendingInteractions = 0;
    let pendingDigest: ZCodeAgentPendingInteractionDigest | undefined;
    if (agentService) {
      const counts = agentService.countPendingInteractions({ workspacePath });
      pendingInteractions = counts.permissionCount + counts.userInputCount;
      // 摘要访问器无挂起交互时返回 null → 字段整体缺席（与计数同语义）。
      pendingDigest = agentService.getPendingInteractionDigest({ workspacePath }) ?? undefined;
    }
    const digestFields = pendingDigest ? { pendingDigest } : {};
    const taskService = services.getOptional(IZCodeTaskService);
    if (!taskService) {
      return { pendingInteractions, runningTasks: 0, completedUnread: 0, ...digestFields };
    }
    const tasks = await taskService.listTasks({ workspacePath });
    let runningTasks = 0;
    let completedUnread = 0;
    for (const task of tasks) {
      if (task.status === "running") runningTasks += 1;
      else if (task.status === "completed" && task.unreadAt != null) completedUnread += 1;
    }
    return { pendingInteractions, runningTasks, completedUnread, ...digestFields };
  };
}

/** /api/me/files/download 允许的根目录集合：宣告的 workspace + 会话后台目录。 */
function buildWorkspaceRoots(options: HttpServerOptions): () => string[] {
  return () => {
    const roots = resolveServerWorkspaces(options).map((workspace) => workspace.path);
    roots.push(getConversationWorkspaceDir());
    return [...new Set(roots.filter((root) => root.trim().length > 0))];
  };
}

/* ---------- /api/me/usage-summary 数据源 ----------
 * 事实源勘察结论：model_usage / turn_usage 表在 Agent（CLI）的会话库
 * `~/.zcode/cli/db/db.sqlite`（agent 子进程与 server 同 HOME 时即 dataBaseDir 之外的
 * 固定路径；部署验证 <数据目录> 侧无副本）。server 进程对该库只有读需求，
 * 用 node:sqlite DatabaseSync({ readOnly: true }) 打开：WAL 模式下与 Agent 写者并发
 * 安全，readOnly 保证本端点绝不是第二个写方。RPC 通道（v4/usage/stats）要求活跃
 * workspace client，空闲回收后取不到——直接读库是唯一无副作用的稳定通道。
 * 聚合口径对齐 CLI 侧 queryAppUsage：token = computed_total_tokens，
 * 请求数 = model_usage 行数（一次模型请求一行）。
 * 打不开库（文件缺失/权限）→ 抛错 → 端点 500；部署未装配 → 503。 */
const USAGE_HOURLY_BUCKETS = 24;
const USAGE_HOUR_MS = 3_600_000;
const USAGE_WINDOW_MS = 60 * 1_000; // rpm/tpm 滑动窗口

function resolveAgentSessionDbPath(): string {
  // CLI 侧 getDefaultSessionDbPath() = ~/.zcode/cli/db/db.sqlite（无环境变量覆盖，
  // storage.sessionDbPath 仅显式配置时改写；本部署未配置）。server 与 Agent 同 HOME。
  return join(homedir(), ".zcode", "cli", "db", "db.sqlite");
}

/** node:sqlite 的打包安全取用：tsup/esbuild 会把动态 import("node:sqlite") 错误
 * 改写为 import("sqlite")，运行时报 Cannot find package（上游
 * desktop chromeCookieManager.ts 同款已知问题）；createRequire 稳定保留 node: 协议。 */
const requireSqlite = (): typeof import("node:sqlite") =>
  createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** 带本地时区偏移的 ISO 8601（如 2026-01-01T00:00:00+08:00）；前端 new Date() 直接本地渲染。 */
function formatLocalHourISO(epochMs: number): string {
  const date = new Date(epochMs);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offsetPart = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:00:00${offsetPart}`
  );
}

function buildUsageSummarySource(): () => Promise<{
  todayTokens: number;
  todayRequests: number;
  rpm: number;
  tpm: number;
  hourly24h: Array<{ hourISO: string; tokens: number }>;
  generatedAt: number;
}> {
  return async () => {
    const dbPath = resolveAgentSessionDbPath();
    const { DatabaseSync } = requireSqlite();
    // 每次查询现开只读连接：轮询频率低（60/10min 上限），连接开销可忽略；
    // 长持连接反而要处理库文件被外部删除/迁移的重连语义。
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const now = Date.now();
      // 今日 00:00（服务器本地时区）。
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const todayStartMs = todayStart.getTime();

      const today = db
        .prepare(
          `select coalesce(sum(computed_total_tokens), 0) as tokens, count(*) as requests
           from model_usage where started_at >= ? and started_at <= ?`,
        )
        .get(todayStartMs, now) as { tokens: number; requests: number };

      const window = db
        .prepare(
          `select coalesce(sum(computed_total_tokens), 0) as tokens, count(*) as requests
           from model_usage where started_at >= ? and started_at <= ?`,
        )
        .get(now - USAGE_WINDOW_MS, now) as { tokens: number; requests: number };

      // 24 小时桶（含当前小时，向前 24 桶）；一查聚合后内存补零，避免 24 条 SQL。
      const hourlyStartMs = todayStartMs;
      const hourRows = db
        .prepare(
          `select (started_at / 3600000) as hourIndex, coalesce(sum(computed_total_tokens), 0) as tokens
           from model_usage
           where started_at >= ? and started_at <= ?
           group by hourIndex`,
        )
        .all(now - (USAGE_HOURLY_BUCKETS - 1) * USAGE_HOUR_MS, now) as Array<{
        hourIndex: number;
        tokens: number;
      }>;
      const tokensByHourIndex = new Map<number, number>();
      for (const row of hourRows) {
        tokensByHourIndex.set(Number(row.hourIndex), Number(row.tokens));
      }
      const currentHourIndex = Math.floor(now / USAGE_HOUR_MS);
      const hourly24h: Array<{ hourISO: string; tokens: number }> = [];
      for (let i = USAGE_HOURLY_BUCKETS - 1; i >= 0; i--) {
        const hourIndex = currentHourIndex - i;
        const bucketStartMs = hourIndex * USAGE_HOUR_MS;
        hourly24h.push({
          hourISO: formatLocalHourISO(bucketStartMs),
          tokens: tokensByHourIndex.get(hourIndex) ?? 0,
        });
      }
      void hourlyStartMs;
      return {
        todayTokens: Number(today.tokens) || 0,
        todayRequests: Number(today.requests) || 0,
        rpm: Number(window.requests) || 0,
        tpm: Number(window.tokens) || 0,
        hourly24h,
        generatedAt: now,
      };
    } finally {
      db.close();
    }
  };
}

export async function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();

  /* ---------- 设备凭据鉴权（spec: packages/server/specs/device-credential-auth.md）----------
   * 替换旧单 token 模式（?token= 下发 / zcode_lite_token Cookie / ZCODE_PAIRING 开关均已删除，
   * 无兼容开关）。鉴权恒开：admin secret 与 devices.json 皆无时 createDeviceCredentialAuth
   * 直接抛错拒启（不允许裸奔）。数据根 = ZCODE_DATA_BASE_DIR（或 HOME）下的 .zcode。 */
  const deviceAuth = await createDeviceCredentialAuth({
    dataBaseDir: getDataBaseDir(),
    // /api/me/pending-summary 数据源：挂起交互来自 agent service 内存事实
    // （countPendingInteractions，不启动 runtime）；任务计数来自 tasks-index sqlite
    // （经 IZCodeTaskService.listTasks，只读）。workspace = 本部署唯一 workspace
    // （resolveServerWorkspaces 的第一个 path；单人自部署形态）。
    pendingSummarySource: buildPendingSummarySource(services, options),
    // /api/me/files/download 允许的工作区根集合。
    workspaceRootsProvider: buildWorkspaceRoots(options),
    // /api/me/usage-summary：直接只读打开 Agent 会话库
    //（cli/db/db.sqlite，WAL 模式允许并发读者；readOnly 连接绝不写入）。
    usageSummarySource: buildUsageSummarySource(),
  });

  // 公开/管理路由必须注册在保护中间件**之前**：配对页与 redeem/renew/probe 是
  // 未持凭证客户端的自救通道，被 /api/* 中间件拦住就死锁了；
  // /api/admin/* 自带本机+密钥双闸（不变量5），也不走会话中间件。
  app.route("/", deviceAuth.routes);

  // 保护面：/api/* 与 /ws*（会话 Cookie + CSRF；WS 升级未持有效会话前置 401；
  // 会话失效但带续期 Cookie 时由 middleware 内 trySilentRenew 静默自愈——
  // WS 升级请求同样受益：101 响应头带不进 Set-Cookie 无妨，会话已换发、
  // 客户端下一个普通请求会收到新会话 Cookie）。
  app.use("*", deviceAuth.middleware);

  // /api/me/* 设备自助管理通道：必须在保护中间件**之后**挂载——
  // 它需要会话，不进 PUBLIC_API_PATHS；路由内自带会话校验 + CSRF 强制 + 临时设备 403。
  app.route("/", deviceAuth.meRoutes);

  app.get("/api/server-info", (c) => c.json(createServerInfo(options)));
  app.post("/api/rpc-host-capability", (c) => c.json(hostCapabilities.issue()));

  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
  // Origin 白名单（CSWSH 主防线）：升级前校验 Origin/Referer——
  // 浏览器握手恒带 Origin 且页面 JS 不可伪造，不在白名单 → 403 拒绝升级并记日志；
  // 缺失 Origin = 非浏览器客户端（CLI/本机工具），放行由会话 Cookie 兜底。
  // 默认判定是「同源」（Origin 的 host:port 与本次请求 Host 一致，反代头
  // X-Forwarded-Host/Proto 优先），不硬编码任何站点域名；跨域部署用
  // ZCODE_WS_ALLOWED_ORIGINS 追加（判定语义见 deviceCredentialAuth.isWsOriginAllowed）。
  // 接线形态：Origin 检查是注册在升级工厂**之前**的独立中间件（同 Hono compose 链，
  // 响应即短路，升级工厂不会被调用）——不包一层 wrapper（双调用/语义漂移风险）。
  const rejectDisallowedWsOrigin = async (c: Context, next: () => Promise<void>) => {
    if (deviceAuth.isWsOriginAllowed(c)) {
      await next();
      return;
    }
    const origin = c.req.header("origin") ?? c.req.header("referer") ?? "";
    log(`ws upgrade rejected: Origin not allowed (${origin}) path=${new URL(c.req.url).pathname}`);
    return c.json({ error: "origin_not_allowed" }, 403);
  };

  app.use("/ws", rejectDisallowedWsOrigin);
  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      const sessionToken = deviceAuth.sessionTokenFromContext(c);
      return {
        onOpen(_event, ws) {
          setupChannelServer(
            ws.raw as WebSocket,
            services,
            "web-remote-replayable",
            deviceAuth.wsGuard,
            sessionToken,
            options.windowController,
          );
        },
      };
    }),
  );
  // 非 WebSocket 的普通 GET /ws（带 Origin 的探活等）：升级工厂对 upgrade 头缺失的
  // 请求会调用 next()，落到这里给明确语义（原实现是 404）。
  app.get("/ws", (c) => c.json({ error: "expected_websocket_upgrade" }, 426));

  const upgradeTrustedHostWebSocket = upgradeWebSocket((c) => {
    const sessionToken = deviceAuth.sessionTokenFromContext(c);
    return {
      onOpen(_event, ws) {
        setupChannelServer(
          ws.raw as WebSocket,
          services,
          "desktop-continuous",
          deviceAuth.wsGuard,
          sessionToken,
          options.windowController,
        );
      },
    };
  });
  // /ws/host 双闸顺序：先 capability 票（一次性 401），再 Origin 白名单
  // （403）。本部署无桌面客户端，此通道无实际流量；豁免会话 Cookie 的语义不变。
  app.use("/ws/host", async (c, next) => {
    const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!hostCapabilities.consume(capability)) {
      return c.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.use("/ws/host", rejectDisallowedWsOrigin);
  app.get("/ws/host", upgradeTrustedHostWebSocket);

  // Web 模式下发起远程连接
  app.post("/api/connect-remote", async (c) => {
    const rawBody = await c.req.json();
    const parsedBody = remoteTargetSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsedBody.error)}` }, 400);
    }
    const body = parsedBody.data;

    try {
      const backend = await createRemoteBackend(body);
      const connection = await connectRemote(backend);
      const id = generateId();
      remoteConnections.set(id, connection);

      return c.json({ id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  const handleBotCallback = async (c: Context) => {
    const provider = c.req.param("provider") as BotProvider;
    if (!botProviders.includes(provider)) {
      return c.json({ error: `Unsupported provider: ${provider}` }, 400);
    }
    if (provider !== "webhook") {
      return c.json({ error: `Provider ${provider} does not support HTTP callbacks.` }, 400);
    }
    const botsService = services.getOptional(IBotsService);
    if (!botsService) {
      return c.json({ error: "Bots service is not available." }, 503);
    }
    const rawBodyText = await c.req.text().catch(() => "");
    let rawBody: unknown = {};
    if (rawBodyText) {
      try {
        rawBody = JSON.parse(rawBodyText) as unknown;
      } catch {
        rawBody = { payload: rawBodyText };
      }
    }
    const webhookSecret = c.req.header("x-zcode-bot-secret");
    const botId = c.req.param("botId");
    const result = await botsService.handleProviderCallbackResponse(provider, {
      ...(typeof rawBody === "object" && rawBody !== null ? rawBody : { payload: rawBody }),
      rawBody: rawBodyText,
      ...(botId ? { botId } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    });
    const responseBody = result.responseBody ?? { ok: result.ok, replies: result.replies };
    if (result.status === 400) {
      return c.json(responseBody, 400);
    }
    if (result.status === 401) {
      return c.json(responseBody, 401);
    }
    if (result.status === 503) {
      // Bugfix：Bot 业务失败必须把可重试状态透传给 HTTP provider；返回 200 会让
      // webhook/网关误以为消息已消费，效果与提前提交 Telegram offset 相同。
      return c.json(responseBody, 503);
    }
    return c.json(responseBody, 200);
  };

  app.post("/api/bots/:provider", handleBotCallback);
  app.post("/api/bots/:provider/:botId", handleBotCallback);

  // 远程连接的 WebSocket 端点，将远程 services 桥接给浏览器
  app.use("/ws/remote/:id", rejectDisallowedWsOrigin);
  app.get(
    "/ws/remote/:id",
    upgradeWebSocket((c) => {
      const id = c.req.param("id");
      const sessionToken = deviceAuth.sessionTokenFromContext(c);
      return {
        onOpen(_event, ws) {
          if (!id) {
            ws.close(4000, "Missing remote connection id");
            return;
          }
          const connection = remoteConnections.get(id);
          if (!connection) {
            ws.close(4004, "Remote connection not found");
            return;
          }
          // 一个连接只给一个 WS 客户端使用，取出后从 Map 移除
          remoteConnections.delete(id);

          // 将远程 services 包装为 ServiceCollection，复用 exposeOnChannelServer 统一注册
          const remoteServices = new ServiceCollection()
            .register(IFileService, connection.services.fileService)
            .register(IGitService, connection.services.gitService)
            .register(ISystemService, connection.services.systemService)
            .register(ITerminalService, connection.services.terminalService);

          setupChannelServer(
            ws.raw as WebSocket,
            remoteServices,
            "web-remote-replayable",
            deviceAuth.wsGuard,
            sessionToken,
          );
        },
      };
    }),
  );

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(staticRoot, pathname, options.spaFallback ?? true);
      if (!filePath) {
        return c.notFound();
      }
      // 设备凭据模式下，SPA 入口页（根路径与 SPA fallback 落到的 index.html）在
      // 未持有效会话时跳转登录页，而不是让用户卡在"连接断开"的报错界面上。
      // 真实静态资源（bundle/sw.js/图标）不受影响；API 与 WS 保持 401 原语义。
      // 判定用"解析结果是否 index.html"而非路径名——SPA 任意路由都落同一入口。
      // 自愈机制：会话失效但带续期 Cookie 时 admitOrRenew 会静默换发
      // 新会话（Set-Cookie 随响应下发）并放行，用户重启服务后不再被迫重配对。
      if (filePath.endsWith("index.html") && !(await deviceAuth.admitOrRenew(c))) {
        return c.redirect("/api/pairing/page", 302);
      }
      // sw.js 必须返回 no-cache：SW 更新检查依赖浏览器字节对比，immutable 会让
      // 缓存版本永远无法失效（shell 缓存随之僵死）。
      const isServiceWorker = filePath.endsWith("sw.js");
      return c.body(await readFile(filePath), 200, {
        "Cache-Control":
          filePath.endsWith("index.html") || isServiceWorker
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  const server = serve({ fetch: app.fetch, hostname: options.host, port }, () => {
    const address = server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    const listenHost = options.host?.trim() || "localhost";
    log(`http://${listenHost}:${listenPort}`);
  });

  injectWebSocket(server);

  return server;
}
