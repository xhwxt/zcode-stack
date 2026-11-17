// 设备凭据鉴权测试（spec: packages/server/specs/device-credential-auth.md）
// 运行：从 packages/server 目录 `../../node_modules/.bin/tsx --test test/deviceCredentialAuth.test.ts`
//
// 覆盖：验收场景与全部对齐点。
// 不导入 http.ts（那会拖起整个 services 栈）；这里按 http.ts 的挂载顺序
// （routes → middleware → 业务路由）组装等价的最小 Hono app。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";

import {
  createDeviceCredentialAuth,
  isWsOriginAllowed,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_HOST_NAME,
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_HOST_NAME,
  RENEW_COOKIE_NAME,
  WS_REVOKE_CLOSE_CODE,
} from "../src/deviceCredentialAuth.js";

const ADMIN_SECRET = "test-admin-secret-0123456789abcdef";
const OLD_TOKEN = "deadbeef".repeat(8); // 旧单 token 模式的 64hex 形态

interface Fixture {
  dataDir: string;
  adminSecretPath: string;
  auth: Awaited<ReturnType<typeof createDeviceCredentialAuth>>;
  app: Hono;
  clock: { value: number; advance: (ms: number) => void };
  cleanup: () => Promise<void>;
  /** 模拟服务重启：同 dataDir 重建 auth + app（fx.auth/fx.app 原地替换）。 */
  restart: () => Promise<Fixture>;
}

async function makeFixture(): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "zcode-device-auth-"));
  const adminSecretPath = join(dataDir, "zcode-admin.secret");
  await writeFile(adminSecretPath, `${ADMIN_SECRET}\n`, { mode: 0o600 });
  const clock = {
    value: 1_700_000_000_000,
    advance(ms: number) {
      this.value += ms;
    },
  };
  const auth = await createDeviceCredentialAuth({
    dataBaseDir: dataDir,
    adminSecretPath,
    now: () => clock.value,
  });
  // 与 http.ts 相同的挂载顺序：先 routes（公开/管理），再 middleware（保护面），
  // 最后 /api/me/* 与业务路由。/api/server-info 代表"登录后可达"的保护面端点。
  const app = new Hono();
  app.route("/", auth.routes);
  app.use("*", auth.middleware);
  app.route("/", auth.meRoutes);
  app.get("/api/server-info", (c) => c.json({ ok: true, server: "test" }));
  app.post("/api/rpc-host-capability", (c) => c.json({ ok: true }));
  app.get("/ws", (c) => c.text("ws-endpoint"));
  // 代表 bots webhook 回调通道（http.ts 的 handleBotCallback；业务鉴权是
  // x-zcode-bot-secret，不走设备会话）。这里只验证中间件豁免，不测业务。
  app.post("/api/bots/:provider", (c) =>
    c.json({ reached: true, provider: c.req.param("provider") }),
  );
  app.post("/api/bots/:provider/:botId", (c) =>
    c.json({ reached: true, provider: c.req.param("provider"), botId: c.req.param("botId") }),
  );
  const cleanup = async () => {
    // 会话持久化后 createSession 等路径有异步落盘（writeChain 串行）：
    // dispose 停周期任务并等写链排空，避免落盘与 rmdir 竞态（ENOTEMPTY）。
    // 用 fx.auth（restart 后指向新实例）；dispose 幂等，重复调用无害。
    await fx.auth.dispose();
    await rm(dataDir, { recursive: true, force: true });
  };
  /** 模拟服务重启：dispose 旧实例 → 同一 dataDir 重建 → 按相同顺序重新挂载。 */
  const restart = async () => {
    await fx.auth.dispose();
    const revived = await createDeviceCredentialAuth({
      dataBaseDir: dataDir,
      adminSecretPath,
      now: () => clock.value,
    });
    const revivedApp = new Hono();
    revivedApp.route("/", revived.routes);
    revivedApp.use("*", revived.middleware);
    revivedApp.route("/", revived.meRoutes);
    revivedApp.get("/api/server-info", (c) => c.json({ ok: true, server: "test" }));
    fx.auth = revived;
    fx.app = revivedApp;
    return fx;
  };
  const fx: Fixture = {
    dataDir,
    adminSecretPath,
    auth,
    app,
    clock,
    cleanup,
    restart,
  };
  return fx;
}

/** 本机管理员请求头（测试通道无 socket，用 x-real-ip 声明回环；见 isAdminSourceLocal）。 */
function adminHeaders(secret: string | undefined, ip = "127.0.0.1"): Record<string, string> {
  const headers: Record<string, string> = { "x-real-ip": ip };
  if (secret !== undefined) {
    headers["x-zcode-admin"] = secret;
  }
  return headers;
}

function sessionCookieHeader(sessionToken: string): string {
  return `${SESSION_COOKIE_NAME}=${sessionToken}`;
}

/** 完整配对流程：创建配对码 → redeem → 返回凭据 + 会话。 */
async function pairDevice(
  fx: Fixture,
  label: string,
): Promise<{
  deviceId: string;
  deviceToken: string;
  deviceExpiresAt: number;
  sessionToken: string;
  csrfToken: string;
  sessionExpiresAt: number;
  instanceId: string;
}> {
  const createRes = await fx.app.request("/api/admin/pairing-code", {
    method: "POST",
    headers: adminHeaders(ADMIN_SECRET),
    body: JSON.stringify({ label }),
  });
  assert.equal(createRes.status, 200, "创建配对码应成功（fixture 已带本机+密钥）");
  const { code } = (await createRes.json()) as { code: string };
  const redeemRes = await fx.app.request("/api/pairing/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.10" },
    body: JSON.stringify({ code, label }),
  });
  assert.equal(redeemRes.status, 200, "redeem 应成功");
  return (await redeemRes.json()) as {
    deviceId: string;
    deviceToken: string;
    deviceExpiresAt: number;
    sessionToken: string;
    csrfToken: string;
    sessionExpiresAt: number;
    instanceId: string;
    sessionCookieName: string;
    csrfCookieName: string;
  };
}

test("启用条件：既无 admin secret 也无 devices.json 时拒绝创建（不允许裸奔）", async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), "zcode-device-auth-empty-"));
  try {
    await assert.rejects(
      createDeviceCredentialAuth({
        dataBaseDir: emptyDir,
        adminSecretPath: join(emptyDir, "nonexistent.secret"),
      }),
      /拒绝启动/,
    );
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
});

// ── 旧 token 任何形式一律 401 ──────────────────────────────────────────

test("旧 token 三种形式（URL ?token= / zcode_lite_token Cookie / x-zcode-lite-token 头）→ 401", async () => {
  const fx = await makeFixture();
  try {
    const query = await fx.app.request(`/api/server-info?token=${OLD_TOKEN}`);
    assert.equal(query.status, 401);
    assert.equal(((await query.json()) as { error: string }).error, "authentication_failed");

    const cookie = await fx.app.request("/api/server-info", {
      headers: { cookie: `zcode_lite_token=${OLD_TOKEN}` },
    });
    assert.equal(cookie.status, 401);

    const header = await fx.app.request("/api/server-info", {
      headers: { "x-zcode-lite-token": OLD_TOKEN },
    });
    assert.equal(header.status, 401);

    // 旧 cookie 名绝不能被会话中间件误认（会话只认 zcode_device_session[_host]）
    const ws = await fx.app.request("/ws", {
      headers: { cookie: `zcode_lite_token=${OLD_TOKEN}` },
    });
    assert.equal(ws.status, 401);
  } finally {
    await fx.cleanup();
  }
});

// ── 配对码过期/复用 → 403；未知 deviceToken → 401 ─────────────────

test("配对码复用 → 403", async () => {
  const fx = await makeFixture();
  try {
    const createRes = await fx.app.request("/api/admin/pairing-code", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ label: "手机" }),
    });
    const { code } = (await createRes.json()) as { code: string };
    const first = await fx.app.request("/api/pairing/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(first.status, 200);
    const second = await fx.app.request("/api/pairing/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(second.status, 403); // 配对失败以 403 为准
    assert.equal(((await second.json()) as { error: string }).error, "authentication_failed");
  } finally {
    await fx.cleanup();
  }
});

test("配对码过期（>10 分钟）→ 403", async () => {
  const fx = await makeFixture();
  try {
    const createRes = await fx.app.request("/api/admin/pairing-code", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ label: "手机" }),
    });
    const { code, expiresAt } = (await createRes.json()) as { code: string; expiresAt: number };
    fx.clock.advance(10 * 60 * 1000 + 1);
    assert.ok(fx.clock.value > expiresAt);
    const redeem = await fx.app.request("/api/pairing/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(redeem.status, 403);
  } finally {
    await fx.cleanup();
  }
});

test("全局单窗口：新配对码作废旧码", async () => {
  const fx = await makeFixture();
  try {
    const r1 = await fx.app.request("/api/admin/pairing-code", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ label: "旧码" }),
    });
    const { code: code1 } = (await r1.json()) as { code: string };
    const r2 = await fx.app.request("/api/admin/pairing-code", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ label: "新码" }),
    });
    const { code: code2 } = (await r2.json()) as { code: string };
    const oldRedeem = await fx.app.request("/api/pairing/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code1 }),
    });
    assert.equal(oldRedeem.status, 403);
    const newRedeem = await fx.app.request("/api/pairing/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code2 }),
    });
    assert.equal(newRedeem.status, 200);
  } finally {
    await fx.cleanup();
  }
});

test("未知 deviceToken：renew → 401，probe → 401", async () => {
  const fx = await makeFixture();
  try {
    const renew = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: "unknown-device-token" }),
    });
    assert.equal(renew.status, 401);
    assert.equal(((await renew.json()) as { error: string }).error, "authentication_failed");

    const probe = await fx.app.request("/api/auth/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: "unknown-device-token" }),
    });
    assert.equal(probe.status, 401);
  } finally {
    await fx.cleanup();
  }
});

test("设备凭据过期（90 天）：renew/probe → 401，必须重新配对", async () => {
  const fx = await makeFixture();
  try {
    const device = await pairDevice(fx, "过期测试");
    fx.clock.advance(90 * 24 * 60 * 60 * 1000 + 1);
    const renew = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    assert.equal(renew.status, 401);
    const probe = await fx.app.request("/api/auth/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    assert.equal(probe.status, 401);
  } finally {
    await fx.cleanup();
  }
});

// ── 设备独立 + 撤销即时 ─────────────────────────────────────────────

test("撤销 A：A 会话 401、A 的 WS 被 close(4401)、B 不受影响、A 凭据 renew 401", async () => {
  const fx = await makeFixture();
  try {
    const a = await pairDevice(fx, "设备A");
    const b = await pairDevice(fx, "设备B");
    assert.notEqual(a.deviceId, b.deviceId);

    // A 的活跃 WS 注册进撤销注册表（mock socket 断言 close 被调用）
    const closedByA: Array<{ code?: number; reason?: string }> = [];
    const mockSocketA = {
      on() {},
      close(code?: number, reason?: string) {
        closedByA.push({ code, reason });
      },
    };
    fx.auth.wsGuard.registerSocket(a.sessionToken, mockSocketA);
    const closedByB: Array<{ code?: number; reason?: string }> = [];
    const mockSocketB = {
      on() {},
      close(code?: number, reason?: string) {
        closedByB.push({ code, reason });
      },
    };
    fx.auth.wsGuard.registerSocket(b.sessionToken, mockSocketB);

    // 撤销前：A、B 的会话都可达保护面（GET 不需要 CSRF）
    const okA = await fx.app.request("/api/server-info", {
      headers: { cookie: sessionCookieHeader(a.sessionToken) },
    });
    assert.equal(okA.status, 200);
    const okB = await fx.app.request("/api/server-info", {
      headers: { cookie: sessionCookieHeader(b.sessionToken) },
    });
    assert.equal(okB.status, 200);

    // 撤销 A
    const revoke = await fx.app.request("/api/admin/devices/revoke", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ id: a.deviceId }),
    });
    assert.equal(revoke.status, 200);

    // 撤销即时生效：A 401、B 仍 200。会话持久化的取舍：撤销时该设备会话
    // 从内存+sessions.json 一并移除（不留记录），错误码为 authentication_failed
    // （device_revoked 只在"恢复的会话指向已消失设备"的崩溃残留下出现）。
    const afterA = await fx.app.request("/api/server-info", {
      headers: { cookie: sessionCookieHeader(a.sessionToken) },
    });
    assert.equal(afterA.status, 401);
    assert.equal(((await afterA.json()) as { error: string }).error, "authentication_failed");
    const afterB = await fx.app.request("/api/server-info", {
      headers: { cookie: sessionCookieHeader(b.sessionToken) },
    });
    assert.equal(afterB.status, 200);

    // A 的 WS 被主动关闭；B 的 WS 不受影响
    assert.equal(closedByA.length, 1);
    assert.equal(closedByA[0]!.code, 4401);
    assert.deepEqual(closedByB, []);

    // A 的长期凭据也不能再 renew/probe（无 tombstone，一律 401）
    const renewA = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: a.deviceToken }),
    });
    assert.equal(renewA.status, 401);
    const probeA = await fx.app.request("/api/auth/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: a.deviceToken }),
    });
    assert.equal(probeA.status, 401);
  } finally {
    await fx.cleanup();
  }
});

// ── devices.json 只存摘要 ──────────────────────────────────────────────

test("devices.json 不含明文 deviceToken（只有 tokenDigest），权限 600，原子写含 instanceId", async () => {
  const fx = await makeFixture();
  try {
    const a = await pairDevice(fx, "落盘检查");
    const registryPath = join(fx.dataDir, ".zcode", "devices.json");
    assert.ok(existsSync(registryPath));
    const info = await stat(registryPath);
    assert.equal(info.mode & 0o777, 0o600, "devices.json 必须是 600 权限");

    const raw = await readFile(registryPath, "utf8");
    assert.ok(!raw.includes(a.deviceToken), "磁盘上不得出现明文 deviceToken（不变量1）");
    assert.ok(!raw.includes(a.sessionToken), "磁盘上不得出现明文 sessionToken");
    const parsed = JSON.parse(raw) as {
      version: number;
      instanceId: string;
      devices: Array<{ id: string; tokenDigest: string }>;
    };
    assert.equal(parsed.version, 1);
    assert.match(parsed.instanceId, /^[0-9a-f]{64}$/, "instanceId 是 64 hex 且固化在文件顶层");
    assert.equal(parsed.devices.length, 1);
    assert.equal(parsed.devices[0]!.id, a.deviceId);
    // tokenDigest = sha256(deviceToken)（比较也在摘要层）
    const { createHash } = await import("node:crypto");
    assert.equal(
      parsed.devices[0]!.tokenDigest,
      createHash("sha256").update(a.deviceToken).digest("hex"),
    );
    assert.match(raw, /\n$/, "文件以换行结尾");

    // 撤销后记录被删除（不保留 tombstone）
    await fx.app.request("/api/admin/devices/revoke", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ id: a.deviceId }),
    });
    const after = JSON.parse(await readFile(registryPath, "utf8")) as { devices: unknown[] };
    assert.equal(after.devices.length, 0);
  } finally {
    await fx.cleanup();
  }
});

// ── 管理端点双闸 ───────────────────────────────────────────────────────

test("管理端点双闸：本机+密钥 → 200；缺密钥/错密钥/非本机/secret 文件缺失 → 403", async () => {
  const fx = await makeFixture();
  try {
    const ok = await fx.app.request("/api/admin/devices", { headers: adminHeaders(ADMIN_SECRET) });
    assert.equal(ok.status, 200);
    const listed = (await ok.json()) as { devices: unknown[] };
    assert.deepEqual(listed.devices, []);

    const noSecret = await fx.app.request("/api/admin/devices", {
      headers: adminHeaders(undefined),
    });
    assert.equal(noSecret.status, 403);

    const wrongSecret = await fx.app.request("/api/admin/devices", {
      headers: adminHeaders("wrong-secret"),
    });
    assert.equal(wrongSecret.status, 403);

    const remoteSource = await fx.app.request("/api/admin/devices", {
      headers: adminHeaders(ADMIN_SECRET, "203.0.113.7"), // 经 nginx/公网来源
    });
    assert.equal(remoteSource.status, 403);

    // secret 文件被移除：读失败 fail closed → 403
    await rm(fx.adminSecretPath);
    const afterSecretGone = await fx.app.request("/api/admin/devices", {
      headers: adminHeaders(ADMIN_SECRET),
    });
    assert.equal(afterSecretGone.status, 403);
    await writeFile(fx.adminSecretPath, `${ADMIN_SECRET}\n`, { mode: 0o600 }); // 还原给 cleanup

    // 设备会话不能提升为管理权限（不变量6）：带会话 Cookie 调管理端点仍 403
    const device = await pairDevice(fx, "提权测试");
    const escalate = await fx.app.request("/api/admin/devices", {
      headers: { ...adminHeaders(undefined), cookie: sessionCookieHeader(device.sessionToken) },
    });
    assert.equal(escalate.status, 403);
  } finally {
    await fx.cleanup();
  }
});

test("/api/admin/* 不受会话中间件影响（无会话也不会被 401 挡住，由双闸裁决）", async () => {
  const fx = await makeFixture();
  try {
    const res = await fx.app.request("/api/admin/devices");
    assert.equal(res.status, 403); // 是双闸的 forbidden，不是会话的 401
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "forbidden");
  } finally {
    await fx.cleanup();
  }
});

// ── 会话与长期凭据结构性分离 ───────────────────────────────────────────

test("会话 Cookie 值 ≠ deviceToken；renew 多会话共存（不互踢）；撤销后全部失效", async () => {
  const fx = await makeFixture();
  try {
    const device = await pairDevice(fx, "分离检查");
    assert.notEqual(
      device.sessionToken,
      device.deviceToken,
      "sessionToken 绝不能等于 deviceToken（不变量3）",
    );
    assert.match(device.deviceToken, /^[A-Za-z0-9_-]{43}$/, "deviceToken 是 43 字符 base64url");
    assert.match(device.sessionToken, /^[A-Za-z0-9_-]{43}$/, "sessionToken 是 43 字符 base64url");
    assert.match(device.csrfToken, /^[A-Za-z0-9_-]{43}$/, "csrfToken 是 43 字符 base64url");
    assert.match(device.deviceId, /^[0-9a-f]{32}$/, "deviceId 是 32 hex");

    // redeem 下发 Cookie 四件套，会话 Cookie 值是短期 session 而非长期凭据
    const redeemRes = await fx.app.request("/api/pairing/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "nope" }),
    });
    assert.equal(redeemRes.status, 403); // 前置：无效码不能种 Cookie

    // renew 多会话共存（实测修正）：新会话生效、旧会话保留至自然过期
    // （同设备多标签/壳不互踢；撤销时统一失效）
    const renewRes = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    assert.equal(renewRes.status, 200);
    const renewed = (await renewRes.json()) as {
      instanceId: string;
      deviceId: string;
      sessionToken: string;
      csrfToken: string;
      sessionExpiresAt: number;
    };
    assert.deepEqual(
      Object.keys(renewed).sort(),
      ["csrfToken", "deviceId", "instanceId", "sessionExpiresAt", "sessionToken"],
      "renew 响应键集",
    );
    assert.notEqual(renewed.sessionToken, device.sessionToken, "renew 发的是新 sessionToken");
    assert.equal(renewed.deviceId, device.deviceId);
    assert.equal(renewed.instanceId, device.instanceId);

    const oldSession = await fx.app.request("/api/server-info", {
      headers: { cookie: sessionCookieHeader(device.sessionToken) },
    });
    assert.equal(oldSession.status, 200, "renew 后旧会话（另一标签页）仍有效——不互踢");
    const newSession = await fx.app.request("/api/server-info", {
      headers: { cookie: sessionCookieHeader(renewed.sessionToken) },
    });
    assert.equal(newSession.status, 200);

    // 撤销设备 → 该 sessionToken 全部失效
    await fx.app.request("/api/admin/devices/revoke", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ id: device.deviceId }),
    });
    const revokedSession = await fx.app.request("/api/server-info", {
      headers: { cookie: sessionCookieHeader(renewed.sessionToken) },
    });
    assert.equal(revokedSession.status, 401);
  } finally {
    await fx.cleanup();
  }
});

test("redeem 下发 Cookie 四件套（含 __Host- 变体；csrf 非 HttpOnly，session HttpOnly）", async () => {
  const fx = await makeFixture();
  try {
    const createRes = await fx.app.request("/api/admin/pairing-code", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ label: "cookie 检查" }),
    });
    const { code } = (await createRes.json()) as { code: string };
    const res = await fx.app.request("/api/pairing/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(res.status, 200);
    const cookies = res.headers.getSetCookie();
    const names = cookies.map((line) => line.split("=")[0]!);
    for (const expected of [
      SESSION_COOKIE_NAME,
      SESSION_COOKIE_HOST_NAME,
      CSRF_COOKIE_NAME,
      CSRF_COOKIE_HOST_NAME,
    ]) {
      assert.ok(names.includes(expected), `缺少 Cookie ${expected}：${JSON.stringify(names)}`);
    }
    const sessionLine = cookies.find((line) => line.startsWith(`${SESSION_COOKIE_HOST_NAME}=`))!;
    assert.ok(sessionLine.includes("HttpOnly"), "会话 Cookie 必须 HttpOnly");
    assert.ok(sessionLine.includes("Secure"), "会话 Cookie 必须 Secure");
    assert.ok(sessionLine.includes("SameSite=Strict"), "会话 Cookie 必须 SameSite=Strict");
    const csrfLine = cookies.find((line) => line.startsWith(`${CSRF_COOKIE_HOST_NAME}=`))!;
    assert.ok(!csrfLine.includes("HttpOnly"), "CSRF Cookie 必须非 HttpOnly（页面 JS 要读）");
    const sessionValue = sessionLine.split(";")[0]!.split("=")[1]!;
    const body = (await res.json()) as {
      sessionToken: string;
      deviceToken: string;
      sessionCookieName?: string;
      csrfCookieName?: string;
    };
    assert.equal(sessionValue, body.sessionToken, "Cookie 值是短期 session，不是长期凭据（不变量3）");
    assert.notEqual(sessionValue, body.deviceToken);
    // 响应体显式告知 Cookie 名（手机壳原生 redeem 后照名字注入 WebView）
    assert.equal(body.sessionCookieName, SESSION_COOKIE_NAME, "body 应带 sessionCookieName");
    assert.equal(body.csrfCookieName, CSRF_COOKIE_NAME, "body 应带 csrfCookieName");
  } finally {
    await fx.cleanup();
  }
});

test("bots webhook 回调通道豁免会话中间件（外部平台无设备会话，业务鉴权走 x-zcode-bot-secret）", async () => {
  const fx = await makeFixture();
  try {
    // 无会话、无 CSRF 头也应到达业务路由（豁免验证；401/403 都算误伤）
    const single = await fx.app.request("/api/bots/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.88" },
      body: JSON.stringify({ payload: "callback" }),
    });
    assert.equal(single.status, 200);
    assert.equal(((await single.json()) as { reached: boolean }).reached, true);

    const withBotId = await fx.app.request("/api/bots/webhook/bot-42", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "callback" }),
    });
    assert.equal(withBotId.status, 200);
    const body = (await withBotId.json()) as { provider: string; botId: string };
    assert.equal(body.provider, "webhook");
    assert.equal(body.botId, "bot-42");
  } finally {
    await fx.cleanup();
  }
});

test("CSRF 强制：保护面 POST 缺头/错头 403、正确头 200、GET 不受影响", async () => {
  const fx = await makeFixture();
  try {
    const device = await pairDevice(fx, "csrf 强制");
    const cookie = sessionCookieHeader(device.sessionToken);

    // 缺头 → 403 forbidden（无副作用语义：handler 不可达）
    const noCsrf = await fx.app.request("/api/rpc-host-capability", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(noCsrf.status, 403, "缺 x-zcode-csrf 头的 POST 必须 403");
    assert.equal(((await noCsrf.json()) as { error: string }).error, "forbidden");

    // 错头 → 403
    const wrongCsrf = await fx.app.request("/api/rpc-host-capability", {
      method: "POST",
      headers: { cookie, "x-zcode-csrf": "wrong-csrf-value" },
    });
    assert.equal(wrongCsrf.status, 403, "错 token 的 POST 必须 403");

    // 正确头（与 redeem 下发的 csrfToken 一致）→ 200
    const goodCsrf = await fx.app.request("/api/rpc-host-capability", {
      method: "POST",
      headers: { cookie, "x-zcode-csrf": device.csrfToken },
    });
    assert.equal(goodCsrf.status, 200);

    // GET/HEAD 不校验（下载/预览/轮询的导航型请求不带自定义头）
    const goodGet = await fx.app.request("/api/server-info", { headers: { cookie } });
    assert.equal(goodGet.status, 200, "GET 不要求 CSRF 头");
    const headNoCsrf = await fx.app.request("/api/server-info", {
      method: "HEAD",
      headers: { cookie },
    });
    assert.equal(headNoCsrf.status, 200, "HEAD 不要求 CSRF 头");
  } finally {
    await fx.cleanup();
  }
});

test("CSRF 豁免面：公开自救通道（renew/probe）与 bots webhook 无头 POST 放行", async () => {
  const fx = await makeFixture();
  try {
    const device = await pairDevice(fx, "csrf 豁免面");

    // 公开自救通道：凭据在 body，调用方（APK 原生/relay 本地会话）无 Cookie 无会话，
    // 双提交无从谈起——不校验 CSRF（这正是豁免的理由）。
    const renewRes = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    assert.equal(renewRes.status, 200, "renew（公开面）无 CSRF 头放行");
    const probeRes = await fx.app.request("/api/auth/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    assert.equal(probeRes.status, 200, "probe（公开面）无 CSRF 头放行");

    // bots webhook：业务鉴权 x-zcode-bot-secret，调用方永不持有设备会话
    const botRes = await fx.app.request("/api/bots/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "callback" }),
    });
    assert.equal(botRes.status, 200, "bots webhook（公开面）无 CSRF 头放行");
  } finally {
    await fx.cleanup();
  }
});

test("CSRF 回退开关：csrfEnforce=false 恢复『只下发不强制』旧语义（ZCODE_CSRF_ENFORCE=0 的等价注入）", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zcode-device-auth-csrf-off-"));
  const adminSecretPath = join(dataDir, "zcode-admin.secret");
  await writeFile(adminSecretPath, `${ADMIN_SECRET}\n`, { mode: 0o600 });
  const fx: Fixture = {
    dataDir,
    adminSecretPath,
    auth: null as unknown as Fixture["auth"],
    app: null as unknown as Hono,
    clock: {
      value: 1_700_000_000_000,
      advance(ms: number) {
        this.value += ms;
      },
    },
    cleanup: async () => {},
    restart: async () => fx,
  };
  try {
    const auth = await createDeviceCredentialAuth({
      dataBaseDir: dataDir,
      adminSecretPath,
      now: () => fx.clock.value,
      csrfEnforce: false, // 回退开关：与 env ZCODE_CSRF_ENFORCE=0 同语义
    });
    const app = new Hono();
    app.route("/", auth.routes);
    app.use("*", auth.middleware);
    app.route("/", auth.meRoutes);
    app.post("/api/rpc-host-capability", (c) => c.json({ ok: true }));
    fx.auth = auth;
    fx.app = app;

    const device = await pairDevice(fx, "csrf 回退");
    const noCsrf = await fx.app.request("/api/rpc-host-capability", {
      method: "POST",
      headers: { cookie: sessionCookieHeader(device.sessionToken) },
    });
    assert.equal(noCsrf.status, 200, "回退开关生效：无头 POST 恢复放行（旧语义）");
  } finally {
    await fx.auth?.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

/* ---------- WS 升级 Origin 白名单 ---------- */

/** 最小 req 存根：isWsOriginAllowed 只需要 header()。 */
function reqStub(headers: Record<string, string>): { header: (name: string) => string | undefined } {
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    lower[name.toLowerCase()] = value;
  }
  return { header: (name: string) => lower[name.toLowerCase()] };
}

test("WS Origin 判定（纯函数）：同源通过/跨域拒绝/缺失放行/反代头/回环例外/env 追加", async () => {
  // —— 同源：Origin 的 host:port == 请求 Host ——
  // 无端口号（http 默认 80 归一）
  assert.equal(
    isWsOriginAllowed(reqStub({ host: "example.test" }), "http://example.test"),
    true,
    "同源（默认端口归一）放行",
  );
  // 显式端口
  assert.equal(
    isWsOriginAllowed(reqStub({ host: "example.test:8443" }), "https://example.test:8443"),
    true,
    "同源（显式端口）放行",
  );
  // https 请求 + 443 归一（X-Forwarded-Proto 参与 scheme 推导）
  assert.equal(
    isWsOriginAllowed(
      reqStub({ host: "example.test", "x-forwarded-proto": "https" }),
      "https://example.test",
    ),
    true,
    "同源（反代 https，443 归一）放行",
  );

  // —— 跨域 → 拒（CSWSH 攻击形态）——
  assert.equal(
    isWsOriginAllowed(reqStub({ host: "example.test" }), "http://evil.test"),
    false,
    "跨站 origin 拒绝",
  );
  assert.equal(
    isWsOriginAllowed(reqStub({ host: "example.test" }), "https://example.test.evil.test"),
    false,
    "后缀钓鱼域拒绝",
  );
  // scheme 降级：Origin http vs 请求 https（默认端口归一后 authority 相同——scheme 差异
  // 本身经端口体现不了默认值相等的情形；浏览器 Origin scheme 恒等于页面 scheme，
  // 该形态只会出现在构造请求里，按"端口归一后同 authority"判同源是可接受的宽松面：
  // Cookie 有 SameSite=Strict + 会话校验兜底。但 https→http 反向（Origin 声明 http，
  // 请求经反代为 https）在 443/80 归一下仍判同源，注释与 spec 已说明。
  assert.equal(
    isWsOriginAllowed(
      reqStub({ host: "example.test", "x-forwarded-proto": "https" }),
      "http://example.test",
    ),
    true,
    "scheme 降级但 authority 同源（默认端口归一）放行——宽松面已登记",
  );
  // 同 host 不同端口 → 拒
  assert.equal(
    isWsOriginAllowed(reqStub({ host: "example.test" }), "http://example.test:9999"),
    false,
    "同 host 异端口拒绝",
  );

  // —— 缺失 Origin = 非浏览器客户端 → 放行（既有裁决，理由见实现注释）——
  assert.equal(isWsOriginAllowed(reqStub({ host: "example.test" }), undefined), true, "缺失 Origin 放行");
  assert.equal(isWsOriginAllowed(reqStub({ host: "example.test" }), ""), true, "空 Origin 视同缺失");

  // —— X-Forwarded-Host 场景 ——
  // 默认（ZCODE_TRUST_PROXY 未设）：反代头**不被信任**——伪造头无效，判定退回 Host 头。
  // nginx 未显式覆盖转发头时客户端可伪造 X-Forwarded-Host（PoC 实证），默认关闭是纵深。
  process.env["ZCODE_TRUST_PROXY"] = "";
  try {
    assert.equal(
      isWsOriginAllowed(
        reqStub({ host: "example.test", "x-forwarded-host": "evil.test" }),
        "https://evil.test",
      ),
      false,
      "默认不信反代头：伪造 X-Forwarded-Host 的同源伪造被拒绝",
    );
    assert.equal(
      isWsOriginAllowed(
        reqStub({ host: "example.test", "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" }),
        "https://example.test",
      ),
      true,
      "默认不信反代头：Host 头同源放行（伪造头被无视）",
    );
  } finally {
    delete process.env["ZCODE_TRUST_PROXY"];
  }
  // 显式开启（ZCODE_TRUST_PROXY=1）：部署方声明反代已 proxy_set_header 覆盖转发头
  process.env["ZCODE_TRUST_PROXY"] = "1";
  try {
    assert.equal(
      isWsOriginAllowed(
        reqStub({ host: "internal.backend", "x-forwarded-host": "example.test", "x-forwarded-proto": "https" }),
        "https://example.test",
      ),
      true,
      "TRUST_PROXY=1：X-Forwarded-Host 优先，同源放行",
    );
    assert.equal(
      isWsOriginAllowed(
        reqStub({ host: "internal.backend", "x-forwarded-host": "example.test", "x-forwarded-proto": "https" }),
        "https://other.test",
      ),
      false,
      "TRUST_PROXY=1：X-Forwarded-Host 存在时不认 Host 头的 host",
    );
    assert.equal(
      isWsOriginAllowed(
        reqStub({ host: "internal.backend", "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" }),
        "https://evil.test",
      ),
      true,
      "TRUST_PROXY=1：伪造头变有效——开启即声明反代已覆盖转发头（部署责任面）",
    );
    // X-Forwarded-Host 链式（多值取第一个）
    assert.equal(
      isWsOriginAllowed(
        reqStub({ host: "internal.backend", "x-forwarded-host": "example.test, proxy2", "x-forwarded-proto": "https" }),
        "https://example.test",
      ),
      true,
      "TRUST_PROXY=1：X-Forwarded-Host 多值取第一",
    );
  } finally {
    delete process.env["ZCODE_TRUST_PROXY"];
  }

  // —— 回环调试例外：Origin 是回环名且端口属调试端口集（5173/3030）——
  assert.equal(
    isWsOriginAllowed(reqStub({ host: "example.test" }), "http://localhost:5173"),
    true,
    "vite dev 回环例外",
  );
  assert.equal(
    isWsOriginAllowed(reqStub({ host: "127.0.0.1:3030" }), "http://127.0.0.1:3030"),
    true,
    "本机直连同源（也属同源判定命中）",
  );
  assert.equal(
    isWsOriginAllowed(reqStub({ host: "example.test" }), "http://localhost:9999"),
    false,
    "回环名但非调试端口 → 拒（不给任意回环端口开门）",
  );

  // —— Referer 次级证据：Origin 缺席时取 Referer 的 origin 参与同一判定 ——
  assert.equal(
    isWsOriginAllowed(
      reqStub({ host: "example.test", "x-forwarded-proto": "https" }),
      undefined,
      "https://example.test/remote/abc",
    ),
    true,
    "Referer 同源放行",
  );
  assert.equal(
    isWsOriginAllowed(reqStub({ host: "example.test" }), undefined, "https://evil.test/page"),
    false,
    "Referer 跨域拒绝",
  );
  assert.equal(isWsOriginAllowed(reqStub({ host: "example.test" }), undefined, "garbage"), false, "Referer 非法拒绝");

  // —— 非法 Origin：fail closed ——
  assert.equal(isWsOriginAllowed(reqStub({ host: "example.test" }), "not-a-url"), false, "非法 Origin 拒绝");

  // —— env 追加白名单（跨域部署用）：逗号分隔、去尾斜杠 ——
  process.env["ZCODE_WS_ALLOWED_ORIGINS"] = "https://alt.example.test/, https://second.example.test";
  try {
    const mod = await import(`../src/deviceCredentialAuth.js?env-check=${Date.now()}`);
    assert.equal(
      mod.isWsOriginAllowed(reqStub({ host: "example.test" }), "https://alt.example.test"),
      true,
      "env 追加入白名单",
    );
    assert.equal(
      mod.isWsOriginAllowed(reqStub({ host: "example.test" }), "https://second.example.test"),
      true,
      "env 追加（去尾斜杠）",
    );
    assert.equal(
      mod.isWsOriginAllowed(reqStub({ host: "example.test" }), "https://third.example.test"),
      false,
      "未列入仍拒绝",
    );
  } finally {
    delete process.env["ZCODE_WS_ALLOWED_ORIGINS"];
  }
});

test("会话寿命封顶于设备寿命：临期 renew 的 sessionExpiresAt ≤ 顺延后的 deviceExpiresAt", async () => {
  const fx = await makeFixture();
  try {
    const device = await pairDevice(fx, "寿命封顶");
    // 走到设备寿命最后 1 小时；renew 本身会滑动顺延 expiresAt（+90 天，365 天上限内），
    // 新会话寿命 = min(now+12h, 顺延后的 deviceExpiresAt) —— 封顶关系不变。
    fx.clock.advance(90 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000);
    const renewRes = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    assert.equal(renewRes.status, 200);
    const renewed = (await renewRes.json()) as { sessionExpiresAt: number };
    const registry = JSON.parse(
      await readFile(join(fx.dataDir, ".zcode", "devices.json"), "utf8"),
    ) as { devices: Array<{ expiresAt: number }> };
    assert.ok(
      renewed.sessionExpiresAt <= registry.devices[0]!.expiresAt,
      `sessionExpiresAt(${renewed.sessionExpiresAt}) 必须封顶于顺延后的 deviceExpiresAt(${registry.devices[0]!.expiresAt})`,
    );
    // 会话仍是 12 小时（顺延后远未到设备寿命，封顶不触发）
    assert.equal(renewed.sessionExpiresAt, registry.devices[0]!.lastSeenAt + 12 * 60 * 60 * 1000);
  } finally {
    await fx.cleanup();
  }
});

test("renew/probe 更新 lastSeenAt；renew 滑动窗口顺延、probe 不延长；逐请求重查注册表", async () => {
  const fx = await makeFixture();
  try {
    const device = await pairDevice(fx, "lastSeen 检查");
    fx.clock.advance(60 * 60 * 1000);
    await fx.app.request("/api/auth/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    // probe 响应键集（无 reachable 字段，200 即可达）
    const probeRes = await fx.app.request("/api/auth/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    assert.equal(probeRes.status, 200);
    const probeBody = (await probeRes.json()) as {
      instanceId: string;
      deviceId: string;
      deviceExpiresAt: number;
    };
    assert.deepEqual(Object.keys(probeBody).sort(), ["deviceExpiresAt", "deviceId", "instanceId"]);
    assert.equal(probeBody.deviceId, device.deviceId);
    // probe 不开会话也不顺延（滑动窗口只由 renew 触发）
    assert.equal(probeBody.deviceExpiresAt, device.deviceExpiresAt, "probe 不延长设备寿命");

    // renew 滑动窗口：expiresAt 顺延一个 DEVICE_TTL（自创建起 365 天绝对上限内）
    const renewRes = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    assert.equal(renewRes.status, 200);
    const renewBody = (await renewRes.json()) as { sessionExpiresAt: number };
    const registry = JSON.parse(
      await readFile(join(fx.dataDir, ".zcode", "devices.json"), "utf8"),
    ) as { devices: Array<{ lastSeenAt: number; expiresAt: number }> };
    const tBefore = device.deviceExpiresAt - 90 * 24 * 60 * 60 * 1000; // createdAt 近似
    assert.ok(
      registry.devices[0]!.expiresAt > tBefore + 90 * 24 * 60 * 60 * 1000,
      "renew 后 expiresAt 已顺延（滑动窗口）",
    );
    assert.ok(
      registry.devices[0]!.expiresAt <=
        tBefore + 365 * 24 * 60 * 60 * 1000 + 90 * 24 * 60 * 60 * 1000,
      "不超过绝对上限",
    );
    assert.ok(registry.devices[0]!.lastSeenAt > tBefore, "lastSeenAt 已推进并落盘");
    assert.ok(renewBody.sessionExpiresAt <= registry.devices[0]!.expiresAt, "会话寿命封顶保持");
  } finally {
    await fx.cleanup();
  }
});

test("方案A：redeem 下发续期 Cookie；浏览器凭它 renew（无 body 凭据）；撤销后 renew 清 Cookie", async () => {
  const fx = await makeFixture();
  try {
    const createRes = await fx.app.request("/api/admin/pairing-code", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ label: "续期 Cookie 检查" }),
    });
    const { code } = (await createRes.json()) as { code: string };
    const redeemRes = await fx.app.request("/api/pairing/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const cookies = redeemRes.headers.getSetCookie();
    const renewLine = cookies.find((line) => line.startsWith(`${RENEW_COOKIE_NAME}=`))!;
    assert.ok(renewLine, "redeem 应下发续期 Cookie zcode_device_renew");
    assert.ok(renewLine.includes("HttpOnly"), "续期 Cookie 必须 HttpOnly");
    assert.ok(renewLine.includes("Secure"), "续期 Cookie 必须 Secure");
    assert.ok(renewLine.includes("SameSite=Strict"), "续期 Cookie 必须 SameSite=Strict");
    const renewValue = renewLine.split(";")[0]!.split("=")[1]!;
    const body = (await redeemRes.json()) as { deviceToken: string };
    assert.equal(renewValue, body.deviceToken, "续期 Cookie 值 = deviceToken（只能调 renew）");

    // 浏览器静默 renew：不带 body 凭据，只带续期 Cookie
    fx.clock.advance(11 * 60 * 60 * 1000); // 会话临近到期
    const renewRes = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${RENEW_COOKIE_NAME}=${renewValue}` },
    });
    assert.equal(renewRes.status, 200, "凭续期 Cookie 静默换新会话");
    const renewBody = (await renewRes.json()) as { sessionToken: string };
    assert.ok(renewBody.sessionToken, "拿到新会话");
    // 复核修复：renew 顺延设备寿命后必须同步重发续期 Cookie（Max-Age = 顺延后剩余），
    // 否则第 89 天 renew 后浏览器手里的续期 Cookie 只剩 1 天 → 91 天被迫重配，设备却还活着。
    const renewedRenewCookie = renewRes.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${RENEW_COOKIE_NAME}=`))!;
    assert.ok(renewedRenewCookie, "renew 成功应重发续期 Cookie（同步滑动窗口）");
    const renewedMaxAge = Number(/max-age=(\d+)/i.exec(renewedRenewCookie)?.[1]);
    const expectedMaxAge = 90 * 24 * 60 * 60; // 滑动顺延从当前时刻起 +90 天，剩余恰为 90 天整
    assert.ok(
      Math.abs(renewedMaxAge - expectedMaxAge) < 60,
      `Max-Age 应为顺延后剩余秒数（≈${expectedMaxAge}），实际 ${renewedMaxAge}`,
    );

    // 撤销设备 → 同一续期 Cookie renew 401 且响应清掉该 Cookie
    const registry = JSON.parse(
      await readFile(join(fx.dataDir, ".zcode", "devices.json"), "utf8"),
    ) as { devices: Array<{ id: string }> };
    const revokeRes = await fx.app.request("/api/admin/devices/revoke", {
      method: "POST",
      headers: { ...adminHeaders(ADMIN_SECRET), "content-type": "application/json" },
      body: JSON.stringify({ id: registry.devices[0]!.id }),
    });
    assert.equal(revokeRes.status, 200);
    const afterRes = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${RENEW_COOKIE_NAME}=${renewValue}` },
    });
    assert.equal(afterRes.status, 401, "撤销后续期 Cookie 立即失效");
    const cleared = afterRes.headers.getSetCookie().find((line) =>
      line.startsWith(`${RENEW_COOKIE_NAME}=`),
    )!;
    assert.ok(cleared && /max-age=0/i.test(cleared), "401 响应顺带清掉续期 Cookie");
  } finally {
    await fx.cleanup();
  }
});

test("body 超 16KiB → 413", async () => {
  const fx = await makeFixture();
  try {
    const big = "x".repeat(17 * 1024);
    const res = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: big }),
    });
    assert.equal(res.status, 413);
  } finally {
    await fx.cleanup();
  }
});

test("限流三件套独立（放宽后 100/10min）：redeem 超限 429；renew 不被波及", async () => {
  const fx = await makeFixture();
  try {
    const headers = { "content-type": "application/json", "x-real-ip": "198.51.100.9" };
    let lastStatus = 0;
    for (let i = 0; i < 100; i++) {
      const res = await fx.app.request("/api/pairing/redeem", {
        method: "POST",
        headers,
        body: JSON.stringify({ code: "bad-code" }),
      });
      assert.equal(res.status, 403);
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 403);
    const exceeded = await fx.app.request("/api/pairing/redeem", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: "bad-code" }),
    });
    assert.equal(exceeded.status, 429);
    assert.equal(((await exceeded.json()) as { error: string }).error, "rate_limited");
    // 独立计数：renew 未被 redeem 的限流波及
    const renewRes = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers,
      body: JSON.stringify({ deviceToken: "unknown" }),
    });
    assert.equal(renewRes.status, 401);
  } finally {
    await fx.cleanup();
  }
});

test("管理端点：devices 列表不含 tokenDigest；撤销未知 id → 404；管理路由在保护中间件之前可达", async () => {
  const fx = await makeFixture();
  try {
    await pairDevice(fx, "列表检查");
    const res = await fx.app.request("/api/admin/devices", { headers: adminHeaders(ADMIN_SECRET) });
    assert.equal(res.status, 200);
    const { devices } = (await res.json()) as { devices: Array<Record<string, unknown>> };
    assert.equal(devices.length, 1);
    assert.deepEqual(
      Object.keys(devices[0]!).sort(),
      ["createdAt", "expiresAt", "id", "label", "lastSeenAt", "temporary"],
      "设备列表绝不能含 tokenDigest/凭据（不变量1）；带 temporary 标记",
    );
    const missing = await fx.app.request("/api/admin/devices/revoke", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ id: "nonexistent" }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await fx.cleanup();
  }
});

test("保护面未持会话 → 401 并下发过期 Cookie 清理；会话指向已过期设备 → device_expired", async () => {
  const fx = await makeFixture();
  try {
    const anonymous = await fx.app.request("/api/server-info");
    assert.equal(anonymous.status, 401);
    assert.ok(
      anonymous.headers.getSetCookie().some((line) => line.startsWith(`${SESSION_COOKIE_NAME}=;`)),
      "401 时应清理会话 Cookie",
    );

    const device = await pairDevice(fx, "过期设备会话");
    fx.clock.advance(90 * 24 * 60 * 60 * 1000 + 1);
    const expired = await fx.app.request("/api/server-info", {
      headers: { cookie: sessionCookieHeader(device.sessionToken) },
    });
    assert.equal(expired.status, 401);
    assert.equal(((await expired.json()) as { error: string }).error, "device_expired");
  } finally {
    await fx.cleanup();
  }
});

// ══ 会话持久化 / 服务端静默自愈 / 临时设备 / /api/me 通道 ══════════

/** 从 Set-Cookie 行数组里取某 Cookie 的值。 */
function cookieValue(lines: string[], name: string): string | null {
  const line = lines.find((l) => l.startsWith(`${name}=`));
  return line ? (line.split(";")[0]!.split("=").slice(1).join("=") || null) : null;
}

test("T-restart 重启恢复：sessions.json 持久化，新实例下旧 sessionToken 仍 200；撤销同步清盘", async () => {
  const fx = await makeFixture();
  try {
    const device = await pairDevice(fx, "重启恢复");
    // renew 一次产生第二个会话（多会话都应恢复）
    const renewRes = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    assert.equal(renewRes.status, 200);
    const renewed = (await renewRes.json()) as { sessionToken: string };

    await fx.restart(); // 模拟服务重启（同 dataDir 重建实例）

    for (const [name, token] of [
      ["redeem 会话", device.sessionToken],
      ["renew 会话", renewed.sessionToken],
    ] as const) {
      const res = await fx.app.request("/api/server-info", {
        headers: { cookie: sessionCookieHeader(token) },
      });
      assert.equal(res.status, 200, `重启后${name}应恢复（sessions.json）`);
    }

    // 过滤已过期：会话自然过期后重启，不再恢复
    fx.clock.advance(12 * 60 * 60 * 1000 + 1); // > SESSION_TTL_MS
    await fx.restart();
    const expiredAfter = await fx.app.request("/api/server-info", {
      headers: { cookie: sessionCookieHeader(renewed.sessionToken) },
    });
    assert.equal(expiredAfter.status, 401, "过期会话重启后不得恢复");

    // 撤销同步清盘：重启前撤销 → sessions.json 里该设备条目为空
    const device2 = await pairDevice(fx, "撤销清盘");
    const revokeRes = await fx.app.request("/api/admin/devices/revoke", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ id: device2.deviceId }),
    });
    assert.equal(revokeRes.status, 200);
    await fx.auth.dispose(); // 等写链排空
    const sessionsRaw = await readFile(join(fx.dataDir, ".zcode", "sessions.json"), "utf8");
    const sessionsFile = JSON.parse(sessionsRaw) as {
      version: number;
      sessions: Array<{ deviceId: string }>;
    };
    assert.equal(sessionsFile.version, 1);
    assert.ok(
      !sessionsFile.sessions.some((s) => s.deviceId === device2.deviceId),
      "撤销后 sessions.json 不得残留该设备的会话",
    );
  } finally {
    await fx.cleanup();
  }
});

test("T-heal 静默自愈：会话不存在但带续期 Cookie → 200 + Set-Cookie 新会话；老会话仍共存", async () => {
  const fx = await makeFixture();
  try {
    const device = await pairDevice(fx, "自愈检查");
    // 自愈条件构造：让内存会话消失但不撤设备。重启即清空内存态（sessions.json 是新
    // 机制要验证的另一条路径，这里走"新实例未恢复该会话"= 删 sessions.json 模拟旧版重启）
    const sessionsPath = join(fx.dataDir, ".zcode", "sessions.json");
    await rm(sessionsPath, { force: true });
    await fx.restart();

    const healed = await fx.app.request("/api/server-info", {
      headers: { cookie: `${RENEW_COOKIE_NAME}=${device.deviceToken}` }, // 无会话 Cookie，只有续期 Cookie
    });
    assert.equal(healed.status, 200, "会话失效但带续期 Cookie 应静默自愈放行");
    const setCookies = healed.headers.getSetCookie();
    const newSession = cookieValue(setCookies, SESSION_COOKIE_NAME);
    assert.ok(newSession, "自愈响应必须 Set-Cookie 下发新会话");
    assert.notEqual(newSession, device.sessionToken, "换发的是新 sessionToken");
    assert.ok(
      setCookies.some((line) => line.startsWith(`${RENEW_COOKIE_NAME}=`) && !/max-age=0/i.test(line)),
      "自愈应重发续期 Cookie（滑动顺延，非临时设备）",
    );
    // 新会话立即可用（客户端下一个请求拿新 Cookie 即恢复）
    const withNew = await fx.app.request("/api/server-info", {
      headers: { cookie: sessionCookieHeader(newSession!) },
    });
    assert.equal(withNew.status, 200, "自愈换发的新会话立即可用");
    // 多会话共存语义：自愈不淘汰其它会话
    const renewRes = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    assert.equal(renewRes.status, 200);
    const renewed = (await renewRes.json()) as { sessionToken: string };
    const sibling = await fx.app.request("/api/server-info", {
      headers: { cookie: sessionCookieHeader(newSession!) },
    });
    assert.equal(sibling.status, 200, "renew 后自愈会话仍共存（不互踢）");
    void renewed;
  } finally {
    await fx.cleanup();
  }
});

test("自愈分支被 CSRF 覆盖：会话失效 + 续期 Cookie 的 POST（无 CSRF 头）→ 403 而非静默换发放行", async () => {
  const fx = await makeFixture();
  try {
    const device = await pairDevice(fx, "自愈csrf");
    // 自愈条件构造：内存会话消失，设备健在，请求带续期 Cookie
    const sessionsPath = join(fx.dataDir, ".zcode", "sessions.json");
    await rm(sessionsPath, { force: true });
    await fx.restart();

    // GET 语义的自愈不受影响（对照：证明自愈路径本身还在）
    const healedGet = await fx.app.request("/api/server-info", {
      headers: { cookie: `${RENEW_COOKIE_NAME}=${device.deviceToken}` },
    });
    assert.equal(healedGet.status, 200, "GET 自愈照常放行");

    // 重建自愈条件（上一步 GET 自愈已换发新会话）：再删一次 sessions.json 并重启
    await fx.auth.dispose();
    await rm(sessionsPath, { force: true });
    await fx.restart();

    // mutating 请求走到自愈分支前被 403 拦截——不再可能凭续期 Cookie
    // 静默换发新会话并执行有副作用的 handler
    const healedPost = await fx.app.request("/api/rpc-host-capability", {
      method: "POST",
      headers: { cookie: `${RENEW_COOKIE_NAME}=${device.deviceToken}` },
    });
    assert.equal(healedPost.status, 403, "自愈候选的 POST 缺 CSRF 头必须 403");
    assert.equal(((await healedPost.json()) as { error: string }).error, "forbidden");
  } finally {
    await fx.cleanup();
  }
});

test("T-heal-negative 无凭据照旧 401：无 Cookie / 无效续期 Cookie / 被撤销设备均不误放行", async () => {
  const fx = await makeFixture();
  try {
    // 无任何凭据：401 且不触发自愈（无 Set-Cookie 新会话，只有清理）
    const anonymous = await fx.app.request("/api/server-info");
    assert.equal(anonymous.status, 401);
    assert.equal(
      ((await anonymous.json()) as { error: string }).error,
      "authentication_failed",
    );

    // 无效续期 Cookie（未知设备）：401 且清掉续期 Cookie
    const bogus = await fx.app.request("/api/server-info", {
      headers: { cookie: `${RENEW_COOKIE_NAME}=not-a-real-device-token` },
    });
    assert.equal(bogus.status, 401);
    const cleared = bogus.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${RENEW_COOKIE_NAME}=`));
    assert.ok(cleared && /max-age=0/i.test(cleared), "无效续期 Cookie 应被清理");

    // 被撤销设备的续期 Cookie：自愈必须拒绝（撤销即时性延伸到自愈路径）
    const device = await pairDevice(fx, "撤销后自愈拒绝");
    await fx.app.request("/api/admin/devices/revoke", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ id: device.deviceId }),
    });
    const revokedHeal = await fx.app.request("/api/server-info", {
      headers: { cookie: `${RENEW_COOKIE_NAME}=${device.deviceToken}` },
    });
    assert.equal(revokedHeal.status, 401, "撤销设备的续期 Cookie 不能自愈");
  } finally {
    await fx.cleanup();
  }
});

test("T-disk-no-plaintext sessions.json 只存摘要：不含明文 token，key/csrfDigest 均 64 hex，权限 600", async () => {
  const fx = await makeFixture();
  try {
    const device = await pairDevice(fx, "落盘摘要检查");
    await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    await fx.auth.dispose(); // 等写链排空再读文件
    const sessionsPath = join(fx.dataDir, ".zcode", "sessions.json");
    assert.ok(existsSync(sessionsPath));
    const info = await stat(sessionsPath);
    assert.equal(info.mode & 0o777, 0o600, "sessions.json 必须 600（与 devices.json 同规范）");
    const raw = await readFile(sessionsPath, "utf8");
    assert.ok(!raw.includes(device.deviceToken), "磁盘不得出现明文 deviceToken（不变量1）");
    assert.ok(!raw.includes(device.sessionToken), "磁盘不得出现明文 sessionToken（不变量1）");
    assert.ok(!raw.includes(device.csrfToken), "磁盘不得出现明文 csrfToken（不变量1）");
    const parsed = JSON.parse(raw) as {
      version: number;
      sessions: Array<{ key: string; deviceId: string; csrfDigest: string; expiresAt: number }>;
    };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.sessions.length, 2, "redeem + renew 各一会话");
    for (const entry of parsed.sessions) {
      assert.match(entry.key, /^[0-9a-f]{64}$/, "key 必须是 sha256 hex 摘要");
      assert.match(entry.csrfDigest, /^[0-9a-f]{64}$/, "csrfDigest 必须是 sha256 hex 摘要");
      assert.match(entry.deviceId, /^[0-9a-f]{32}$/, "deviceId 是 32 hex");
    }
    const { createHash } = await import("node:crypto");
    assert.ok(
      parsed.sessions.some((s) => s.key === createHash("sha256").update(device.sessionToken).digest("hex")),
      "key = sha256(sessionToken)",
    );
  } finally {
    await fx.cleanup();
  }
});

test("WS 对齐：淘汰/过期会话的活跃 socket 被同步 close(4401)；撤销仍然关全部", async () => {
  const fx = await makeFixture();
  try {
    const device = await pairDevice(fx, "ws 对齐");
    const closed: Array<{ code?: number; reason?: string }> = [];
    const socket = {
      on() {},
      close(code?: number, reason?: string) {
        closed.push({ code, reason });
      },
    };
    fx.auth.wsGuard.registerSocket(device.sessionToken, socket);

    // 场景1 会话过期 → prune 关 WS（createSession 内部先 prune；用 renew 触发一次新会话创建）
    fx.clock.advance(12 * 60 * 60 * 1000 + 1);
    await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    assert.equal(closed.length, 1, "过期会话的 WS 应被 close");
    assert.equal(closed[0]!.code, WS_REVOKE_CLOSE_CODE);
    assert.equal(closed[0]!.reason, "session expired");

    // 场景2 撤销设备 → 新会话的 WS 也被关（killDeviceSessions）
    const closed2: Array<{ code?: number }> = [];
    const socket2 = {
      on() {},
      close(code?: number) {
        closed2.push({ code });
      },
    };
    fx.auth.wsGuard.registerSocket(
      (await fx.app.request("/api/auth/renew", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceToken: device.deviceToken }),
      })
        .then((r) => r.json())
        .then((b: { sessionToken: string }) => b.sessionToken)),
      socket2,
    );
    const list = (await (
      await fx.app.request("/api/admin/devices", { headers: adminHeaders(ADMIN_SECRET) })
    ).json()) as { devices: Array<{ id: string }> };
    await fx.app.request("/api/admin/devices/revoke", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ id: list.devices[0]!.id }),
    });
    assert.equal(closed2.length, 1, "撤销设备的 WS 应被 close");
    assert.equal(closed2[0]!.code, WS_REVOKE_CLOSE_CODE);
  } finally {
    await fx.cleanup();
  }
});

test("临时设备：ttlHours 配对码 → redeem 后 temporary=true；renew 不顺延；/api/me 403；到期 401", async () => {
  const fx = await makeFixture();
  try {
    // 非法 ttlHours 拒绝
    const bad = await fx.app.request("/api/admin/pairing-code", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ label: "非法", ttlHours: 0 }),
    });
    assert.equal(bad.status, 400);

    const createRes = await fx.app.request("/api/admin/pairing-code", {
      method: "POST",
      headers: adminHeaders(ADMIN_SECRET),
      body: JSON.stringify({ label: "临时访客", ttlHours: 1 }),
    });
    assert.equal(createRes.status, 200);
    const { code } = (await createRes.json()) as { code: string; temporary?: boolean };
    const redeemRes = await fx.app.request("/api/pairing/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.10" },
      body: JSON.stringify({ code }),
    });
    assert.equal(redeemRes.status, 200);
    const temp = (await redeemRes.json()) as {
      deviceId: string;
      deviceToken: string;
      deviceExpiresAt: number;
      sessionToken: string;
      csrfToken: string;
    };

    // 列表带 temporary 标记
    const list = (await (
      await fx.app.request("/api/admin/devices", { headers: adminHeaders(ADMIN_SECRET) })
    ).json()) as { devices: Array<{ id: string; temporary: boolean }> };
    const entry = list.devices.find((d) => d.id === temp.deviceId);
    assert.ok(entry, "临时设备在列表中");
    assert.equal(entry!.temporary, true, "临时设备标记 temporary=true");

    // renew 不顺延：deviceExpiresAt 不变（对比响应 / 列表）
    fx.clock.advance(30 * 60 * 1000);
    const renewRes = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: temp.deviceToken }),
    });
    assert.equal(renewRes.status, 200, "临时设备 renew 应成功（只换会话）");
    const renewed = (await renewRes.json()) as { sessionToken: string };
    const list2 = (await (
      await fx.app.request("/api/admin/devices", { headers: adminHeaders(ADMIN_SECRET) })
    ).json()) as { devices: Array<{ id: string; expiresAt: number }> };
    assert.equal(
      list2.devices.find((d) => d.id === temp.deviceId)!.expiresAt,
      temp.deviceExpiresAt,
      "临时设备 renew 不得顺延 expiresAt",
    );
    // renew 不重发续期 Cookie
    assert.ok(
      !renewRes.headers.getSetCookie().some((l) => l.startsWith(`${RENEW_COOKIE_NAME}=`)),
      "临时设备 renew 不重发续期 Cookie（寿命只减不增）",
    );

    // /api/me 一律 403（临时设备无管理权，fail-closed）
    const meDenied = await fx.app.request("/api/me/devices", {
      headers: { cookie: sessionCookieHeader(renewed.sessionToken) },
    });
    assert.equal(meDenied.status, 403);
    assert.equal(((await meDenied.json()) as { error: string }).error, "forbidden");

    // probe 正常（设备仍健在）
    const probeRes = await fx.app.request("/api/auth/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: temp.deviceToken }),
    });
    assert.equal(probeRes.status, 200);

    // 到点后：renew/probe/会话全部 401
    fx.clock.advance(31 * 60 * 1000); // 累计 > 1h
    const expiredRenew = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: temp.deviceToken }),
    });
    assert.equal(expiredRenew.status, 401, "临时设备到期后 renew 401");
    const expiredSession = await fx.app.request("/api/server-info", {
      headers: { cookie: sessionCookieHeader(renewed.sessionToken) },
    });
    assert.equal(expiredSession.status, 401, "临时设备到期后会话 401");
    assert.equal(
      ((await expiredSession.json()) as { error: string }).error,
      "device_expired",
    );
  } finally {
    await fx.cleanup();
  }
});

test("/api/me 矩阵：无会话 401；正式设备 GET ok；POST 强制 CSRF；revoke/rename/pairing-code 生效", async () => {
  const fx = await makeFixture();
  try {
    // 无会话 → 401（middleware 与 meRoutes 双层都拒绝）
    const anon = await fx.app.request("/api/me/devices");
    assert.equal(anon.status, 401);

    const me = await pairDevice(fx, "管理页设备");
    const other = await pairDevice(fx, "被管理设备");
    const cookie = sessionCookieHeader(me.sessionToken);

    // GET 无需 CSRF
    const list = await fx.app.request("/api/me/devices", { headers: { cookie } });
    assert.equal(list.status, 200);
    const listed = (await list.json()) as {
      devices: Array<{ id: string; label: string; temporary: boolean }>;
    };
    assert.ok(listed.devices.some((d) => d.id === me.deviceId && d.temporary === false));

    // POST 无 CSRF 头 → 403；错头 → 403
    const noCsrf = await fx.app.request("/api/me/devices/revoke", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: other.deviceId }),
    });
    assert.equal(noCsrf.status, 403);
    const wrongCsrf = await fx.app.request("/api/me/devices/rename", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-zcode-csrf": "wrong" },
      body: JSON.stringify({ id: me.deviceId, label: "x" }),
    });
    assert.equal(wrongCsrf.status, 403);

    // rename（带正确 CSRF）：生效并落盘
    const rename = await fx.app.request("/api/me/devices/rename", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-zcode-csrf": me.csrfToken,
      },
      body: JSON.stringify({ id: other.deviceId, label: "改名后的设备" }),
    });
    assert.equal(rename.status, 200);
    const list3 = (await (
      await fx.app.request("/api/me/devices", { headers: { cookie } })
    ).json()) as { devices: Array<{ id: string; label: string }> };
    assert.equal(list3.devices.find((d) => d.id === other.deviceId)!.label, "改名后的设备");

    // 发配对码（全局单窗口语义照旧）：redeem 可用
    const codeRes = await fx.app.request("/api/me/pairing-code", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-zcode-csrf": me.csrfToken },
      body: JSON.stringify({ label: "me 发的码" }),
    });
    assert.equal(codeRes.status, 200);
    const { code } = (await codeRes.json()) as { code: string };
    const redeemRes = await fx.app.request("/api/pairing/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.10" },
      body: JSON.stringify({ code }),
    });
    assert.equal(redeemRes.status, 200);

    // revoke 别的设备：立即 401；自己仍 200
    const revoke = await fx.app.request("/api/me/devices/revoke", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-zcode-csrf": me.csrfToken },
      body: JSON.stringify({ id: other.deviceId }),
    });
    assert.equal(revoke.status, 200);
    const otherAfter = await fx.app.request("/api/server-info", {
      headers: { cookie: sessionCookieHeader(other.sessionToken) },
    });
    assert.equal(otherAfter.status, 401, "被撤销设备立即 401");
    const meAfter = await fx.app.request("/api/me/devices", { headers: { cookie } });
    assert.equal(meAfter.status, 200, "撤销他人后自己仍 200");

    // 撤销自己：允许（前端会确认），自己的会话立即失效
    const selfRevoke = await fx.app.request("/api/me/devices/revoke", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-zcode-csrf": me.csrfToken },
      body: JSON.stringify({ id: me.deviceId }),
    });
    assert.equal(selfRevoke.status, 200);
    const meGone = await fx.app.request("/api/me/devices", { headers: { cookie } });
    assert.equal(meGone.status, 401, "撤销自己后会话立即失效");
  } finally {
    await fx.cleanup();
  }
});

test("自愈与显式 renew 限流隔离：自愈不消耗 renewLimiter 配额（600 次/10min 语义不被挤占）", async () => {
  const fx = await makeFixture();
  try {
    const device = await pairDevice(fx, "限流隔离");
    const sessionsPath = join(fx.dataDir, ".zcode", "sessions.json");
    await rm(sessionsPath, { force: true });
    await fx.restart();
    // 30 次自愈（远低于 600 上限，但若自愈误用 renewLimiter 也不会触发 429——
    // 此测试的意义在回归保护：若未来把 hit() 加进自愈路径，显式 renew 仍必须 200）
    for (let i = 0; i < 30; i++) {
      await rm(sessionsPath, { force: true });
      await fx.restart();
      const healed = await fx.app.request("/api/server-info", {
        headers: { cookie: `${RENEW_COOKIE_NAME}=${device.deviceToken}` },
      });
      assert.equal(healed.status, 200, `第 ${i + 1} 次自愈应成功`);
    }
    // 显式 renew 仍 200（未被打满）
    const renewRes = await fx.app.request("/api/auth/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken: device.deviceToken }),
    });
    assert.equal(renewRes.status, 200);
  } finally {
    await fx.cleanup();
  }
});

