/* 用量页（/usage）：不装状态栏插件的浏览器用户的 token 用量入口（独立路由，与 /devices 同构）。
 * 不进 Root 组件树、不接 services/RPC——纯 React + fetch 对接 GET /api/me/usage-summary
 * （会话 Cookie 鉴权）。由 main.tsx 在 bootstrap 阶段按 pathname 直接渲染。
 *
 * 端点形状（服务端接口约定；端点未上线时页面显示"服务端未就绪"提示，不报错）：
 *   {
 *     todayTokens: number;      // 今日 token 消耗（估算）
 *     todayRequests: number;    // 今日请求数
 *     rpm: number;              // 最近 1 分钟请求数
 *     tpm: number;              // 最近 1 分钟 token 数
 *     hourly24h?: Array<{ hourISO: string; tokens: number }>; // 近 24h 逐时 token（可选，条形图）
 *     generatedAt?: number;     // epoch ms（可选）
 *   }
 */
import { useCallback, useEffect, useState } from "react";
import "./UsagePage.css";

interface UsageHourBucket {
  hourISO: string;
  tokens: number;
}

interface UsageSummary {
  todayTokens: number;
  todayRequests: number;
  rpm: number;
  tpm: number;
  hourly24h?: UsageHourBucket[];
  generatedAt?: number;
}

type PageState =
  | { kind: "loading" }
  | { kind: "ready"; data: UsageSummary }
  | { kind: "auth_expired" }
  | { kind: "error"; text: string };

function goToPairingPage(): void {
  // 会话过期：与服务端 302 门禁同一入口。
  window.location.replace("/api/pairing/page");
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString("zh-CN");
}

function formatHourLabel(hourISO: string): string {
  const date = new Date(hourISO);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:00`;
}

/** 拉取用量：非 200 一律转成文本错误，401 引导重新配对；端点未上线（404）给出专用提示。 */
async function fetchUsageSummary(): Promise<PageState> {
  let response: Response;
  try {
    response = await fetch("/api/me/usage-summary", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { kind: "error", text: "网络请求失败，请检查网络后重试。" };
  }
  if (response.status === 401) {
    return { kind: "auth_expired" };
  }
  if (response.status === 404) {
    return {
      kind: "error",
      text: "服务端尚未提供用量接口（/api/me/usage-summary 不存在），待服务端上线后此页自动可用。",
    };
  }
  if (!response.ok) {
    return { kind: "error", text: `服务暂时不可用（HTTP ${response.status}），请稍后重试。` };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "error", text: "用量接口返回了无法解析的数据。" };
  }
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const hourlyRaw = Array.isArray(record.hourly24h) ? record.hourly24h : [];
  const hourly24h: UsageHourBucket[] = [];
  for (const entry of hourlyRaw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.hourISO !== "string") continue;
    hourly24h.push({ hourISO: row.hourISO, tokens: num(row.tokens) });
  }
  return {
    kind: "ready",
    data: {
      todayTokens: num(record.todayTokens),
      todayRequests: num(record.todayRequests),
      rpm: num(record.rpm),
      tpm: num(record.tpm),
      ...(hourly24h.length > 0 ? { hourly24h } : {}),
      ...(typeof record.generatedAt === "number" ? { generatedAt: record.generatedAt } : {}),
    },
  };
}

/** 24h 条形图：有 hourly24h 数据时按 24 桶渲染（不足补空桶占位），无数据时整卡隐藏。 */
function HourlyChart({ buckets }: { buckets: UsageHourBucket[] }) {
  if (buckets.length === 0) return null;
  const tokensAt = (index: number): number | null =>
    index < buckets.length ? (buckets[index]?.tokens ?? 0) : null;
  const padded: (number | null)[] = [];
  for (let i = 0; i < 24; i += 1) {
    padded.push(tokensAt(i));
  }
  const max = padded.reduce<number>((acc, value) => Math.max(acc, value ?? 0), 0);
  const firstLabel = formatHourLabel(buckets[0]?.hourISO ?? "");
  const lastLabel = formatHourLabel(buckets[buckets.length - 1]?.hourISO ?? "");
  return (
    <section className="us-card us-card-chart" aria-label="近 24 小时用量">
      <h2 className="us-card-label">近 24 小时逐时用量</h2>
      <div
        className="us-chart"
        role="img"
        aria-label={`近 24 小时 token 用量条形图，峰值 ${formatTokenCount(max)}`}
      >
        {padded.map((value, index) => {
          const heightPercent = value && max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
          return value !== null && heightPercent > 0 ? (
            <div
              key={index}
              className="us-chart-bar"
              style={{ height: `${heightPercent}%` }}
              title={`${formatHourLabel(buckets[index]?.hourISO ?? "")} · ${formatTokenCount(value)}`}
            />
          ) : (
            <div key={index} className="us-chart-bar-empty" style={{ height: "2px" }} />
          );
        })}
      </div>
      <div className="us-chart-axis">
        <span>{firstLabel}</span>
        <span>{lastLabel}</span>
      </div>
    </section>
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
    <main className="us-page">
      <div className="us-status-wrap">
        <section className="us-status-card">
          <div className="us-status-brand">ZCode</div>
          <h1 className="us-status-title">{title}</h1>
          <p className="us-status-text">{text}</p>
          {retryLabel && onRetry ? (
            <div className="us-status-actions">
              <button type="button" className="us-btn" onClick={onRetry}>
                {retryLabel}
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

export function UsagePage() {
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setState(await fetchUsageSummary());
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "auth_expired") {
    return (
      <StatusCard
        title="登录状态已失效"
        text="这台设备的会话已过期或已被撤销，请重新配对后再查看用量。"
        retryLabel="去重新配对"
        onRetry={goToPairingPage}
      />
    );
  }
  if (state.kind === "loading") {
    return <StatusCard title="正在加载用量" text="请稍候……" />;
  }
  if (state.kind === "error") {
    return (
      <StatusCard title="暂时无法获取用量" text={state.text} retryLabel="重试" onRetry={() => void load()} />
    );
  }

  const data = state.data;
  return (
    <main className="us-page">
      <div className="us-container">
        <header>
          <div className="us-brand">ZCode</div>
          <h1 className="us-title">用量</h1>
          <p className="us-subtitle">
            今日 token 消耗与请求速率概览。
            {data.generatedAt ? ` 数据时间：${new Date(data.generatedAt).toLocaleTimeString("zh-CN")}。` : ""}
          </p>
        </header>

        <div className="us-cards">
          <section className="us-card" aria-label="今日 token 消耗">
            <h2 className="us-card-label">今日 token</h2>
            <p className="us-card-value">{formatTokenCount(data.todayTokens)}</p>
            <p className="us-card-hint">估算值，与状态栏口径一致</p>
          </section>
          <section className="us-card" aria-label="今日请求数">
            <h2 className="us-card-label">今日请求</h2>
            <p className="us-card-value">{data.todayRequests.toLocaleString("zh-CN")}</p>
            <p className="us-card-hint">次</p>
          </section>
          <section className="us-card" aria-label="每分钟请求数">
            <h2 className="us-card-label">RPM</h2>
            <p className="us-card-value">{data.rpm.toLocaleString("zh-CN")}</p>
            <p className="us-card-hint">最近 1 分钟请求数</p>
          </section>
          <section className="us-card" aria-label="每分钟 token 数">
            <h2 className="us-card-label">TPM</h2>
            <p className="us-card-value">{formatTokenCount(data.tpm)}</p>
            <p className="us-card-hint">最近 1 分钟 token</p>
          </section>
          <HourlyChart buckets={data.hourly24h ?? []} />
        </div>

        <div>
          <button
            type="button"
            className="us-btn us-btn-primary"
            disabled={refreshing}
            onClick={() => void load()}
          >
            {refreshing ? "正在刷新……" : "刷新"}
          </button>
        </div>
      </div>
    </main>
  );
}

export default UsagePage;
