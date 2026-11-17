/* eslint-disable max-lines -- 设备管理页整页中文文案、错误分类与设备行/配对码子组件
 * 天然超出 400 行上限；拆散会让"独立页面自包含"的交付形态变得难读，
 * 与 share/ConversationShareLandingPage.tsx 采用同一豁免做法。 */
/* 设备管理页（独立路由 /devices）：不进 Root 组件树、不接 services/RPC，
 * 纯 React + fetch 对接 /api/me/*（会话 Cookie 鉴权，POST 带 x-zcode-csrf 头）。
 * 模式对齐 share/ConversationShareLandingPage.tsx 的独立页面做法：
 * 由 main.tsx 在 bootstrap 阶段按 pathname 直接渲染，样式取 <html> 主题 class 的 CSS 变量。 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import "./DeviceManagerPage.css";

/** GET /api/me/devices 返回的设备条目（字段名与服务端 API 形状逐字对齐，时间 epoch ms）。 */
interface ManagedDevice {
  id: string;
  label: string;
  temporary: boolean;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

interface PairingCodeIssued {
  code: string;
  expiresAt: number;
}

/** 统一错误分类：决定横幅/整页文案与是否引导去配对页。 */
type PageErrorKind = "network" | "temporary_forbidden" | "auth_expired" | "server";

/** 临时设备可指定的有效期（小时）。168 = 7 天，与服务端 ttlHours 上限一致。 */
const TTL_CHOICES: readonly number[] = [1, 6, 12, 24, 48, 72, 168];
const DEFAULT_TTL_HOURS = 24;
const DEFAULT_DEVICE_LABEL = "新设备";
/** 配对码有效期固定 10 分钟（服务端 PAIRING_CODE_TTL_MS），仅用于结果区文案。 */
const PAIRING_CODE_TTL_TEXT = "10 分钟";

const CSRF_COOKIE_NAME = "zcode_device_csrf";
const CSRF_HEADER_NAME = "x-zcode-csrf";
const PAIRING_PAGE_URL = "/api/pairing/page";

function goToPairingPage(): void {
  // 服务端对无/失效会话会把 index.html 302 到配对页；会话过期时这里主动走同一入口。
  window.location.replace(PAIRING_PAGE_URL);
}

function readCsrfCookie(): string {
  const prefix = `${CSRF_COOKIE_NAME}=`;
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) {
      return decodeURIComponent(value.slice(prefix.length));
    }
  }
  return "";
}

/** 页面进入先续期一次：服务端 302 门禁只挡无会话，"有续期 Cookie 但会话已过期"的情形靠这里续上。 */
async function renewSessionOnce(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/renew", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return response.ok;
  } catch {
    return false;
  }
}

interface ApiFailure {
  kind: PageErrorKind;
}

/** fetch 包装：全部 same-origin + no-store；POST 统一带 x-zcode-csrf 头；JSON 解析失败不抛裸异常。 */
async function callApi(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<{ ok: true; data: unknown } | { ok: false; failure: ApiFailure }> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        [CSRF_HEADER_NAME]: readCsrfCookie(),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    return { ok: false, failure: { kind: "network" } };
  }
  if (response.status === 401) {
    return { ok: false, failure: { kind: "auth_expired" } };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // 非 JSON（如网关错误页）：保持 payload 为 null，按状态码分类。
  }
  const record = payload && typeof payload === "object" ? (payload as { error?: unknown }) : null;
  if (!response.ok) {
    if (response.status === 403 && record?.error === "forbidden") {
      // 临时设备调 /api/me/* 一律 403 {error:"forbidden"} → 转成"临时设备无管理权限"提示。
      return { ok: false, failure: { kind: "temporary_forbidden" } };
    }
    return { ok: false, failure: { kind: "server" } };
  }
  return { ok: true, data: payload };
}

function parseDeviceList(data: unknown): ManagedDevice[] {
  if (!data || typeof data !== "object") return [];
  const devices = (data as { devices?: unknown }).devices;
  if (!Array.isArray(devices)) return [];
  const parsed: ManagedDevice[] = [];
  for (const entry of devices) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.label !== "string") continue;
    parsed.push({
      id: row.id,
      label: row.label,
      temporary: row.temporary === true,
      createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
      expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : 0,
      lastSeenAt: typeof row.lastSeenAt === "number" ? row.lastSeenAt : 0,
    });
  }
  // 列表不做"本机"猜测标注（需求明确）：仅按创建时间排序，保持稳定可读。
  parsed.sort((a, b) => a.createdAt - b.createdAt);
  return parsed;
}

function formatTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return "未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(epochMs),
  );
}

function formatRemaining(epochMs: number): string {
  const remainingMs = epochMs - Date.now();
  if (remainingMs <= 0) return "已到期";
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 1) return "不足 1 分钟";
  if (minutes < 60) return `剩 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `剩 ${hours} 小时`;
  return `剩 ${Math.floor(hours / 24)} 天`;
}

const ERROR_TEXT: Record<PageErrorKind, string> = {
  network: "网络请求失败，请检查网络后重试。",
  temporary_forbidden: "当前登录的是临时设备，临时设备没有管理权限，无法管理设备或生成配对码。",
  auth_expired: "登录状态已失效，需要重新配对。",
  server: "服务暂时不可用，请稍后重试。",
};

function ErrorBanner({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="dm-banner" role="alert">
      <span className="dm-banner-text">{text}</span>
      <button type="button" className="dm-btn" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

function DeviceRow({
  device,
  busy,
  confirming,
  onRequestConfirm,
  onCancelConfirm,
  onConfirmRevoke,
  onRename,
}: {
  device: ManagedDevice;
  busy: boolean;
  confirming: boolean;
  onRequestConfirm: (id: string) => void;
  onCancelConfirm: (id: string) => void;
  onConfirmRevoke: (device: ManagedDevice) => void;
  onRename: (device: ManagedDevice, label: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(device.label);
  const startEdit = () => {
    setDraftLabel(device.label);
    setEditing(true);
  };
  const submitRename = () => {
    const trimmed = draftLabel.trim();
    if (!trimmed || trimmed === device.label) {
      setEditing(false);
      return;
    }
    onRename(device, trimmed);
    setEditing(false);
  };
  return (
    <li className="dm-device-row">
      <div className="dm-device-main">
        {editing ? (
          <div className="dm-rename-box">
            <input
              className="dm-input"
              type="text"
              value={draftLabel}
              maxLength={80}
              autoFocus
              aria-label="设备名称"
              onChange={(event) => setDraftLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitRename();
                if (event.key === "Escape") setEditing(false);
              }}
            />
            <button
              type="button"
              className="dm-btn dm-btn-primary"
              disabled={busy}
              onClick={submitRename}
            >
              保存
            </button>
            <button type="button" className="dm-btn" disabled={busy} onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        ) : (
          <div className="dm-device-label-row">
            <span className="dm-device-name">{device.label}</span>
            {device.temporary ? (
              <>
                <span className="dm-badge-temp">临时</span>
                <span className="dm-badge-remaining">{formatRemaining(device.expiresAt)}</span>
              </>
            ) : null}
            <button type="button" className="dm-btn" disabled={busy} onClick={startEdit}>
              改名
            </button>
          </div>
        )}
        <div className="dm-device-meta">
          <span>创建：{formatTimestamp(device.createdAt)}</span>
          <span>最后活跃：{formatTimestamp(device.lastSeenAt)}</span>
          <span>到期：{formatTimestamp(device.expiresAt)}</span>
        </div>
      </div>
      <div className="dm-device-actions">
        {confirming ? (
          <>
            <span className="dm-confirm-hint">撤销后该设备立即失联，需重新配对。</span>
            <button
              type="button"
              className="dm-btn-danger-solid"
              disabled={busy}
              onClick={() => onConfirmRevoke(device)}
            >
              确认撤销
            </button>
            <button
              type="button"
              className="dm-btn"
              disabled={busy}
              onClick={() => onCancelConfirm(device.id)}
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            className="dm-btn-danger"
            disabled={busy}
            onClick={() => onRequestConfirm(device.id)}
          >
            撤销
          </button>
        )}
      </div>
    </li>
  );
}

function PairingResult({
  result,
  onCopy,
  onDismiss,
  copied,
}: {
  result: PairingCodeIssued;
  onCopy: () => void;
  onDismiss: () => void;
  copied: boolean;
}) {
  return (
    <div className="dm-pair-result" role="status">
      <div className="dm-pair-code-row">
        <span className="dm-pair-code">{result.code}</span>
        <button type="button" className="dm-btn dm-btn-primary" onClick={onCopy}>
          {copied ? "已复制" : "复制"}
        </button>
        <button type="button" className="dm-btn" onClick={onDismiss}>
          收起
        </button>
      </div>
      <p className="dm-pair-note">
        有效期 {PAIRING_CODE_TTL_TEXT}（至 {formatTimestamp(result.expiresAt)}）。
      </p>
      <p className="dm-pair-note">
        在新设备上打开 {window.location.origin}/login 输入此码完成配对。
      </p>
      <p className="dm-pair-warn">配对码用完即焚，不要转发给他人。</p>
      <p className="dm-pair-note">生成新码会作废之前尚未使用的旧码（全局同时只有一个有效配对码）。</p>
    </div>
  );
}

function StatusCard({
  title,
  text,
  retryLabel,
  onRetry,
}: {
  title: string;
  text: string;
  retryLabel?: string;
  onRetry?: () => void;
}) {
  return (
    <main className="dm-page">
      <div className="dm-status-wrap">
        <section className="dm-status-card">
          <div className="dm-status-brand">ZCode</div>
          <h1 className="dm-status-title">{title}</h1>
          <p className="dm-status-text">{text}</p>
          {retryLabel && onRetry ? (
            <div className="dm-status-actions">
              <button type="button" className="dm-btn" onClick={onRetry}>
                {retryLabel}
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

export function DeviceManagerPage() {
  // 加载态由 devices === null 表达：首次 loadDevices 完成前列表必然为 null。
  const [devices, setDevices] = useState<ManagedDevice[] | null>(null);
  const [error, setError] = useState<PageErrorKind | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const [pairLabel, setPairLabel] = useState(DEFAULT_DEVICE_LABEL);
  const [temporary, setTemporary] = useState(false);
  const [ttlHours, setTtlHours] = useState(DEFAULT_TTL_HOURS);
  const [pairResult, setPairResult] = useState<PairingCodeIssued | null>(null);
  const [pairCopied, setPairCopied] = useState(false);

  const loadDevices = useCallback(async (): Promise<boolean> => {
    const result = await callApi("/api/me/devices", { method: "GET" });
    if (!result.ok) {
      setError(result.failure.kind);
      return false;
    }
    setDevices(parseDeviceList(result.data));
    setError(null);
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 启动续期一次：会话已过期但有续期 Cookie 时在此续上，再拉列表。
      await renewSessionOnce();
      if (cancelled) return;
      await loadDevices();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadDevices]);

  const handleRetry = useCallback(() => {
    if (error === "auth_expired") {
      goToPairingPage();
      return;
    }
    void loadDevices();
  }, [error, loadDevices]);

  const withBusy = useCallback(async (action: () => Promise<void>) => {
      setActionBusy(true);
      try {
        await action();
      } finally {
        setActionBusy(false);
      }
    },
    [],
  );

  const handleRevoke = useCallback(
    (device: ManagedDevice) =>
      void withBusy(async () => {
        const result = await callApi("/api/me/devices/revoke", {
          method: "POST",
          body: { id: device.id },
        });
        if (!result.ok) {
          setError(result.failure.kind);
          return;
        }
        setConfirmingId(null);
        await loadDevices();
      }),
    [loadDevices, withBusy],
  );

  const handleRename = useCallback(
    (device: ManagedDevice, label: string) =>
      void withBusy(async () => {
        const result = await callApi("/api/me/devices/rename", {
          method: "POST",
          body: { id: device.id, label },
        });
        if (!result.ok) {
          setError(result.failure.kind);
          return;
        }
        await loadDevices();
      }),
    [loadDevices, withBusy],
  );

  const handleIssuePairingCode = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void withBusy(async () => {
        setPairCopied(false);
        // ttlHours 提供 = 临时设备；不提供 = 正式设备。字段名与 API 形状逐字对齐。
        const body: { label: string; ttlHours?: number } = {
          label: pairLabel.trim() || DEFAULT_DEVICE_LABEL,
        };
        if (temporary) {
          body.ttlHours = ttlHours;
        }
        const result = await callApi("/api/me/pairing-code", { method: "POST", body });
        if (!result.ok) {
          setError(result.failure.kind);
          return;
        }
        const data = result.data as Record<string, unknown>;
        const code = typeof data.code === "string" ? data.code : "";
        const expiresAt = typeof data.expiresAt === "number" ? data.expiresAt : 0;
        if (!code) {
          setError("server");
          return;
        }
        setPairResult({ code, expiresAt });
      });
    },
    [pairLabel, temporary, ttlHours, withBusy],
  );

  const handleCopy = useCallback(() => {
    if (!pairResult) return;
    // clipboard 在非安全上下文可能不存在：整体判空，避免对 undefined 调 .then 抛错。
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setPairCopied(false);
      return;
    }
    void clipboard.writeText(pairResult.code).then(
      () => setPairCopied(true),
      () => setPairCopied(false),
    );
  }, [pairResult]);

  const sortedDevices = useMemo(() => devices ?? [], [devices]);

  // 整页状态：鉴权失效 → 引导重新配对；临时设备 → 无权限说明（所有管理操作都会 403，
  // 页面没有可用动作，整页说明比半残列表更诚实）；首次加载失败 → 整页错误 + 重试。
  if (error === "auth_expired") {
    return (
      <StatusCard
        title="登录状态已失效"
        text="这台设备的会话已过期或已被撤销，请重新配对后再管理设备。"
        retryLabel="去重新配对"
        onRetry={goToPairingPage}
      />
    );
  }
  if (error === "temporary_forbidden") {
    return <StatusCard title="临时设备无管理权限" text={ERROR_TEXT.temporary_forbidden} />;
  }
  if (devices === null) {
    return (
      <StatusCard
        title={error === null ? "正在加载设备列表" : "暂时无法加载设备"}
        text={error === null ? "请稍候……" : ERROR_TEXT[error]}
        retryLabel="重试"
        onRetry={error === null ? undefined : handleRetry}
      />
    );
  }

  return (
    <main className="dm-page">
      <div className="dm-container">
        <header>
          <div className="dm-brand">ZCode</div>
          <h1 className="dm-title">设备管理</h1>
          <p className="dm-subtitle">
            正式设备连续 90 天不活跃才需要重新配对（每次使用自动续期）；临时设备到期后自动失效。
          </p>
        </header>

        {error !== null ? <ErrorBanner text={ERROR_TEXT[error]} onRetry={handleRetry} /> : null}

        <section className="dm-card" aria-label="已配对设备">
          <h2 className="dm-card-title">已配对设备</h2>
          <p className="dm-card-hint">
            撤销或改名立即生效；列表不标注哪台是当前浏览器，请按名称与时间自行辨认。
          </p>
          {sortedDevices.length === 0 ? (
            <p className="dm-empty">
              当前没有已配对的设备——这不正常，因为你正用某个设备登录着。请刷新或重新配对。
            </p>
          ) : (
            <ul className="dm-device-list">
              {sortedDevices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  busy={actionBusy}
                  confirming={confirmingId === device.id}
                  onRequestConfirm={setConfirmingId}
                  onCancelConfirm={setConfirmingId}
                  onConfirmRevoke={handleRevoke}
                  onRename={handleRename}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="dm-card" aria-label="生成配对码">
          <h2 className="dm-card-title">生成配对码</h2>
          <p className="dm-card-hint">在新设备上输入配对码即可登录这台服务器。</p>
          <form className="dm-form" onSubmit={handleIssuePairingCode}>
            <div className="dm-form-row">
              <label className="dm-form-label" htmlFor="dm-pair-label">
                设备名称
              </label>
              <input
                id="dm-pair-label"
                className="dm-input"
                type="text"
                value={pairLabel}
                maxLength={80}
                placeholder={DEFAULT_DEVICE_LABEL}
                onChange={(event) => setPairLabel(event.target.value)}
              />
            </div>
            <div className="dm-form-row">
              <label className="dm-checkbox">
                <input
                  type="checkbox"
                  checked={temporary}
                  onChange={(event) => setTemporary(event.target.checked)}
                />
                临时设备（到期自动失效）
              </label>
              {temporary ? (
                <label className="dm-form-row">
                  <span className="dm-form-label">有效期</span>
                  <select
                    className="dm-select"
                    value={ttlHours}
                    onChange={(event) => setTtlHours(Number(event.target.value))}
                    aria-label="临时设备有效期（小时）"
                  >
                    {TTL_CHOICES.map((hours) => (
                      <option key={hours} value={hours}>
                        {hours} 小时
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <div className="dm-form-row">
              <button type="submit" className="dm-btn dm-btn-primary" disabled={actionBusy}>
                {actionBusy ? "正在处理……" : "生成配对码"}
              </button>
            </div>
          </form>
          {pairResult ? (
            <PairingResult
              result={pairResult}
              copied={pairCopied}
              onCopy={handleCopy}
              onDismiss={() => setPairResult(null)}
            />
          ) : null}
        </section>
      </div>
    </main>
  );
}

export default DeviceManagerPage;
