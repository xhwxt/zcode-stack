// relay-common.mjs —— relay-v29 去 token 化的可测试核心（纯逻辑，无监听/无文件副作用）
// 三块能力：
//   createTicketStore    一次性门票表（内存 Map：10 分钟 TTL、入口单次、页面会话期有效）
//   createSessionVerifier浏览器设备会话 Cookie 校验（透传 3030 /api/server-info，带缓存）
//   createLocalSession   relay 系统设备凭据 → /api/auth/renew 换会话（collectBootstrap 用）
// 设计依据（勘察结论）：
//   - 3030 设备凭据模型：会话 Cookie zcode_device_session / __Host-zcode_device_session，
//     续期 Cookie zcode_device_renew（值=deviceToken，只许调 renew）；/api/auth/renew 收
//     body.deviceToken 返回 {sessionToken,...}；/api/server-info 只认会话 Cookie（401/200）。
//   - 门票语义：入口（/web-remote?ticket= 或 POST /api/relay/ticket 签发后的入口跳转）
//     单次消费；消费后 10 分钟内页面走 bootstrap/WS/bridge 均有效（reload 自愈不破），
//     过期即死。API 侧要求 entryUsed=true —— 未经入口的票不能直接打 API。
import { randomBytes } from 'node:crypto';

/* ---------- 一次性门票表 ---------- */
export function createTicketStore({
  ttlMs = 10 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  /** ticket(32hex) -> { issuedAt, expiresAt, entryUsed } */
  const map = new Map();

  function sweep() {
    const t = now();
    for (const [k, v] of map) if (t >= v.expiresAt) map.delete(k);
  }

  /** 签发一张票。entered=true 表示「签发即入場」（裸 /web-remote 自助签发场景），
   *  常规 POST /api/relay/ticket 签发的票要经 ?ticket= 入口消费。 */
  function issue({ entered = false } = {}) {
    sweep();
    const ticket = randomBytes(16).toString('hex');
    const t = now();
    map.set(ticket, { issuedAt: t, expiresAt: t + ttlMs, entryUsed: !!entered });
    return { ticket, expiresAt: map.get(ticket).expiresAt };
  }

  /** 入口消费：票存在、未过期、未用过入口 → true（并标记）。单次。 */
  function consumeEntry(ticket) {
    sweep();
    const e = map.get(String(ticket || ''));
    if (!e || e.entryUsed || now() >= e.expiresAt) return false;
    e.entryUsed = true;
    return true;
  }

  /** API/WS 端点授权：票存在、未过期、且已经过入口。 */
  function apiActive(ticket) {
    sweep();
    const e = map.get(String(ticket || ''));
    return !!e && e.entryUsed && now() < e.expiresAt;
  }

  return {
    issue,
    consumeEntry,
    apiActive,
    sweep,
    get size() { return map.size; },
  };
}

/* ---------- 浏览器会话 Cookie 校验（透传 3030） ---------- */
export const SESSION_COOKIE_NAMES = ['__Host-zcode_device_session', 'zcode_device_session'];

/** 从 Cookie 头里挑出第一个存在的会话 Cookie 值（无则 ''） */
export function pickSessionCookie(header, names = SESSION_COOKIE_NAMES) {
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (names.includes(name)) return part.slice(eq + 1).trim();
  }
  return '';
}

export function createSessionVerifier({
  origin = 'http://127.0.0.1:3030',
  fetchImpl = fetch,
  now = () => Date.now(),
  positiveTtlMs = 30_000, // 校验通过缓存 30s（页面一个加载周期内多次端点调用不重复打 3030）
  negativeTtlMs = 5_000,  // 校验失败短缓存（用户重新配对后能很快进来）
} = {}) {
  /** cookieValue -> { ok, at } */
  const cache = new Map();

  function cached(value) {
    const hit = cache.get(value);
    if (!hit) return null;
    const ttl = hit.ok ? positiveTtlMs : negativeTtlMs;
    if (now() - hit.at >= ttl) { cache.delete(value); return null; }
    return hit.ok;
  }

  /**
   * 校验请求的会话 Cookie。
   * 返回 { ok, reason }：reason ∈ 'no-cookie' | 'invalid' | 'server-unreachable' | 'ok'
   * 3030 不可达时 fail closed（ok=false, reason='server-unreachable'）——调用方区分 401/502。
   */
  async function verify(cookieHeader) {
    const value = pickSessionCookie(cookieHeader);
    if (!value) return { ok: false, reason: 'no-cookie' };
    const hit = cached(value);
    if (hit !== null) return { ok: hit, reason: hit ? 'ok' : 'invalid' };
    let ok = false;
    let reason = 'invalid';
    try {
      const r = await fetchImpl(origin + '/api/server-info', {
        headers: { cookie: `zcode_device_session=${value}` },
      });
      ok = r.status === 200;
    } catch {
      ok = false;
      reason = 'server-unreachable';
    }
    cache.set(value, { ok, at: now() });
    if (cache.size > 512) cache.delete(cache.keys().next().value);
    return { ok, reason: ok ? 'ok' : reason };
  }

  return { verify, pick: pickSessionCookie, get cacheSize() { return cache.size; } };
}

/* ---------- relay 系统设备凭据 → 会话（collectBootstrap 用） ---------- */
export function createLocalSession({
  origin = 'http://127.0.0.1:3030',
  deviceToken = '',
  fetchImpl = fetch,
  now = () => Date.now(),
  renewIntervalMs = 6 * 60 * 60 * 1000, // 会话 12h，6h 主动换新（renew 限流 600/10min，绰绰有余）
  onEvent = () => {},                    // (kind, message) 日志钩子
} = {}) {
  let session = null; // { token, at }
  let inflight = null;
  let authDead = false; // 401：设备被撤销/过期 —— 不再反复打 renew，等外部换凭据重启

  async function renew() {
    let r;
    try {
      r = await fetchImpl(origin + '/api/auth/renew', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceToken }),
      });
    } catch (e) {
      throw new Error('renew 网络失败: ' + e.message);
    }
    if (r.status === 401) {
      authDead = true;
      throw new Error('renew 401：relay 系统设备凭据已失效（被撤销/过期），需重新生成 ZCODE_RELAY_LOCAL_SESSION');
    }
    if (!r.ok) throw new Error('renew HTTP ' + r.status);
    const j = await r.json();
    if (!j || typeof j.sessionToken !== 'string' || !j.sessionToken) {
      throw new Error('renew 响应缺 sessionToken');
    }
    return j.sessionToken;
  }

  /** 返回可用的 Cookie 头（未配置凭据/换发失败 → ''，调用方降级）。 */
  async function cookieHeader() {
    if (!deviceToken) return '';
    if (authDead) return '';
    if (session && now() - session.at < renewIntervalMs) {
      return 'zcode_device_session=' + session.token;
    }
    if (!inflight) {
      inflight = renew()
        .then((token) => {
          session = { token, at: now() };
          onEvent('renewed', 'relay 本地会话已换发');
          return session;
        })
        .finally(() => { inflight = null; })
        .catch((e) => {
          onEvent('renew-failed', e.message);
          return null;
        });
    }
    const s = await inflight;
    return s ? 'zcode_device_session=' + s.token : '';
  }

  /** server-info 401 时作废缓存会话（下次调用重换发）。 */
  function invalidate() {
    session = null;
  }

  return { cookieHeader, invalidate, get hasCredential() { return !!deviceToken; }, get isAuthDead() { return authDead; } };
}
