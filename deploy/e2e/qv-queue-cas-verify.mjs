/*
 * 队列 CAS 修复（dispatchQueueCas stale 重试）——方法 A：确定性 stale 注入 A/B。
 *
 * 原理：
 * - 用已配对 profile 打开真实 origin（Cookie/后端/WS 全真），同源静态资源换成候选构建
 *   （做法与其它候选构建验证脚本一致：serviceWorkers block + 禁缓存）。
 * - routeWebSocket 透传双方向帧；对 server→client 方向解析 RPC 帧，找到
 *   "commandId==<目标> && status==accepted" 的 CommandAck JSON，把 status 改成 "stale"
 *   （accepted→stale 等长，13B 头与 VQL 长度不变；revisionAtDecision 保持服务端真值）。
 *   仅对第一次命中的 ack 注入；之后放行。
 * - 命令 id 捕获：对 client→server 方向解析出 sendQueuedNow 信封的 commandId。
 *
 * 帧格式（packages/rpc/src/protocol.ts:186 + serialization.ts:155）：
 *   [13B 头: type(1) id(4BE) ack(4BE) len(4BE)] + body
 *   body = serialize(header) + serialize(arg)
 *   serialize(x): [1B 类型标签][VQL 长度][数据]；Array=0x04, Object=0x05(JSON 文本)
 *
 * 判定：
 * - rpcCount：同 commandId 的 v4 RPC 请求次数（client→server 方向）。
 * - staleCount：注入的 stale ack 数（应为 1）。
 * - consumed：注入后 8s 内 v4-queue-item 消失（或 v4-queue 面板消失）。
 *   baseline 预期 consumed=false（无重试，UI 不收敛）；修复版预期 true + rpcCount>=2。
 *
 * 边界（便于正确解读结果）：注入场景中真实 CLI 已执行了 sendQueuedNow（第一次请求就到了
 * CLI 并生效），所以本测法验证的是「UI 在收到 stale ack 后是否自动重试并收敛 UI」，
 * 不是端到端语义；端到端由方法 B（长任务稳住队列）补。
 *
 * 用法：
 *   R4_DIST=<dist> R4_PROFILE=<profile> R4_TOUCH=1 \
 *   R4_PW_CORE=... R4_CHROME=... node qv-queue-cas-verify.mjs <round>
 * 流程：加载 → 建会话（草稿首发 sleep 长任务，自建测试会话）→ 发第 2 条进队列
 *   → 点「立即」→ 观测。每轮建一个新会话（round 后缀），结束时尝试删除。
 */
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = await import(process.env.R4_PW_CORE ?? 'playwright-core');

const DIST = process.env.R4_DIST;
const ORIGIN = process.env.R4_ORIGIN ?? 'https://<部署域名>';
const PROFILE = process.env.R4_PROFILE;
const ROUND = process.argv[2] ?? '1';
const CMD_TYPE = process.env.QV_CMD_TYPE ?? 'sendQueuedNow'; // 也可 deleteQueueItem

if (!DIST || !existsSync(DIST) || !PROFILE) {
  console.error('usage: R4_DIST=<dir> R4_PROFILE=<dir> node qv-queue-cas-verify.mjs <round>');
  process.exit(2);
}

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.txt': 'text/plain', '.map': 'application/json',
};
const j = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── RPC 帧解析（serialization.ts 镜像，只读不改） ──
function readVQL(buf, pos) {
  let value = 0, n = 0;
  for (; ; n += 7) {
    const b = buf[pos++];
    value += (b & 0b01111111) * Math.pow(2, n);
    if (!(b & 0b10000000)) return { value, pos };
  }
}
// 解析 body 的顶层序列化项，返回 [{type, start, end(字节数区间)}]，object 项附原文
function scanSerializedItems(body) {
  const items = [];
  let pos = 0;
  const readVQL = (p) => {
    let value = 0, n = 0;
    for (; ; n += 7) {
      const b = body[p++];
      value += (b & 0b01111111) * Math.pow(2, n);
      if (!(b & 0b10000000)) return { value, pos: p };
    }
  };
  while (pos < body.length) {
    const type = body[pos++];
    const start = pos;
    if (type === 0x01 || type === 0x04 || type === 0x05) {
      const { value: len, pos: p } = readVQL(pos);
      pos = p + len;
      items.push({
        type: type === 0x01 ? 'string' : type === 0x04 ? 'array' : 'object',
        start, end: pos,
        text: Buffer.from(body.subarray(start, pos)).toString('utf8'),
      });
    } else if (type === 0x06) {
      const { pos: p } = readVQL(pos);
      pos = p;
      items.push({ type: 'int', start, end: pos });
    } else if (type === 0x00) {
      items.push({ type: 'undefined', start, end: pos });
    } else {
      // Buffer/VSBuffer/嵌套结构：保守起见停止扫描本帧（命令 ack 帧不会出现）
      items.push({ type: 'raw', tag: type, start, end: body.length });
      break;
    }
  }
  return items;
}

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  executablePath: process.env.R4_CHROME ?? undefined,
  viewport: { width: 390, height: 844 },
  ...(process.env.R4_TOUCH === '1' ? { hasTouch: true, isMobile: true } : {}),
  locale: 'zh-CN',
  serviceWorkers: 'block',
  args: ['--no-sandbox', '--lang=zh-CN', '--disable-http-cache', '--disk-cache-size=1'],
});
const page = context.pages()[0] ?? (await context.newPage());

let servedStatic = 0;
await page.route('**/*', async (route) => {
  const req = route.request();
  let url;
  try { url = new URL(req.url()); } catch { return route.fallback(); }
  if (url.origin !== ORIGIN || req.method() !== 'GET') return route.fallback();
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/zusage/')) {
    return route.fallback();
  }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = join(DIST, rel);
  if (!existsSync(file) || !statSync(file).isFile()) return route.fallback();
  servedStatic += 1;
  return route.fulfill({ status: 200, contentType: MIME[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
});

// ── WS 拦截状态 ──
const state = {
  armed: false,          // 点了「立即」之后才武装注入
  injected: 0,           // 注入次数（目标=1）
  targetCommandId: null, // 从 client→server 帧捕获的命令 id
  rpcCount: 0,           // 该 commandId 的上行 RPC 计数
  rpcTimeline: [],       // [{t, phase}]
  staleAcksSeen: 0,      // UI 实际收到的 stale ack（含注入的）
  captured: [],          // 捕获到的命令上行（type, commandId, baseRevision）
  errors: [],
};

function tryParseEnvelopesFromItem(item, dir) {
  // Array 项是 header [type,id,channel,method]；Object 项是 arg（请求）或 data（响应）
  if (item.type !== 'object' && item.type !== 'array') return;
  let obj;
  try { obj = JSON.parse(item.text); } catch { return; }
  if (dir === 'up') {
    // 请求 arg: {connectionId?, workspacePath, envelope:{type, commandId,...}}
    const env = obj && typeof obj === 'object' ? obj.envelope : null;
    if (env && typeof env.commandId === 'string' && typeof env.type === 'string') {
      state.captured.push({ dir, type: env.type, commandId: env.commandId, baseRevision: env.baseRevision });
      if (env.type === CMD_TYPE) {
        state.rpcCount += 1;
        state.rpcTimeline.push({ t: Date.now(), phase: `up#${state.rpcCount}` });
        if (!state.targetCommandId) state.targetCommandId = env.commandId;
      }
    }
  } else {
    // 响应 data: CommandAck {commandId, status, revisionAtDecision}
    if (obj && typeof obj === 'object' && typeof obj.commandId === 'string' && typeof obj.status === 'string') {
      if (state.targetCommandId && obj.commandId === state.targetCommandId) {
        if (obj.status === 'stale') state.staleAcksSeen += 1;
        // 注入点：仅第一次 accepted。返回 rewrite 指令（等长替换），由 processFrames 重建帧。
        if (state.armed && state.injected === 0 && obj.status === 'accepted') {
          const patched = item.text.replace('"status":"accepted"', '"status":"stale"');
          if (patched !== item.text) {
            state.injected += 1;
            state.rpcTimeline.push({ t: Date.now(), phase: 'injected-stale' });
            item.rewrite = Buffer.from(patched, 'utf8');
          }
        }
      }
    }
  }
}

// 返回 null（不重写）或重写后的完整帧 Buffer
function processFrames(data, dir) {
  const buf = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  let pos = 0;
  let rewrite = null;
  while (pos + 13 <= buf.length) {
    const len = buf.readUInt32BE(pos + 9);
    if (pos + 13 + len > buf.length) break;
    const bodyStart = pos + 13;
    const body = buf.subarray(bodyStart, bodyStart + len);
    pos += 13 + len;
    if (len === 0) continue;
    try {
      const items = scanSerializedItems(body);
      for (const it of items) {
        tryParseEnvelopesFromItem(it, dir);
        if (it.rewrite) {
          // body 内等长替换 → 13B 头的 len 不变，直接拼新帧
          const patchedBody = Buffer.concat([
            body.subarray(0, it.start),
            it.rewrite,
            body.subarray(it.end),
          ]);
          rewrite = Buffer.concat([
            buf.subarray(0, bodyStart),
            patchedBody,
            buf.subarray(bodyStart + len),
          ]);
        }
      }
    } catch (e) {
      state.errors.push(`parse:${e.message}`);
    }
  }
  return rewrite;
}

let sockCount = 0;
await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
  sockCount += 1;
  const server = ws.connectToServer();
  ws.onMessage((m) => { try { processFrames(m, 'up'); } catch {} server.send(m); });
  server.onMessage((m) => {
    let out = m;
    try { out = processFrames(m, 'down') ?? m; } catch {}
    ws.send(out);
  });
  ws.onClose(() => server.close());
  server.onClose(() => ws.close());
});

await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  for (const reg of regs) await reg.unregister();
  const keys = await caches.keys();
  for (const key of keys) await caches.delete(key);
});
await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);

// ── 页面辅助 ──
const INPAGE = () => {
  window.__qv = {
    composer() { return document.querySelector('[data-testid="v4-composer-input"]'); },
    sendBtn() { return document.querySelector('[data-testid="v4-composer-send"]'); },
    stopBtn() { return document.querySelector('[data-testid="v4-stop"]'); },
    queue() { return document.querySelector('[data-testid="v4-queue"]'); },
    queueItems() { return Array.from(document.querySelectorAll('[data-testid^="v4-queue-item-"]:not([data-testid^="v4-queue-item-send-now"]):not([data-testid^="v4-queue-item-edit"]):not([data-testid^="v4-queue-item-delete"])')); },
    sendNowBtns() { return Array.from(document.querySelectorAll('[data-testid^="v4-queue-item-send-now"]')); },
    editingDisabled() {
      const b = document.querySelector('[data-testid^="v4-queue-item-edit"]');
      return b ? b.disabled : null;
    },
    bodyText() { return (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200); },
  };
};
await page.evaluate(INPAGE);

// bridge 就绪轮询（Lexical root 重挂时 100ms interval 自动补挂；上限 20s）
let composerReady = false;
for (let i = 0; i < 40; i += 1) {
  composerReady = await page.evaluate(
    () => Boolean(document.querySelector('[data-testid="v4-composer-input"]')?.__zcodeLexicalInputE2E),
  );
  if (composerReady) break;
  await sleep(500);
}
await page.evaluate(INPAGE); // 重挂后取一次新引用

async function typeAndSend(text) {
  const ok = await page.evaluate((t) => {
    const c = window.__qv.composer();
    if (!c) return false;
    // 驱动真实 Lexical state（document.execCommand 会绕过 editor update）
    const bridge = c.__zcodeLexicalInputE2E;
    if (!bridge || typeof bridge.setText !== 'function') return false;
    bridge.setText(t);
    return Boolean(window.__qv.sendBtn());
  }, text);
  if (!ok) throw new Error('composer bridge 不可用');
  await page.evaluate(() => window.__qv.sendBtn()?.click());
}

// ── 流程 ──
const result = { round: ROUND, dist: DIST, cmdType: CMD_TYPE, steps: {} };
try {
  // 1. 草稿首发：sleep 长任务（1 轮内保持 busy）
  result.steps.firstSend = await (async () => {
    if (!composerReady) {
      return { running: false, reason: 'composer-bridge-not-ready', body: await page.evaluate(() => window.__qv.bodyText()) };
    }
    const text = `请用 Bash 工具执行 sleep 240，完成后只回复 ok。这是自动化验证会话 ${ROUND}。`;
    await typeAndSend(text);
    // 等待会话创建+运行中（stop 按钮出现）
    for (let i = 0; i < 60; i += 1) {
      if (await page.evaluate(() => Boolean(window.__qv.stopBtn()))) return { running: true, waitedMs: i * 500 };
      await sleep(500);
    }
    return { running: false, body: await page.evaluate(() => window.__qv.bodyText()) };
  })();
  if (!result.steps.firstSend.running) throw new Error('首个 turn 未进入运行中');

  // 2. 发第 2 条 → 应进队列
  result.steps.queueAdd = await (async () => {
    await typeAndSend(`排队消息 ${ROUND}：回复 pong 即可。`);
    for (let i = 0; i < 24; i += 1) {
      const q = await page.evaluate(() => ({
        panel: Boolean(window.__qv.queue()),
        items: window.__qv.queueItems().length,
        editDisabled: window.__qv.editingDisabled(),
      }));
      if (q.panel && q.items >= 1) return { queued: true, ...q, waitedMs: i * 500 };
      await sleep(500);
    }
    return { queued: false, body: await page.evaluate(() => window.__qv.bodyText()) };
  })();
  if (!result.steps.queueAdd.queued) throw new Error('第 2 条未进队列');

  // 3. 武装注入 + 点「立即」
  state.armed = true;
  const itemId = await page.evaluate(() => {
    const el = document.querySelector('[data-queue-item-id]');
    return el ? el.getAttribute('data-queue-item-id') : null;
  });
  const clicked = await page.evaluate((id) => {
    const btn = document.querySelector(`[data-testid="v4-queue-item-send-now-${id}"]`);
    if (!btn) return false;
    btn.click();
    return true;
  }, itemId);
  result.steps.click = { clicked, itemId, armed: true };
  if (!clicked) throw new Error('「立即」按钮未找到');

  // 4. 观测 8s：项是否被消费（UI 收敛）
  const timeline = [];
  for (let i = 0; i < 16; i += 1) {
    const s = await page.evaluate(() => ({
      items: window.__qv.queueItems().length,
      panel: Boolean(window.__qv.queue()),
    }));
    timeline.push({ ms: i * 500, ...s });
    if (s.items === 0) break;
    await sleep(500);
  }
  result.steps.observe = { timeline, consumed: timeline.some((t) => t.items === 0) };

  // 5. 清理：停止 turn + 删除会话（尽力而为）
  result.steps.cleanup = await (async () => {
    const stopped = await page.evaluate(() => { window.__qv.stopBtn()?.click(); return Boolean(window.__qv.stopBtn()); }).catch(() => false);
    await sleep(2500);
    // 删除会话：任务行右键/长按菜单较脆弱，这里通过 store 命令删除属于测试会话自己。
    // UI 入口找不到时留 sessionId 到报告。
    return { stopped };
  })();
  const sessionId = await page.evaluate(() => {
    // 从侧栏选中项或 URL 提取当前 sessionId
    const el = document.querySelector('[data-testid^="task-item-sess_"][aria-current="true"], [data-testid^="task-item-sess_"][data-active="true"]');
    if (el) return el.getAttribute('data-testid').replace('task-item-', '');
    return null;
  });
  result.sessionIdUiGuess = sessionId;
} catch (e) {
  result.error = String(e && e.stack ? e.stack : e);
} finally {
  result.ws = {
    sockets: sockCount,
    servedStatic,
    targetCommandId: state.targetCommandId,
    rpcCount: state.rpcCount,
    injected: state.injected,
    staleAcksSeen: state.staleAcksSeen,
    rpcTimeline: state.rpcTimeline,
    errors: state.errors.slice(0, 10),
    captured: state.captured.filter((c) => c.type === CMD_TYPE || c.type === 'sendText').slice(0, 12),
  };
  console.log('RESULT ' + j(result));
  try { writeFileSync(`/tmp/qv-round-${ROUND}-${DIST.replace(/\W+/g, '_').slice(-30)}.json`, j(result, null, 2)); } catch {}
  await context.close();
}
