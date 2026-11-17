// /api/me 扩展端点测试：pending-summary / files/download / preview/proxy。
// 运行：从 packages/server 目录 `../../node_modules/.bin/tsx --test test/meExtendedEndpoints.test.ts`
// 复用 deviceCredentialAuth.test.ts 的最小 app 组装（不导入 http.ts，避免拖起 services 栈）。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";

import {
  createDeviceCredentialAuth,
  makeRateLimiter,
  SESSION_COOKIE_NAME,
} from "../src/deviceCredentialAuth.js";

const ADMIN_SECRET = "test-admin-secret-0123456789abcdef";

interface FixtureOptions {
  pendingSummarySource?: () => Promise<{
    pendingInteractions: number;
    runningTasks: number;
    completedUnread: number;
    pendingDigest?: { kind: "permission" | "userInput"; text: string };
  }>;
  workspaceRootsProvider?: () => string[];
  previewProxyEnabled?: boolean;
  usageSummarySource?: () => Promise<{
    todayTokens: number;
    todayRequests: number;
    rpm: number;
    tpm: number;
    hourly24h: Array<{ hourISO: string; tokens: number }>;
    generatedAt: number;
  }>;
}

interface Fixture {
  dataDir: string;
  app: Hono;
  auth: Awaited<ReturnType<typeof createDeviceCredentialAuth>>;
  cleanup: () => Promise<void>;
}

async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "zcode-me-endpoints-"));
  const adminSecretPath = join(dataDir, "zcode-admin.secret");
  await writeFile(adminSecretPath, `${ADMIN_SECRET}\n`, { mode: 0o600 });
  const auth = await createDeviceCredentialAuth({
    dataBaseDir: dataDir,
    adminSecretPath,
    ...(options.pendingSummarySource ? { pendingSummarySource: options.pendingSummarySource } : {}),
    ...(options.workspaceRootsProvider
      ? { workspaceRootsProvider: options.workspaceRootsProvider }
      : {}),
    ...(options.previewProxyEnabled === false ? { previewProxyEnabled: false } : {}),
    ...(options.usageSummarySource ? { usageSummarySource: options.usageSummarySource } : {}),
  });
  const app = new Hono();
  app.route("/", auth.routes);
  app.use("*", auth.middleware);
  app.route("/", auth.meRoutes);
  const cleanup = async () => {
    await auth.dispose();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { dataDir, app, auth, cleanup };
}

function sessionCookieHeader(sessionToken: string): string {
  return `${SESSION_COOKIE_NAME}=${sessionToken}`;
}

/** 完整配对流程：创建配对码 → redeem → 返回会话凭据。 */
async function pairDevice(fx: Fixture): Promise<{
  cookie: string;
  sessionToken: string;
  csrfToken: string;
}> {
  const { cookie, sessionToken, csrfToken } = await pairDeviceWithToken(fx);
  return { cookie, sessionToken, csrfToken };
}

/** probe 用例需要长期凭据本体（不变量2：只在 redeem 响应体回显一次）。 */
async function pairDeviceWithToken(fx: Fixture): Promise<{
  cookie: string;
  sessionToken: string;
  csrfToken: string;
  deviceToken: string;
}> {
  const codeRes = await fx.app.request("/api/admin/pairing-code", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zcode-admin": ADMIN_SECRET,
      "x-real-ip": "127.0.0.1",
    },
    body: JSON.stringify({ label: "端点测试设备" }),
  });
  assert.equal(codeRes.status, 200);
  const { code } = (await codeRes.json()) as { code: string };
  const redeemRes = await fx.app.request("/api/pairing/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(redeemRes.status, 200);
  const body = (await redeemRes.json()) as {
    sessionToken: string;
    csrfToken: string;
    deviceToken: string;
  };
  return {
    cookie: sessionCookieHeader(body.sessionToken),
    sessionToken: body.sessionToken,
    csrfToken: body.csrfToken,
    deviceToken: body.deviceToken,
  };
}

/* ---------- pending-summary ---------- */

test("pending-summary: 无会话 401", async () => {
  const fx = await makeFixture({
    pendingSummarySource: async () => ({ pendingInteractions: 0, runningTasks: 0, completedUnread: 0 }),
  });
  try {
    const res = await fx.app.request("/api/me/pending-summary");
    assert.equal(res.status, 401);
  } finally {
    await fx.cleanup();
  }
});

test("pending-summary: 数据源未装配 503", async () => {
  const fx = await makeFixture({});
  try {
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request("/api/me/pending-summary", { headers: { cookie } });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "summary_unavailable");
  } finally {
    await fx.cleanup();
  }
});

test("pending-summary: 正式设备 200 形状与数值正确", async () => {
  const fx = await makeFixture({
    pendingSummarySource: async () => ({
      pendingInteractions: 2,
      runningTasks: 1,
      completedUnread: 3,
    }),
  });
  try {
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request("/api/me/pending-summary", { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, { pendingInteractions: 2, runningTasks: 1, completedUnread: 3 });
  } finally {
    await fx.cleanup();
  }
});

test("pending-summary: 数据源抛错 500（fail loud，不喂假零）", async () => {
  const fx = await makeFixture({
    pendingSummarySource: async () => {
      throw new Error("sqlite boom");
    },
  });
  try {
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request("/api/me/pending-summary", { headers: { cookie } });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "summary_failed");
  } finally {
    await fx.cleanup();
  }
});

test("pending-summary: GET 豁免 CSRF（无 x-zcode-csrf 头也 200）", async () => {
  const fx = await makeFixture({
    pendingSummarySource: async () => ({ pendingInteractions: 0, runningTasks: 0, completedUnread: 0 }),
  });
  try {
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request("/api/me/pending-summary", { headers: { cookie } });
    assert.equal(res.status, 200);
  } finally {
    await fx.cleanup();
  }
});

/* ---------- files/download ---------- */

async function makeDownloadFixture(): Promise<{
  fx: Fixture;
  root: string;
  outside: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "zcode-dl-root-"));
  const outside = await mkdtemp(join(tmpdir(), "zcode-dl-out-"));
  const fx = await makeFixture({ workspaceRootsProvider: () => [root] });
  return { fx, root, outside };
}

test("files/download: 无会话 401、缺参 400", async () => {
  const { fx, root, outside } = await makeDownloadFixture();
  try {
    const anon = await fx.app.request("/api/me/files/download?path=/etc/hostname");
    assert.equal(anon.status, 401);
    const { cookie } = await pairDevice(fx);
    const missing = await fx.app.request("/api/me/files/download", { headers: { cookie } });
    assert.equal(missing.status, 400);
    const relative = await fx.app.request(
      `/api/me/files/download?path=${encodeURIComponent(join(root, "x.txt"))}`,
      { headers: { cookie } },
    );
    // 相对路径判定：join 出来是绝对路径，这里验证 404 分支（文件不存在）。
    assert.ok([400, 404].includes(relative.status));
    void outside;
  } finally {
    await fx.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("files/download: 工作区内文件 200（Content-Disposition attachment）", async () => {
  const { fx, root, outside } = await makeDownloadFixture();
  try {
    const filePath = join(root, "报告-v1.txt");
    await writeFile(filePath, "你好，报告内容", { encoding: "utf8" });
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request(
      `/api/me/files/download?path=${encodeURIComponent(filePath)}`,
      { headers: { cookie } },
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.match(res.headers.get("content-disposition") ?? "", /filename\*=UTF-8''/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const text = await res.text();
    assert.equal(text, "你好，报告内容");
  } finally {
    await fx.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("files/download: 工作区外文件 403、不存在 404", async () => {
  const { fx, root, outside } = await makeDownloadFixture();
  try {
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "top-secret");
    const { cookie } = await pairDevice(fx);
    const outsideRes = await fx.app.request(
      `/api/me/files/download?path=${encodeURIComponent(outsideFile)}`,
      { headers: { cookie } },
    );
    assert.equal(outsideRes.status, 403);
    const missingRes = await fx.app.request(
      `/api/me/files/download?path=${encodeURIComponent(join(root, "nope.txt"))}`,
      { headers: { cookie } },
    );
    assert.equal(missingRes.status, 404);
  } finally {
    await fx.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("files/download: ../ 与编码穿越与 symlink 逃逸全部拒绝", async () => {
  const { fx, root, outside } = await makeDownloadFixture();
  try {
    const outsideFile = join(outside, "escape.txt");
    await writeFile(outsideFile, "escaped");
    // symlink 指向工作区外：realpath 解析后越界 → 403。
    await symlink(outsideFile, join(root, "link.txt"));
    const { cookie } = await pairDevice(fx);
    const traversal = await fx.app.request(
      `/api/me/files/download?path=${encodeURIComponent(join(root, "..", basename(outside), "escape.txt"))}`,
      { headers: { cookie } },
    );
    assert.equal(traversal.status, 403);
    const symlinkEscape = await fx.app.request(
      `/api/me/files/download?path=${encodeURIComponent(join(root, "link.txt"))}`,
      { headers: { cookie } },
    );
    assert.equal(symlinkEscape.status, 403, "symlink 指向工作区外必须拒绝");
    // 编码穿越：Hono 已解码一次 query，%2e%2e 在这里等价 ../；realpath 兜底。
    const encoded = await fx.app.request(
      `/api/me/files/download?path=${encodeURIComponent(root)}/%2e%2e/escape.txt`,
      { headers: { cookie } },
    );
    assert.ok([403, 404].includes(encoded.status), `encoded traversal must not 200, got ${encoded.status}`);
  } finally {
    await fx.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("files/download: 目录请求 404、根集合未装配 503", async () => {
  const { fx, root, outside } = await makeDownloadFixture();
  try {
    await mkdir(join(root, "subdir"), { recursive: true });
    const { cookie } = await pairDevice(fx);
    const dirRes = await fx.app.request(
      `/api/me/files/download?path=${encodeURIComponent(join(root, "subdir"))}`,
      { headers: { cookie } },
    );
    assert.equal(dirRes.status, 404, "目录不允许下载");
  } finally {
    await fx.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }

  const bare = await makeFixture({});
  try {
    const { cookie } = await pairDevice(bare);
    const res = await bare.app.request("/api/me/files/download?path=/tmp/x", {
      headers: { cookie },
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "download_unavailable");
  } finally {
    await bare.cleanup();
  }
});

/* ---------- preview/proxy ---------- */

test("preview/proxy: 非回环目标 403、非法 URL 400、非 http scheme 400", async () => {
  const fx = await makeFixture();
  try {
    const { cookie } = await pairDevice(fx);
    const internal = await fx.app.request(
      "/api/me/preview/proxy?url=" + encodeURIComponent("http://192.168.1.10:3000/"),
      { headers: { cookie } },
    );
    assert.equal(internal.status, 403, "内网地址必须拒绝");
    const dnsName = await fx.app.request(
      "/api/me/preview/proxy?url=" + encodeURIComponent("http://example.com/"),
      { headers: { cookie } },
    );
    assert.equal(dnsName.status, 403, "解析到非回环的域名必须拒绝");
    const badUrl = await fx.app.request("/api/me/preview/proxy?url=%%%", { headers: { cookie } });
    assert.equal(badUrl.status, 400);
    const ftp = await fx.app.request(
      "/api/me/preview/proxy?url=" + encodeURIComponent("ftp://127.0.0.1/"),
      { headers: { cookie } },
    );
    assert.equal(ftp.status, 400);
  } finally {
    await fx.cleanup();
  }
});

test("preview/proxy: 回环目标 200 透传（真实本地 http 服务）", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello-from-loopback");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const fx = await makeFixture();
  try {
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request(
      `/api/me/preview/proxy?url=${encodeURIComponent(`http://127.0.0.1:${port}/x`)}`,
      { headers: { cookie } },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain");
    assert.equal(await res.text(), "hello-from-loopback");
  } finally {
    await fx.cleanup();
    server.close();
  }
});

test("preview/proxy: HTML 注入 <base> 指向目标路径", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><head><title>t</title></head><body>hi</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const fx = await makeFixture();
  try {
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request(
      `/api/me/preview/proxy?url=${encodeURIComponent(`http://localhost:${port}/app/index.html`)}`,
      { headers: { cookie } },
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<base href="http:\/\/localhost:\d+\/app\/">/);
  } finally {
    await fx.cleanup();
    server.close();
  }
});

test("preview/proxy: >2MB HTML 200 透传（body 只消费一次，不得 500）", async () => {
  const { createServer } = await import("node:http");
  // 3MB HTML（超过 2MB 内联阈值）：带 content-length 声明，触发"预判超限走原生流"分支。
  const bigHtml = "<!doctype html><html><head></head><body>" + "x".repeat(3 * 1024 * 1024) + "</body></html>";
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(Buffer.byteLength(bigHtml)),
    });
    res.end(bigHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const fx = await makeFixture();
  try {
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request(
      `/api/me/preview/proxy?url=${encodeURIComponent(`http://127.0.0.1:${port}/big.html`)}`,
      { headers: { cookie } },
    );
    assert.equal(res.status, 200, "超限 HTML 必须原样透传，绝不能因二次消费 body 而 500");
    const body = await res.text();
    assert.equal(body.length, bigHtml.length, "透传内容完整");
    assert.ok(!body.includes("<base href="), "超限 HTML 不注入 base");
  } finally {
    await fx.cleanup();
    server.close();
  }
});

test("preview/proxy: 上游自带 <base> 时不再注入", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><html><head><base href="https://cdn.example.com/"></head></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const fx = await makeFixture();
  try {
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request(
      `/api/me/preview/proxy?url=${encodeURIComponent(`http://127.0.0.1:${port}/own-base.html`)}`,
      { headers: { cookie } },
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<base href="https:\/\/cdn\.example\.com\/">/);
    assert.equal(
      (html.match(/<base\s/gi) ?? []).length,
      1,
      "上游已有 base 时服务端不得再注入第二个",
    );
  } finally {
    await fx.cleanup();
    server.close();
  }
});

test("preview/proxy: 上游不可达 502、未装配（previewProxyEnabled=false）503", async () => {
  const fx = await makeFixture({ previewProxyEnabled: false });
  try {
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request(
      `/api/me/preview/proxy?url=${encodeURIComponent("http://127.0.0.1:1/x")}`,
      { headers: { cookie } },
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "proxy_unavailable");
  } finally {
    await fx.cleanup();
  }

  const fx2 = await makeFixture();
  try {
    const { cookie } = await pairDevice(fx2);
    // 端口 9（discard）几乎必然拒绝连接 → 502。
    const res = await fx2.app.request(
      `/api/me/preview/proxy?url=${encodeURIComponent("http://127.0.0.1:9/x")}`,
      { headers: { cookie } },
    );
    assert.equal(res.status, 502);
  } finally {
    await fx2.cleanup();
  }
});

test("preview/proxy: 限流 429（60/10min，超过即拒）", async () => {
  const fx = await makeFixture();
  try {
    const { cookie } = await pairDevice(fx);
    // 直接打满限流器：非法 URL（400）也计入 hit（与 redeem 语义一致：计数在校验前）。
    let saw429 = false;
    for (let i = 0; i < 61; i++) {
      const res = await fx.app.request("/api/me/preview/proxy?url=%%%", { headers: { cookie } });
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    assert.equal(saw429, true, "61 次内必须出现 429");
  } finally {
    await fx.cleanup();
  }
});

test("makeRateLimiter: limited-only 洪泛也有界、表满后不再接纳新 key", () => {
  // 场景 1（最坏混合模式）：4096 个真实 key（hit）填满表，随后 10 万个新 IP 只打
  // limited()。表必须封顶 4096，且新 key 判定照旧放行（无历史 ≠ 超限）。
  const limiter = makeRateLimiter(10 * 60 * 1000, 100);
  for (let i = 0; i < 4096; i++) {
    limiter.hit(`10.0.${Math.floor(i / 256) % 256}.${i % 256}`);
  }
  for (let i = 0; i < 100_000; i++) {
    const ip = `172.${Math.floor(i / 65536) % 256}.${Math.floor(i / 256) % 256}.${i % 256}`;
    assert.equal(limiter.limited(ip), false, "无历史记录的新 IP 不应被判超限");
  }
  assert.equal(limiter.size(), 4096, "表满后 limited() 不得再 set 新 key");
  // 已有 key 的判定不受影响：打满一个已有 key 到 max 后 limited 返回 true。
  for (let i = 0; i < 100; i++) {
    limiter.hit("10.0.0.1");
  }
  assert.equal(limiter.limited("10.0.0.1"), true, "已有 key 计数判定照旧");

  // 场景 2（纯 limited 洪水，空表起）：空数组 key 会在下一次 sweep（64 次调用周期）
  // 被清走（无时间戳），峰值受 sweep 周期约束（实测 ≤ 65）；实测的 65536+ 是
  // 旧代码（无条件 set、无清扫）行为。硬边界：任何时刻不得超过 4096。
  const flood = makeRateLimiter(10 * 60 * 1000, 100);
  for (let i = 0; i < 100_000; i++) {
    flood.limited(`172.${Math.floor(i / 65536) % 256}.${Math.floor(i / 256) % 256}.${i % 256}`);
  }
  assert.ok(flood.size() <= 4096, `纯 limited 洪水峰值必须 ≤ 4096，实测 ${flood.size()}`);
  assert.ok(flood.size() < 100, `空数组 key 应被 sweep 消化，实测 ${flood.size()}`);
});

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

/* ---------- preview/file（路径段式 workspace 文件预览）---------- */

async function makePreviewFileFixture(): Promise<{ fx: Fixture; root: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), "zcode-pvf-root-"));
  const outside = await mkdtemp(join(tmpdir(), "zcode-pvf-out-"));
  const fx = await makeFixture({ workspaceRootsProvider: () => [root] });
  return { fx, root, outside };
}

test("preview/file: HTML 注入 <base> 指向所在目录的路径段端点", async () => {
  const { fx, root, outside } = await makePreviewFileFixture();
  try {
    const dir = join(root, "report");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "index.html"),
      "<!doctype html><html><head><title>t</title></head><body>hi</body></html>",
      { encoding: "utf8" },
    );
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request(
      `/api/me/preview/file/${encodeURIComponent(join(dir, "index.html"))}`,
      { headers: { cookie } },
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(
      html,
      new RegExp(`<base href="/api/me/preview/file/${encodeURIComponent(dir)}/">`),
      "base href 必须是所在目录的路径段形式（相对资源闭环）",
    );
  } finally {
    await fx.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("preview/file: 相对资源经路径段回环命中（css/app.js 解码后按目录拼路径）", async () => {
  const { fx, root, outside } = await makePreviewFileFixture();
  try {
    const dir = join(root, "site");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.html"), "<html><head></head></html>", { encoding: "utf8" });
    await writeFile(join(dir, "app.css"), "body{color:red}", { encoding: "utf8" });
    const { cookie } = await pairDevice(fx);
    // base href = /api/me/preview/file/<encoded dir>/；浏览器把 css/app.css 接到该前缀后。
    const cssUrl = `/api/me/preview/file/${encodeURIComponent(dir)}/app.css`;
    const cssRes = await fx.app.request(cssUrl, { headers: { cookie } });
    assert.equal(cssRes.status, 200, "相对资源必须经路径段端点闭环命中");
    assert.equal(cssRes.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(await cssRes.text(), "body{color:red}");
  } finally {
    await fx.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("preview/file: 非 HTML 按扩展名 Content-Type 原样返回（无 base 注入）", async () => {
  const { fx, root, outside } = await makePreviewFileFixture();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(root, "chart.png"), png);
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request(
      `/api/me/preview/file/${encodeURIComponent(join(root, "chart.png"))}`,
      { headers: { cookie } },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    await fx.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("preview/file: 编码往返（中文/空格路径）与穿越拒绝、401/404 矩阵", async () => {
  const { fx, root, outside } = await makePreviewFileFixture();
  try {
    const dir = join(root, "报 告");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "文 案.html"), "<html><head></head><body>ok</body></html>", {
      encoding: "utf8",
    });
    const anon = await fx.app.request(
      `/api/me/preview/file/${encodeURIComponent(join(dir, "文 案.html"))}`,
    );
    assert.equal(anon.status, 401);
    const { cookie } = await pairDevice(fx);
    const ok = await fx.app.request(
      `/api/me/preview/file/${encodeURIComponent(join(dir, "文 案.html"))}`,
      { headers: { cookie } },
    );
    assert.equal(ok.status, 200, "中文与空格路径编码往返必须命中");
    assert.match(await ok.text(), /ok/);
    const outsideFile = join(outside, "x.html");
    await writeFile(outsideFile, "<html></html>");
    const forbidden = await fx.app.request(
      `/api/me/preview/file/${encodeURIComponent(outsideFile)}`,
      { headers: { cookie } },
    );
    assert.equal(forbidden.status, 403);
    // 穿越到真实存在的越界文件：realpath 解析成功 → 包含判定 403。
    // （穿越到不存在的路径是 404——realpath 先失败，与 download 端点同语义。）
    const traversal = await fx.app.request(
      `/api/me/preview/file/${encodeURIComponent(join(root, "..", basename(outside), "x.html"))}`,
      { headers: { cookie } },
    );
    assert.equal(traversal.status, 403);
    const missing = await fx.app.request(
      `/api/me/preview/file/${encodeURIComponent(join(root, "nope.html"))}`,
      { headers: { cookie } },
    );
    assert.equal(missing.status, 404);
  } finally {
    await fx.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("preview/file: 相对资源子目录回环（js/main.js 嵌套目录）", async () => {
  const { fx, root, outside } = await makePreviewFileFixture();
  try {
    const dir = join(root, "app");
    await mkdir(join(dir, "js"), { recursive: true });
    await writeFile(join(dir, "index.html"), "<html><head></head></html>", { encoding: "utf8" });
    await writeFile(join(dir, "js", "main.js"), "console.log(1)", { encoding: "utf8" });
    const { cookie } = await pairDevice(fx);
    // base 指向 dir（目录收尾）；浏览器把 js/main.js 接到前缀 → /api/me/preview/file/<dir>/js/main.js
    const jsUrl = `/api/me/preview/file/${encodeURIComponent(dir)}/js/main.js`;
    const res = await fx.app.request(jsUrl, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(await res.text(), "console.log(1)");
  } finally {
    await fx.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("工作区根本身是 symlink 时合法文件仍可下载（roots realpath 归一）", async () => {
  const real = await mkdtemp(join(tmpdir(), "zcode-symlink-root-real-"));
  const linkPath = `${real}-link`;
  const outside = await mkdtemp(join(tmpdir(), "zcode-symlink-root-out-"));
  try {
    await writeFile(join(real, "ok.txt"), "through-symlink-root", { encoding: "utf8" });
    // 声明 root = 指向 real 的符号链接；文件路径用真实路径（realpath 后）访问。
    await symlink(real, linkPath);
    const fx = await makeFixture({ workspaceRootsProvider: () => [linkPath] });
    try {
      const { cookie } = await pairDevice(fx);
      const res = await fx.app.request(
        `/api/me/files/download?path=${encodeURIComponent(join(real, "ok.txt"))}`,
        { headers: { cookie } },
      );
      assert.equal(res.status, 200, "root symlink 归一后，realpath 下的文件必须命中");
      assert.equal(await res.text(), "through-symlink-root");
      // 越界拒绝语义不因归一放松。
      const outsideFile = join(outside, "no.txt");
      await writeFile(outsideFile, "x");
      const forbidden = await fx.app.request(
        `/api/me/files/download?path=${encodeURIComponent(outsideFile)}`,
        { headers: { cookie } },
      );
      assert.equal(forbidden.status, 403);
    } finally {
      await fx.cleanup();
    }
  } finally {
    await rm(real, { recursive: true, force: true });
    await rm(linkPath, { force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

/* ---------- usage-summary ---------- */

test("usage-summary: 无会话 401、未装配 503", async () => {
  const bare = await makeFixture({});
  try {
    const anon = await bare.app.request("/api/me/usage-summary");
    assert.equal(anon.status, 401);
    const { cookie } = await pairDevice(bare);
    const res = await bare.app.request("/api/me/usage-summary", { headers: { cookie } });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "usage_unavailable");
  } finally {
    await bare.cleanup();
  }
});

test("usage-summary: 200 形状 deepEqual（hourISO 带本地时区偏移、24 桶不足补零）", async () => {
  // 数据源模拟真实实现：24 桶只填 2 个非零值，验证补零与锚定。
  const currentHour = Math.floor(Date.now() / 3_600_000);
  const hourISO = (hourIndex: number): string => {
    const date = new Date(hourIndex * 3_600_000);
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    const pad = (v: number) => String(v).padStart(2, "0");
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:00:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
    );
  };
  const source = async () => ({
    todayTokens: 123456,
    todayRequests: 42,
    rpm: 3,
    tpm: 7890,
    hourly24h: Array.from({ length: 24 }, (_, i) => {
      const hourIndex = currentHour - (23 - i);
      return {
        hourISO: hourISO(hourIndex),
        tokens: hourIndex === currentHour ? 500 : hourIndex === currentHour - 5 ? 1200 : 0,
      };
    }),
    generatedAt: 1_700_000_000_000,
  });
  const fx = await makeFixture({ usageSummarySource: source });
  try {
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request("/api/me/usage-summary", { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      todayTokens: number;
      todayRequests: number;
      rpm: number;
      tpm: number;
      hourly24h: Array<{ hourISO: string; tokens: number }>;
      generatedAt: number;
    };
    assert.deepEqual(
      { todayTokens: body.todayTokens, todayRequests: body.todayRequests, rpm: body.rpm, tpm: body.tpm, generatedAt: body.generatedAt },
      { todayTokens: 123456, todayRequests: 42, rpm: 3, tpm: 7890, generatedAt: 1_700_000_000_000 },
    );
    assert.equal(body.hourly24h.length, 24, "固定 24 桶");
    const nonZero = body.hourly24h.filter((b) => b.tokens > 0);
    assert.equal(nonZero.length, 2, "除两个非零桶外全部补零");
    // hourISO 必须带时区偏移且能被 new Date 本地解析回锚定小时。
    for (const bucket of body.hourly24h) {
      assert.match(bucket.hourISO, /T\d{2}:00:00[+-]\d{2}:\d{2}$/);
      const parsed = new Date(bucket.hourISO);
      assert.equal(parsed.getTime() % 3_600_000, 0, "桶锚定整点");
    }
  } finally {
    await fx.cleanup();
  }
});

test("usage-summary: 数据源抛错 500（不喂假零）、限流 429（60/10min）", async () => {
  const fx = await makeFixture({
    usageSummarySource: async () => {
      throw new Error("db gone");
    },
  });
  try {
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request("/api/me/usage-summary", { headers: { cookie } });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "usage_failed");
  } finally {
    await fx.cleanup();
  }

  const fx2 = await makeFixture({
    usageSummarySource: async () => ({
      todayTokens: 0,
      todayRequests: 0,
      rpm: 0,
      tpm: 0,
      hourly24h: [],
      generatedAt: 0,
    }),
  });
  try {
    const { cookie } = await pairDevice(fx2);
    let saw429 = false;
    for (let i = 0; i < 61; i++) {
      const res = await fx2.app.request("/api/me/usage-summary", { headers: { cookie } });
      if (res.status === 429) {
        saw429 = true;
        break;
      }
      assert.equal(res.status, 200);
    }
    assert.equal(saw429, true, "61 次内必现 429");
  } finally {
    await fx2.cleanup();
  }
});

/* ---------- makeRateLimiter key 表上限 ---------- */test("makeRateLimiter: 5000 个不同 IP 后 key 表封顶 4096，新 key fail-closed（丢弃计数不崩溃）", () => {
  const limiter = makeRateLimiter(10 * 60 * 1000, 100);
  // 前 4096 个 IP 正常接纳。
  for (let i = 0; i < 4096; i++) {
    const ip = `10.0.${Math.floor(i / 256) % 256}.${i % 256}`;
    limiter.hit(ip);
  }
  assert.equal(limiter.size(), 4096);
  // 第 4097 个新 key：hit 不再增长表（fail-closed 丢弃），limited() 对其返回 false
  //（无记录 = 未超限？——不：hit 被丢弃后 limited 仍按无记录处理。这里验证的硬边界是
  // 表尺寸不再增长；调用序 limited→hit 下攻击流量已被 limited 拒绝在先）。
  limiter.hit("10.99.99.99");
  assert.equal(limiter.size(), 4096, "表满后新 key 不得再占位");
  // 已有 key 的计数不受表满影响。
  limiter.hit("10.0.0.1");
  limiter.hit("10.0.0.1");
  assert.equal(limiter.size(), 4096);
  // 老窗口时间戳过期后：sweep 清空过期 key，新 key 重新可接纳。
  const sweeper = makeRateLimiter(5, 100); // 5ms 窗口，快速过期
  for (let i = 0; i < 4096; i++) {
    sweeper.hit(`192.168.${Math.floor(i / 256) % 256}.${i % 256}`);
  }
  assert.equal(sweeper.size(), 4096);
  // 等 6ms 让全部时间戳出窗，再触发 ≥64 次 limited()（sweep 周期）。
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      for (let i = 0; i < 64; i++) {
        sweeper.limited("sweep-trigger.test");
      }
      assert.equal(sweeper.size(), 1, "过期 key 全部清扫，只剩触发器自己的 key");
      sweeper.hit("fresh.ip.test");
      assert.equal(sweeper.size(), 2, "清扫后新 key 可重新接纳");
      resolve();
    }, 10);
  });
});

/* ---------- /api/me/workspaces/register ---------- */

test("workspaces/register: 无会话 401、CSRF 强制、缺参 400", async () => {
  const { fx, root } = await makeDownloadFixture();
  try {
    const anon = await fx.app.request("/api/me/workspaces/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root }),
    });
    assert.equal(anon.status, 401);
    const { cookie, csrfToken } = await pairDevice(fx);
    const noCsrf = await fx.app.request("/api/me/workspaces/register", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ path: root }),
    });
    assert.equal(noCsrf.status, 403);
    const ok = await fx.app.request("/api/me/workspaces/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-zcode-csrf": csrfToken,
      },
      body: JSON.stringify({ path: root }),
    });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { registered: boolean; root: string };
    assert.equal(okBody.registered, true);
    assert.equal(okBody.root, await realpath(root));
    const missing = await fx.app.request("/api/me/workspaces/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-zcode-csrf": csrfToken,
      },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
    const relative = await fx.app.request("/api/me/workspaces/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-zcode-csrf": csrfToken,
      },
      body: JSON.stringify({ path: "relative/path" }),
    });
    assert.equal(relative.status, 400);
  } finally {
    await fx.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspaces/register: 注册后文件可下载（未注册前 403），不存在的目录 400", async () => {
  const { fx, root, outside } = await makeDownloadFixture();
  try {
    // 项目文件放在 outside（不在静态根集合）：模拟"浏览器打开的项目 workspace
    // 不在 server 启动宣告根里"的真实场景。
    const filePath = join(outside, "out.txt");
    await writeFile(filePath, "project file", "utf8");
    const { cookie, csrfToken } = await pairDevice(fx);
    const post = (path: string) =>
      fx.app.request("/api/me/workspaces/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-zcode-csrf": csrfToken,
        },
        body: JSON.stringify({ path }),
      });
    const download = () =>
      fx.app.request(`/api/me/files/download?path=${encodeURIComponent(filePath)}`, {
        headers: { cookie },
      });

    // 未注册：静态根集合不含该目录 → 403
    assert.equal((await download()).status, 403);
    // 注册后：200
    assert.equal((await post(outside)).status, 200);
    const res = await download();
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "project file");
    // 不存在的目录：realpath 失败 → 400，且不会污染根集合
    assert.equal((await post(join(root, "no-such-dir"))).status, 400);
    // 文件路径（非目录）：400
    assert.equal((await post(filePath)).status, 400);
    void root;
  } finally {
    await fx.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("workspaces/register: 注册根的数量封顶 64（防异常客户端刷表）", async () => {
  const { fx, outside } = await makeDownloadFixture();
  try {
    const { cookie, csrfToken } = await pairDevice(fx);
    // 注册限流 30/min/IP——64+ 次注册必须轮换 x-real-ip 绕开限流（限流语义由
    // 既有用例验证，本用例只验证封顶）。
    let postCounter = 0;
    const post = (path: string) => {
      const ip = `10.77.${Math.floor(postCounter / 200) % 256}.${postCounter % 200 + 1}`;
      postCounter += 1;
      return fx.app.request("/api/me/workspaces/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-zcode-csrf": csrfToken,
          "x-real-ip": ip,
        },
        body: JSON.stringify({ path }),
      });
    };
    // 造 64 个真实存在的目录注册满额，再注册第 65 个 → 400
    const dirs: string[] = [];
    for (let i = 0; i < 64; i += 1) {
      const dir = join(outside, `ws-${i}`);
      await mkdir(dir, { recursive: true });
      dirs.push(dir);
      assert.equal((await post(dir)).status, 200);
    }
    const overflow = join(outside, "ws-overflow");
    await mkdir(overflow, { recursive: true });
    assert.equal((await post(overflow)).status, 400);
  } finally {
    await fx.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

/* ---------- probe 任务计数捎带（壳 FGS 完成通知兜底的数据源）---------- */

test("probe: 计数数据源已装配 → 响应带挂起交互/运行中/完成未读三项计数", async () => {
  const fx = await makeFixture({
    pendingSummarySource: async () => ({
      pendingInteractions: 3,
      runningTasks: 2,
      completedUnread: 1,
    }),
  });
  try {
    const { deviceToken } = await pairDeviceWithToken(fx);
    const res = await fx.app.request("/api/auth/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.pendingInteractions, 3);
    assert.equal(body.runningTasks, 2);
    assert.equal(body.completedUnread, 1);
    assert.equal(typeof body.instanceId, "string");
  } finally {
    await fx.cleanup();
  }
});

test("probe: 计数数据源抛错 → 字段缺席但 probe 主语义不受影响", async () => {
  const fx = await makeFixture({
    pendingSummarySource: async () => {
      throw new Error("counts unavailable");
    },
  });
  try {
    const { deviceToken } = await pairDeviceWithToken(fx);
    const res = await fx.app.request("/api/auth/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal("pendingInteractions" in body, false);
    assert.equal("runningTasks" in body, false);
    assert.equal("completedUnread" in body, false);
    assert.equal(typeof body.deviceId, "string");
  } finally {
    await fx.cleanup();
  }
});

test("probe: 计数数据源未装配 → 响应无计数字段（旧壳兼容基线）", async () => {
  const fx = await makeFixture({});
  try {
    const { deviceToken } = await pairDeviceWithToken(fx);
    const res = await fx.app.request("/api/auth/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal("pendingInteractions" in body, false);
    assert.equal("runningTasks" in body, false);
    assert.equal("completedUnread" in body, false);
    assert.equal("pendingDigest" in body, false);
  } finally {
    await fx.cleanup();
  }
});

test("probe: 数据源带 pendingDigest → 响应捎带脱敏摘要", async () => {
  const fx = await makeFixture({
    pendingSummarySource: async () => ({
      pendingInteractions: 1,
      runningTasks: 0,
      completedUnread: 0,
      pendingDigest: { kind: "userInput", text: "用哪个库？ date-fns/dayjs" },
    }),
  });
  try {
    const { deviceToken } = await pairDeviceWithToken(fx);
    const res = await fx.app.request("/api/auth/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body.pendingDigest, {
      kind: "userInput",
      text: "用哪个库？ date-fns/dayjs",
    });
  } finally {
    await fx.cleanup();
  }
});

test("probe: 有挂起但无摘要 → pendingDigest 缺席，计数仍在", async () => {
  const fx = await makeFixture({
    pendingSummarySource: async () => ({
      pendingInteractions: 2,
      runningTasks: 0,
      completedUnread: 0,
    }),
  });
  try {
    const { deviceToken } = await pairDeviceWithToken(fx);
    const res = await fx.app.request("/api/auth/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal("pendingDigest" in body, false);
    assert.equal(body.runningTasks, 0);
    assert.equal(body.completedUnread, 0);
  } finally {
    await fx.cleanup();
  }
});

test("probe: 数据源抛错 → pendingDigest 与计数一并缺席，主语义不受影响", async () => {
  const fx = await makeFixture({
    pendingSummarySource: async () => {
      throw new Error("summary unavailable");
    },
  });
  try {
    const { deviceToken } = await pairDeviceWithToken(fx);
    const res = await fx.app.request("/api/auth/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceToken }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal("pendingDigest" in body, false);
    assert.equal(typeof body.deviceId, "string");
  } finally {
    await fx.cleanup();
  }
});

test("pending-summary: 数据源带 pendingDigest → 端点原样返回", async () => {
  const fx = await makeFixture({
    pendingSummarySource: async () => ({
      pendingInteractions: 1,
      runningTasks: 0,
      completedUnread: 0,
      pendingDigest: { kind: "permission", text: "需要执行 rm -rf build" },
    }),
  });
  try {
    const { cookie } = await pairDevice(fx);
    const res = await fx.app.request("/api/me/pending-summary", {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body.pendingDigest, {
      kind: "permission",
      text: "需要执行 rm -rf build",
    });
  } finally {
    await fx.cleanup();
  }
});
