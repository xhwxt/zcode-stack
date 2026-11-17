/*
 * 发布门禁：候选前端构建的"加载即无 React 报错"检查（无头 + 真实 origin）。
 *
 * 为什么需要它：hook 数不一致、渲染期抛错这类问题**类型检查与 lint 都抓不到**，只有真跑才暴露；
 * 而我们是"SW cache-first + 真 origin"，直接打开线上页面只会跑**旧**构建，所以这里用
 * context.route 把同源静态资源换成本地候选目录（等于在真机上提前跑新 UI，不部署、不改生产）。
 *
 * 用法：
 *   GATE_ORIGIN=<站点 origin> GATE_DIST=<候选构建目录> GATE_PROFILE=<profile 副本> \
 *   GATE_PW_CORE=/path/to/playwright-core/index.mjs \
 *   GATE_CHROME=<chromium 可执行文件> node r15-console-gate.mjs
 * 省略 GATE_DIST 时跑线上构建作为基线（用于判定报错是否为本批引入）。
 *
 * 坑（都实测过）：SW 是 cache-first，必须先注销 SW + 清 Cache Storage，否则回放旧 bundle；
 * 必须 `--disable-http-cache`；profile 必须是副本（Chromium ProcessSingleton 锁）；
 * App 的 RPC/WS 在 Worker 里，静态资源拦截**必须用 context.route**（page.route 看不到）。
 */
import { readFileSync, existsSync, statSync, rmSync, cpSync } from 'node:fs';
import { join, extname } from 'node:path';

const ORIGIN = process.env.GATE_ORIGIN;
const DIST = process.env.GATE_DIST ?? null;
const PROFILE_SRC = process.env.GATE_PROFILE_SRC ?? '/tmp/profile-src';
const PROFILE = process.env.GATE_PROFILE ?? '/tmp/console-gate-profile';
const WAIT_MS = Number(process.env.GATE_WAIT_MS ?? 12000);
if (!ORIGIN) {
  console.error('需要 GATE_ORIGIN（站点 origin），不内置默认值以避免泄漏内部主机名');
  process.exit(2);
}
if (!existsSync(PROFILE_SRC)) {
  console.error(`profile 源不存在: ${PROFILE_SRC}`);
  process.exit(2);
}
rmSync(PROFILE, { recursive: true, force: true });
cpSync(PROFILE_SRC, PROFILE, { recursive: true });

const { chromium } = await import(process.env.GATE_PW_CORE ?? 'playwright-core');
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.txt': 'text/plain', '.map': 'application/json', '.pdf': 'application/pdf',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  executablePath: process.env.GATE_CHROME ?? undefined,
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  locale: 'zh-CN',
  serviceWorkers: 'block',
  args: ['--no-sandbox', '--lang=zh-CN', '--disable-http-cache', '--disk-cache-size=1'],
});
const page = context.pages()[0] ?? (await context.newPage());

const consoleErrors = [];
const pageErrors = [];
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  consoleErrors.push(msg.text().slice(0, 400));
});
page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 400)));

let servedStatic = 0;
if (DIST) {
  await context.route('**/*', async (route) => {
    const req = route.request();
    let url;
    try {
      url = new URL(req.url());
    } catch {
      return route.fallback();
    }
    if (url.origin !== ORIGIN || req.method() !== 'GET') return route.fallback();
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/zusage/')) {
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
}

await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  for (const reg of regs) await reg.unregister();
  const keys = await caches.keys();
  for (const key of keys) await caches.delete(key);
});
await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(WAIT_MS);

const loaded = await page.evaluate(() => ({
  hasRoot: Boolean(document.querySelector('#root')?.childElementCount),
  timelineRows: document.querySelectorAll('[data-row-id]').length,
  title: document.title,
}));

// 归类：hook 数不一致 / 渲染抛错 / 其它
const classify = (text) =>
  /hook|Rendered more hooks|change in the order of Hooks/i.test(text)
    ? 'hook-count'
    : /Minified React error|Cannot read|undefined is not/i.test(text)
      ? 'render-error'
      : 'other';
const report = {
  mode: DIST ? 'candidate' : 'baseline(live)',
  origin: ORIGIN,
  dist: DIST,
  servedStatic,
  loaded,
  errors: consoleErrors.map((text) => ({ kind: classify(text), text })),
  pageErrors: pageErrors.map((text) => ({ kind: classify(text), text })),
};
console.log(JSON.stringify(report, null, 2));
const fatal = report.errors.filter((e) => e.kind !== 'other').length + report.pageErrors.length;
console.log(fatal === 0 ? 'GATE: PASS（无 hook/render 类报错）' : `GATE: FAIL（${fatal} 条致命报错）`);
await context.close();
