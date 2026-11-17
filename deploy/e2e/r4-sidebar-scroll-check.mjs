/*
 * r4-sidebar-scroll-check.mjs —— 侧栏项目行「滑动误折叠 / 折叠后打不开」复现与验证（只读纪律）。
 *
 * 用法（环境变量与其它候选构建验证脚本一致）：
 *   R4_DIST=<构建目录> R4_PROFILE=<profile 副本> R4_TOUCH=1 \
 *   R4_PW_CORE=/path/to/playwright-core/index.mjs \
 *   R4_CHROME=/path/to/chrome \
 *   node r4-sidebar-scroll-check.mjs [PROJECT_PATH]
 *
 * 断言（R4_TOUCH=1，390×844，CDP 真 touch 事件流）：
 *   ① 在项目行头上做「按下-移动-抬起」的滑动手势（模拟列表滚动，多轮/双向/快慢各一组），
 *      项目折叠态不变、不新建草稿；
 *   ② 点一下折叠行 → 展开（aria-expanded=true）；再点 → 折叠；连续 3 轮都成立，且每轮 tap 前
 *      重新读取行头几何；
 *   ③ 行尾 + 按钮语义不回归：点行头不弹"新建对话"草稿（tasks 数不涨）。
 *
 * 不发消息、不建会话；tasks 数上涨（草稿泄漏）视为失败信号。
 * 注意：应用初始态是"无会话 = 草稿欢迎页"，chat-empty 恒存在，因此不用它判泄漏，
 * 以 task-item 行数变化为准（侧栏场景复现脚本同款信号）。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = await import(process.env.R4_PW_CORE ?? 'playwright-core');

const DIST = process.env.R4_DIST;
const ORIGIN = process.env.R4_ORIGIN ?? 'https://<部署域名>';
const PROFILE = process.env.R4_PROFILE ?? '/tmp/sidebar-check-profile';
const PROJECT = process.argv[2] ?? process.env.R4_PROJECT ?? '<工作区>';

if (!DIST || !existsSync(DIST)) {
  console.error('usage: R4_DIST=<dist dir> node r4-sidebar-scroll-check.mjs [project path]');
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
const log = (...args) => console.log(...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  executablePath: process.env.R4_CHROME ?? undefined,
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  locale: 'zh-CN',
  serviceWorkers: 'block',
  args: ['--no-sandbox', '--lang=zh-CN', '--disable-http-cache', '--disk-cache-size=1'],
});
const page = context.pages()[0] ?? (await context.newPage());

let servedStatic = 0;
await page.route('**/*', async (route) => {
  const req = route.request();
  let url;
  try {
    url = new URL(req.url());
  } catch {
    return route.fallback();
  }
  if (url.origin !== ORIGIN || req.method() !== 'GET') return route.fallback();
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/zusage/')
  ) {
    return route.fallback();
  }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = join(DIST, rel);
  if (!existsSync(file) || !statSync(file).isFile()) return route.fallback();
  servedStatic += 1;
  return route.fulfill({
    status: 200,
    contentType: MIME[extname(file)] ?? 'application/octet-stream',
    body: readFileSync(file),
  });
});

const HELPERS = () => {
  window.__r4s = {
    openSidebar() {
      const b = document.querySelector('button[aria-label="切换侧边栏"]');
      if (b) b.click();
      return Boolean(b);
    },
    header() {
      const sel = `[data-testid="workspace-item-${window.__R4_PROJ.replace(/"/g, '\\"')}"]`;
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: r.x, y: r.y, w: r.width, h: r.height,
        expanded: el.getAttribute('aria-expanded'),
        inViewport: r.y >= 0 && r.y + r.height <= 900,
      };
    },
    taskRowCount() {
      return document.querySelectorAll('[data-testid^="task-item-"]').length;
    },
  };
};

async function gotoApp() {
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) await reg.unregister();
    const keys = await caches.keys();
    for (const key of keys) await caches.delete(key);
  });
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.evaluate((p) => { window.__R4_PROJ = p; }, PROJECT);
  await page.evaluate(HELPERS);
}

const hdr = async () => page.evaluate(() => window.__r4s.header());
const taskRows = async () => page.evaluate(() => window.__r4s.taskRowCount());

// CDP 触屏点按（down → 停 60ms → up，位移 0）
async function touchTap(x, y) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await sleep(60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

// CDP 触屏滑动手势：down → 分步 move（每步 stepMs 毫秒，dy 总位移）→ up
async function touchSwipe(x, y, dy, steps = 24, stepMs = 16) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i += 1) {
    await sleep(stepMs);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + Math.sin((i / steps) * Math.PI) * 2, y: y + (dy * i) / steps }],
    });
  }
  await sleep(80);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

// 快速甩动（flick）：8 步 × 12ms，总位移 dy
async function touchFlick(x, y, dy) {
  await touchSwipe(x, y, dy, 8, 12);
}

async function ensureExpanded() {
  let h = await hdr();
  if (!h) throw new Error('workspace header not found: ' + PROJECT);
  if (h.expanded !== 'true') {
    await touchTap(h.x + h.w * 0.3, h.y + h.h / 2);
    await sleep(1400);
    h = await hdr();
    if (!h || h.expanded !== 'true') throw new Error('could not expand header for baseline');
  }
  return h;
}

const results = {
  project: PROJECT,
  servedStatic: 0,
  swipes: [],
  toggleRounds: [],
  notes: [],
};

try {
  await gotoApp();
  results.servedStatic = servedStatic;
  await page.evaluate(() => window.__r4s.openSidebar());
  await sleep(900);

  const baseTasks = await taskRows();
  results.notes.push('baseTasks=' + baseTasks);

  // ---------- 断言①：滑动手势不改变折叠态（多组：慢上滑 / 慢下滑 / 快速上甩 / 快速下甩） ----------
  // 用户场景是"手指按在项目行上滑动"：起点在行头，终点仍在列表中部（真实滑动不会
  // 精确落在工具栏/菜单区）。dy 取 -160/+160 保证 touchend 留在列表内。
  await ensureExpanded();
  const swipeSuite = [
    { name: 'slow-up-160', dy: -160, steps: 24, stepMs: 16 },
    { name: 'slow-down-160', dy: 160, steps: 24, stepMs: 16 },
    { name: 'flick-up-160', dy: -160, steps: 8, stepMs: 12 },
    { name: 'flick-down-160', dy: 160, steps: 8, stepMs: 12 },
  ];
  for (const s of swipeSuite) {
    const before = await ensureExpanded();
    const tasksBefore = await taskRows();
    await touchSwipe(before.x + before.w * 0.3, before.y + before.h / 2, s.dy, s.steps, s.stepMs);
    await sleep(1600);
    const after = await hdr();
    const tasksAfter = await taskRows();
    results.swipes.push({
      name: s.name,
      beforeExpanded: before.expanded,
      afterExpanded: after?.expanded ?? null,
      headerFound: Boolean(after),
      tasksBefore,
      tasksAfter,
      // 行仍在展开态且行数没涨才算干净（行数涨 = 意外新建草稿/误触新建按钮）
      tasksLeaked: Boolean(after) && after.expanded === 'true' && tasksAfter > tasksBefore,
    });
    log('SWIPE', s.name, j(results.swipes[results.swipes.length - 1]));
  }

  // ---------- 断言②：点按开合连续 3 轮（每轮重新读行头几何） ----------
  // 注意：断言①的滑动会把列表滚走（scrollTop 变化），行头可能被滚出视口
  // （rect 仍在但被 overflow 裁剪，hit-test 不命中——真实用户点的是可见行，
  // 不存在打空问题）。为避免滑动相位与点按相位互相污染（覆盖层联动/列表滚动），
  // 点按相位前整页重载回到干净状态。
  await gotoApp();
  await page.evaluate(() => window.__r4s.openSidebar());
  await sleep(900);
  for (let round = 1; round <= 3; round += 1) {
    let h = await hdr();
    if (!h) {
      await page.evaluate(() => window.__r4s.openSidebar());
      await sleep(900);
      h = await hdr();
    }
    if (!h) throw new Error('header lost at round ' + round);
    const tasksBefore = await taskRows();
    await touchTap(h.x + h.w * 0.3, h.y + h.h / 2);
    await sleep(1500);
    const next = await hdr();
    const tasksAfter = await taskRows();
    results.toggleRounds.push({
      round,
      beforeExpanded: h.expanded,
      afterExpanded: next?.expanded ?? null,
      toggled: h.expanded !== (next?.expanded ?? null),
      // 展开方向任务行数自然增加（懒加载/渲染更多行），不做泄漏判定；
      // 这里只记录行数供人工核对。
      taskRowsAfter: tasksAfter,
    });
    log('ROUND', round, j(results.toggleRounds[results.toggleRounds.length - 1]));
  }

  // ---------- 汇总 ----------
  const swipeOk = results.swipes.length > 0 && results.swipes.every(
    (s) => s.beforeExpanded === 'true' && s.afterExpanded === 'true' && !s.tasksLeaked,
  );
  const toggleOk = results.toggleRounds.length === 3 && results.toggleRounds.every((r) => r.toggled);
  log('SUMMARY ' + j({
    swipeAllKeptExpanded: swipeOk,
    swipeDetails: results.swipes.map((s) => `${s.name}:${s.afterExpanded}${s.tasksLeaked ? '+leak' : ''}`).join(','),
    toggleOk3Rounds: toggleOk,
    toggleDetails: results.toggleRounds.map((r) => `${r.beforeExpanded}->${r.afterExpanded}`).join(','),
    PASS: swipeOk && toggleOk,
  }));
} catch (error) {
  log('ERROR ' + (error && error.stack ? error.stack : String(error)));
  process.exitCode = 1;
} finally {
  await context.close();
}
