// relay-v29-e2e-test.mjs —— v29 HTTP 层冒烟测试：真实 server + 桩 3030，零依赖直跑。
// 验证：/api/relay/ticket 三态（无 Cookie 401/坏 Cookie 401/好 Cookie 签发）、
//       入口 ?ticket= 消费→302、重复用 403、未入場票打 API 403、入場票+好 Cookie 200、
//       legacy token 入口兼容、裸 /web-remote 自助签发、wsUrl 无 query token。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

/* ---------- 桩 3030：/api/server-info 按会话 token 判定，/api/auth/renew 按设备 token 判定 ---------- */
import http from 'node:http';
const GOOD_SESSION = 'sess-good';
const LOCAL_DEVICE = 'dev-local';
const stub3030 = http.createServer((req, res) => {
  const cookie = String(req.headers.cookie || '');
  if (req.url === '/api/server-info') {
    // GOOD_SESSION=浏览器会话；sess-local=relay 本地凭据 renew 出的会话
    if (cookie === `zcode_device_session=${GOOD_SESSION}` || cookie === 'zcode_device_session=sess-local') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '3.14.3', workspaces: [{ path: '/tmp/ws' }] }));
    } else {
      res.writeHead(401); res.end();
    }
    return;
  }
  if (req.url === '/api/auth/renew' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const j = JSON.parse(b || '{}');
      if (j.deviceToken === LOCAL_DEVICE) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sessionToken: 'sess-local' }));
      } else { res.writeHead(401); res.end(); }
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => stub3030.listen(0, '127.0.0.1', r));
const stubPort = stub3030.address().port;

/* ---------- 拉起 relay-v29 ---------- */
const relayPort = 3099 + Math.floor(Math.random() * 100);
const env = {
  ...process.env,
  ZCODE_RELAY_PORT: String(relayPort),
  ZCODE_HOST_ORIGIN: `http://127.0.0.1:${stubPort}`,
  ZCODE_REMOTE_TOKEN: 'legacy-token-0123456789abcdef',
  ZCODE_RELAY_LOCAL_SESSION: LOCAL_DEVICE,
  ZCODE_TASKS_DB: '/nonexistent/tasks.sqlite', // 降级路径一并覆盖
  ZCODE_REMOTE_MIRROR: '/nonexistent-mirror',  // 回源分支不触发（我们只打 API/入口）
};
const relay = spawn(process.execPath, [new URL('./relay-v29.mjs', import.meta.url).pathname], { env });
relay.stderr.on('data', (d) => process.stderr.write('[relay-err] ' + d));
// 等监听
for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${relayPort}/api/v1/client/configs`); break; }
  catch { await new Promise((r) => setTimeout(r, 100)); }
}

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '—', e.message); process.exitCode = 1; }
}
const BASE = `http://127.0.0.1:${relayPort}`;

await t('ticket 签发：无 Cookie 401', async () => {
  const r = await fetch(BASE + '/api/relay/ticket', { method: 'POST' });
  assert.equal(r.status, 401);
});
await t('ticket 签发：坏会话 Cookie 401（透传 3030 401）', async () => {
  const r = await fetch(BASE + '/api/relay/ticket', {
    method: 'POST', headers: { cookie: 'zcode_device_session=sess-bad' },
  });
  assert.equal(r.status, 401);
});
let ticket = '';
await t('ticket 签发：好会话 Cookie → 32hex ticket + entryUrl', async () => {
  const r = await fetch(BASE + '/api/relay/ticket', {
    method: 'POST', headers: { cookie: `zcode_device_session=${GOOD_SESSION}` },
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.ticket, /^[0-9a-f]{32}$/);
  assert.equal(j.entryUrl, '/web-remote?ticket=' + j.ticket);
  ticket = j.ticket;
});
await t('入口 ?ticket=：消费 → 302 remoteControlToken=<同值>', async () => {
  const r = await fetch(BASE + '/web-remote?ticket=' + ticket, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/web-remote?remoteControlToken=' + ticket);
});
await t('同一 ticket 再走入口：403（单次）', async () => {
  const r = await fetch(BASE + '/web-remote?ticket=' + ticket, { redirect: 'manual' });
  assert.equal(r.status, 403);
});
await t('已入場票 + 好 Cookie：bootstrap 200，且带本地会话宣告', async () => {
  const r = await fetch(BASE + `/api/remote-control/windows/bootstrap/${ticket}`, {
    headers: { cookie: `zcode_device_session=${GOOD_SESSION}` },
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.desktopAppVersion, '3.14.3');
  assert.deepEqual(j.workspaces, [{ kind: 'local', label: 'ws', workspacePath: '/tmp/ws', workspacePurpose: 'project' }]);
});
await t('已入場票 + 坏 Cookie：bootstrap 401（双因子之 Cookie）', async () => {
  const r = await fetch(BASE + `/api/remote-control/windows/bootstrap/${ticket}`, {
    headers: { cookie: 'zcode_device_session=sess-bad' },
  });
  assert.equal(r.status, 401);
});
await t('未入場票 + 好 Cookie：bootstrap 403（双因子之票）', async () => {
  const r = await fetch(BASE + `/api/remote-control/windows/bootstrap/${'f'.repeat(32)}`, {
    headers: { cookie: `zcode_device_session=${GOOD_SESSION}` },
  });
  assert.equal(r.status, 403);
});
await t('workspace-bridge：wsUrl 不带 ?token=（本环境无 TLS，推导为 ws://；生产 nginx 下为 wss://）', async () => {
  const r = await fetch(BASE + `/api/remote-control/windows/${ticket}/workspace-bridge`, {
    method: 'POST',
    headers: { cookie: `zcode_device_session=${GOOD_SESSION}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceKey: '/tmp/ws' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.wsUrl, /^wss?:\/\//, 'wsUrl=' + j.wsUrl);
  assert.ok(!j.wsUrl.includes('token='), 'wsUrl 不应再带 query token: ' + j.wsUrl);
});
await t('legacy token：入口参数模式直落（HTML 分支不炸），端点可用', async () => {
  const r = await fetch(BASE + `/api/remote-control/windows/bootstrap/${'legacy-token-0123456789abcdef'}`, {
    headers: { cookie: `zcode_device_session=${GOOD_SESSION}` },
  });
  assert.equal(r.status, 200);
});
await t('legacy token + 坏 Cookie：401（legacy 也需真凭据）', async () => {
  const r = await fetch(BASE + `/api/remote-control/windows/bootstrap/${'legacy-token-0123456789abcdef'}`, {
    headers: { cookie: 'zcode_device_session=sess-bad' },
  });
  assert.equal(r.status, 401);
});
await t('裸 /web-remote + 好 Cookie：自助 302 发票', async () => {
  const r = await fetch(BASE + '/web-remote', { redirect: 'manual', headers: { cookie: `zcode_device_session=${GOOD_SESSION}` } });
  assert.equal(r.status, 302);
  const loc = r.headers.get('location') || '';
  assert.match(loc, /^\/web-remote\?remoteControlToken=[0-9a-f]{32}$/);
  // 该票应立即可打 API（entered:true）
  const t2 = new URL(loc, 'http://x').searchParams.get('remoteControlToken');
  const r2 = await fetch(BASE + `/api/remote-control/windows/bootstrap/${t2}`, {
    headers: { cookie: `zcode_device_session=${GOOD_SESSION}` },
  });
  assert.equal(r2.status, 200);
});
await t('裸 /web-remote + 坏 Cookie：401 引导配对', async () => {
  const r = await fetch(BASE + '/web-remote', { redirect: 'manual', headers: { cookie: 'zcode_device_session=sess-bad' } });
  assert.equal(r.status, 401);
});
/* ---------- 第二实例：不注入 ZCODE_RELAY_LOCAL_SESSION ----------
 * 部署后"relay-system 设备被撤销 / env 凭据丢失"是真实运行态：此时 relay 必须仍能
 * 服务入口与 bootstrap（任务列表来自本机 sqlite），仅 workspace 宣告降级为空。 */
const relay2Port = relayPort + 137;
const relay2 = spawn(process.execPath, [new URL('./relay-v29.mjs', import.meta.url).pathname], {
  env: {
    ...env,
    ZCODE_RELAY_PORT: String(relay2Port),
    ZCODE_RELAY_LOCAL_SESSION: '', // 显式置空：即使测试机环境泄漏了该变量也按"无凭据"跑
  },
});
relay2.stderr.on('data', (d) => process.stderr.write('[relay2-err] ' + d));
for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${relay2Port}/api/v1/client/configs`); break; }
  catch { await new Promise((r) => setTimeout(r, 100)); }
}

await t('无本地凭据实例：入口链照常（裸 /web-remote 自助 302 发票）', async () => {
  const r = await fetch(`http://127.0.0.1:${relay2Port}/web-remote`, {
    redirect: 'manual', headers: { cookie: `zcode_device_session=${GOOD_SESSION}` },
  });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') || '', /^\/web-remote\?remoteControlToken=[0-9a-f]{32}$/);
});
await t('无本地凭据实例：bootstrap 仍 200 且 workspaces 宣告为空（降级路径）', async () => {
  const entry = await fetch(`http://127.0.0.1:${relay2Port}/web-remote`, {
    redirect: 'manual', headers: { cookie: `zcode_device_session=${GOOD_SESSION}` },
  });
  const t2 = new URL(entry.headers.get('location'), 'http://x').searchParams.get('remoteControlToken');
  const r = await fetch(`http://127.0.0.1:${relay2Port}/api/remote-control/windows/bootstrap/${t2}`, {
    headers: { cookie: `zcode_device_session=${GOOD_SESSION}` },
  });
  assert.equal(r.status, 200, 'bootstrap 不应因本地凭据缺失而失败');
  const j = await r.json();
  assert.deepEqual(j.workspaces, [], 'server-info 宣告降级应为空数组');
  assert.deepEqual(j.tasks, [], '任务列表为空（tasks-db 为桩路径，降级一致）');
  assert.equal(j.desktopAppVersion, '3.14.3', '版本退默认值（server-info 拿不到）');
});

console.log(`\n${passed} passed${process.exitCode ? '（存在 FAIL）' : ''}`);
relay.kill('SIGTERM');
relay2.kill('SIGTERM');
stub3030.close();
process.exit(process.exitCode || 0);
