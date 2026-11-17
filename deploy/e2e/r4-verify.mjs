/*
 * 候选修复的预览验证台（read-only 为主；sidebar/quote 场景会操作用户界面但不发送消息）。
 *
 * 原理：用已配对的持久化浏览器 profile 打开**真实 origin**（Cookie/后端/WS 全是真的），
 * 但把同源静态资源（HTML/JS/CSS）用 page.route 换成待验证的新构建目录 —— 等于在真机上
 * 提前跑新 UI，不需要部署、不需要重启任何服务。
 *
 * 关键经验（踩过的坑）：
 *  - serviceWorkers: 'block' 之外还必须**注销 SW + 清 Cache Storage**：SW 是 cache-first，
 *    不清理的话第二次导航仍回放旧 bundle，路由拦截看不到静态请求（servedStatic=0）。
 *  - 必须禁 HTTP 缓存（--disable-http-cache / --disk-cache-size=1），否则同样回放旧包。
 *  - App 的 RPC/实时通道跑在 **Web Worker** 里：page.route 看不到，必须用 context.route。
 *  - 侧栏在 390px 是覆盖层；evaluate 触发的 click 不是可信手势，应用不会自动收起，
 *    必须显式收起，否则后续点击全被侧栏吃掉。
 *  - 锚点必须在**高度稳定后**记录，否则把"测高推偏"误判成坏帧。
 *
 * 用法：
 *   R4_DIST=<构建目录> R4_PROFILE=<profile 副本> [R4_TOUCH=1] [R4_VIEWPORT=1280x800] \
 *     R4_PW_CORE=/path/to/playwright-core/index.mjs \
 *     R4_CHROME=/path/to/chrome \
 *     node r4-verify.mjs <scenario>
 *   scenario: smoke | scroll | sidebar | quote | banner | offline | drop | rpc
 *   profile 副本：rsync -a --delete /tmp/profile-src/ /tmp/profile-<name>/
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = await import(process.env.R4_PW_CORE ?? 'playwright-core');

const DIST = process.env.R4_DIST;
const ORIGIN = process.env.R4_ORIGIN ?? 'https://<部署域名>';
const PROFILE = process.env.R4_PROFILE ?? '/path/to/profile';
const SCENARIO = process.argv[2] ?? 'smoke';

if (!DIST || !existsSync(DIST)) {
  console.error('usage: R4_DIST=<dist dir> R4_PROFILE=<profile> node r4-verify.mjs <scenario>');
  process.exit(2);
}

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.txt': 'text/plain', '.map': 'application/json', '.pdf': 'application/pdf',
};

const viewport = (() => {
  const raw = process.env.R4_VIEWPORT;
  if (!raw) return { width: 390, height: 844 };
  const [w, h] = raw.split('x').map(Number);
  return Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : { width: 390, height: 844 };
})();

const log = (...args) => console.log(...args);
const j = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  executablePath: process.env.R4_CHROME ?? undefined,
  viewport,
  // R4_TOUCH=1：让 matchMedia("(hover: none)") 为真，验证只在触屏生效的分支。
  ...(process.env.R4_TOUCH === '1' ? { hasTouch: true, isMobile: true } : {}),
  locale: 'zh-CN',
  serviceWorkers: 'block',
  args: ['--no-sandbox', '--lang=zh-CN', '--disable-http-cache', '--disk-cache-size=1'],
});
const page = context.pages()[0] ?? (await context.newPage());

let servedStatic = 0;
let servedNetwork = 0;
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
    servedNetwork += 1;
    return route.fallback();
  }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = join(DIST, rel);
  if (!existsSync(file) || !statSync(file).isFile()) {
    servedNetwork += 1;
    return route.fallback();
  }
  servedStatic += 1;
  return route.fulfill({
    status: 200,
    contentType: MIME[extname(file)] ?? 'application/octet-stream',
    body: readFileSync(file),
  });
});

const HELPERS = () => {
  window.__r4 = {
    scroller() {
      const r = document.querySelector('[data-row-id]');
      let p = r ? r.parentElement : null;
      while (p && p !== document.body) {
        if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
        p = p.parentElement;
      }
      return null;
    },
    snap() {
      const s = window.__r4.scroller();
      if (!s) return null;
      const sr = s.getBoundingClientRect();
      const rows = Array.from(document.querySelectorAll('[data-row-id]'))
        .map((e) => ({ id: Number(e.getAttribute('data-row-id')), r: e.getBoundingClientRect() }))
        .filter((x) => x.r.bottom > sr.top && x.r.top < sr.bottom)
        .sort((a, b) => a.r.top - b.r.top);
      return {
        top: Math.round(s.scrollTop),
        h: Math.round(s.scrollHeight),
        max: Math.round(s.scrollHeight - s.clientHeight),
        firstRow: rows.length ? rows[0].id : null,
        lastRow: rows.length ? rows[rows.length - 1].id : null,
      };
    },
    draftVisible() {
      return Boolean(document.querySelector('[data-testid="chat-empty"]'));
    },
    openSidebar() {
      const b = document.querySelector('button[aria-label="切换侧边栏"]');
      if (b) b.click();
      return Boolean(b);
    },
    sidebarOpen() {
      const sb = document.querySelector('#sidebar');
      if (!sb) return null;
      return Math.round(sb.getBoundingClientRect().x) === 0;
    },
    closeSidebarIfOpen() {
      const sb = document.querySelector('#sidebar');
      if (sb && Math.round(sb.getBoundingClientRect().x) === 0) {
        document.querySelector('button[aria-label="切换侧边栏"]')?.click();
        return true;
      }
      return false;
    },
    clickTask(sid) {
      const el = document.querySelector(`[data-testid="task-item-${sid}"]`);
      if (!el) return false;
      el.click();
      return true;
    },
    composerText() {
      const c = document.querySelector('[data-testid="v4-composer-input"]');
      return c ? (c.innerText || '').slice(0, 120) : null;
    },
    bannerText() {
      const els = Array.from(document.querySelectorAll('div,span,p')).filter((e) =>
        /连接正在恢复|重连中/.test(e.textContent || ''),
      );
      return els.length ? els[els.length - 1].textContent.trim().slice(0, 60) : null;
    },
  };
};

async function gotoApp() {
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  // SW 是 cache-first 的秒开层：不注销它第二次导航仍回放旧 bundle（servedStatic 会是 0）。
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) await reg.unregister();
    const keys = await caches.keys();
    for (const key of keys) await caches.delete(key);
  });
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await page.evaluate(HELPERS);
}

/** 等时间线真正挂载（冷订阅可能数秒；固定 sleep 在高负载下会误判为失败）。 */
async function waitForTimeline(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await page.evaluate(() => Boolean(window.__r4 && window.__r4.scroller()));
    if (ready) return true;
    await sleep(500);
  }
  return false;
}

/**
 * 打开会话：目标不一定立刻在侧栏列表里（分组视图 + 懒加载），重试并在列表内滚动查找；
 * 打开后显式收起侧栏（覆盖层会吃掉后续点击）。
 */
async function openSession(sid) {
  let ok = false;
  for (let attempt = 0; attempt < 5 && !ok; attempt += 1) {
    await page.evaluate(() => window.__r4.openSidebar());
    await sleep(700 + attempt * 400);
    ok = await page.evaluate(async (target) => {
      const sleepLocal = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 12; i += 1) {
        const el = document.querySelector(`[data-testid="task-item-${target}"]`);
        if (el) {
          el.click();
          return true;
        }
        const sidebar = document.querySelector('#sidebar');
        const scroller = sidebar
          ? Array.from(sidebar.querySelectorAll('*')).find(
              (n) => n.scrollHeight > n.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(n).overflowY),
            )
          : null;
        if (scroller) {
          scroller.scrollTop += Math.round(scroller.clientHeight * 0.8);
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
        await sleepLocal(500);
      }
      return false;
    }, sid);
  }
  await sleep(1500);
  await page.evaluate(() => window.__r4.closeSidebarIfOpen());
  await sleep(500);
  return ok;
}

/**
 * 打开会话并确认时间线挂载；高负载下冷订阅可能开不出来——重载页面重试（最多 3 轮）。
 * 返回 true 表示时间线已就绪。
 */
async function openSessionReady(sid) {
  for (let round = 0; round < 3; round += 1) {
    if (round > 0) await gotoApp();
    const opened = await openSession(sid);
    if (!opened) continue;
    if (await waitForTimeline(20000)) return true;
  }
  return false;
}

/** 页面内切换会话 + 按帧采样（evaluate 往返会错过坏帧，必须在页面内连续采）。 */
function inPageSwitchAndTrace(sid, totalMs) {
  return page.evaluate(
    async ({ sid: target, totalMs: budget }) => {
      const frames = [];
      const t0 = performance.now();
      const item = document.querySelector(`[data-testid="task-item-${target}"]`);
      const clicked = Boolean(item);
      if (item) item.click();
      await new Promise((resolve) => {
        const tick = () => {
          frames.push({ ms: Math.round(performance.now() - t0), ...window.__r4.snap() });
          if (performance.now() - t0 < budget) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      return { clicked, frames };
    },
    { sid, totalMs },
  );
}

/** 等到滚动容器高度静止（测高/补拉收敛），再记锚点。 */
async function waitStableHeight() {
  await page.evaluate(async () => {
    const sleepLocal = (ms) => new Promise((r) => setTimeout(r, ms));
    let last = -1;
    let stableFor = 0;
    for (let i = 0; i < 40; i += 1) {
      const s = window.__r4.scroller();
      if (!s) {
        await sleepLocal(250);
        continue;
      }
      const h = s.scrollHeight;
      if (h === last) stableFor += 250;
      else stableFor = 0;
      last = h;
      if (stableFor >= 1000) return;
      await sleepLocal(250);
    }
  });
}

const scenarios = {
  async smoke() {
    await gotoApp();
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      rows: document.querySelectorAll('[data-row-id]').length,
      composer: Boolean(document.querySelector('[data-testid="v4-composer-input"]')),
      greeting: /上午好|下午好|晚上好/.test(document.body.innerText || ''),
      bundle: Array.from(document.querySelectorAll('script[src]'))
        .map((s) => s.getAttribute('src'))
        .filter((s) => s && s.includes('/assets/')),
    }));
    return { scenario: 'smoke', info, servedStatic, servedNetwork };
  },

  /** 切会话滚动落点：锚点(高度稳定后) → 切走 → 切回，量首帧是否落在锚点行。 */
  async scroll() {
    const MAIN = process.env.R4_MAIN ?? 'sess_<主会话 id>';
    const OTHER = process.env.R4_OTHER ?? 'sess_<会话 id>';
    await gotoApp();
    if (!(await openSessionReady(MAIN))) {
      return { scenario: 'scroll', error: 'session-not-ready', MAIN, servedStatic };
    }
    await sleep(3000);
    const opened = await page.evaluate(() => window.__r4.snap());
    await page.evaluate(async () => {
      const sleepLocal = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 20; i += 1) {
        const s = window.__r4.scroller();
        if (s) {
          s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * 0.5);
          s.dispatchEvent(new Event('scroll', { bubbles: true }));
          return;
        }
        await sleepLocal(500);
      }
    });
    await waitStableHeight();
    const anchor = await page.evaluate(() => window.__r4.snap());
    await page.evaluate(() => window.__r4.openSidebar());
    await sleep(900);
    await inPageSwitchAndTrace(OTHER, 2500);
    await sleep(2000);
    const otherSettled = await page.evaluate(() => window.__r4.snap());
    await page.evaluate(() => window.__r4.openSidebar());
    await sleep(900);
    const back = await inPageSwitchAndTrace(MAIN, 2500);
    const frames = back.frames.filter((f) => f && f.firstRow !== null);
    const anchorRow = anchor ? anchor.firstRow : null;
    const offBy = (row) => (anchorRow === null || row === null ? null : Math.abs(row - anchorRow));
    const firstFrames = frames.slice(0, 6).map((f) => ({ ms: f.ms, top: f.top, h: f.h, firstRow: f.firstRow, off: offBy(f.firstRow) }));
    const badFrames = frames.filter((f) => (offBy(f.firstRow) ?? 0) > 20);
    const settleAt = frames.findIndex((f) => (offBy(f.firstRow) ?? 99) <= 20);
    return {
      scenario: 'scroll',
      opened,
      anchor,
      anchorRow,
      otherSettled,
      backClicked: back.clicked,
      frames: frames.length,
      firstFrames,
      badFrames: badFrames.length,
      badFramesMaxOffsetRows: badFrames.length ? Math.max(...badFrames.map((f) => offBy(f.firstRow) ?? 0)) : 0,
      firstGoodFrameIndex: settleAt,
      firstGoodFrameMs: settleAt >= 0 ? frames[settleAt].ms : null,
    };
  },

  /** 侧栏折叠：点行头是否被当成"新建对话"（草稿态出现即失败）。 */
  async sidebar() {
    const PROJECT = process.env.R4_PROJECT ?? '<工作区>';
    await gotoApp();
    await page.evaluate(() => window.__r4.openSidebar());
    await sleep(1200);
    const read = (project) => ({
      draft: window.__r4.draftVisible(),
      tasks: document.querySelectorAll('[data-testid^="task-item-"]').length,
      headerExpanded: document.querySelector(`[data-testid="workspace-item-${project}"]`)?.getAttribute('aria-expanded') ?? null,
    });
    const before = await page.evaluate(read, PROJECT);
    const box = await page.locator(`[data-testid="workspace-item-${PROJECT}"]`).boundingBox().catch(() => null);
    let clickNote = 'header-not-found';
    if (box) {
      await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
      clickNote = `clicked@${Math.round(box.x + box.width * 0.3)},${Math.round(box.y + box.height / 2)}`;
    }
    await sleep(2500);
    const after = await page.evaluate(read, PROJECT);
    return { scenario: 'sidebar', before, after, clickNote };
  },

  /** 引用原文可达性（R4_TOUCH=1 时走触屏分支：点击开浮层）。 */
  async quote() {
    await gotoApp();
    await openSession(process.env.R4_QUOTE_SESSION ?? 'sess_<会话 id>');
    await waitForTimeline();
    await sleep(3000);
    const found = await page.evaluate(async () => {
      const sleepLocal = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 14; i += 1) {
        if (document.querySelector('[data-conversation-selection-reference-count]')) return true;
        const s = window.__r4.scroller();
        if (!s) return false;
        s.scrollTop = Math.max(0, s.scrollTop - Math.round(s.clientHeight * 0.9));
        s.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleepLocal(700);
      }
      return Boolean(document.querySelector('[data-conversation-selection-reference-count]'));
    });
    if (!found) return { scenario: 'quote', prepared: { pill: false }, opened: null };
    const prepared = await page.evaluate(async () => {
      const sleepLocal = (ms) => new Promise((r) => setTimeout(r, ms));
      const pill = document.querySelector('[data-conversation-selection-reference-count]');
      const scroller = window.__r4.scroller();
      const row = pill.closest('[data-row-id]') ?? pill;
      if (scroller) {
        const offset = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        scroller.scrollTop = Math.max(0, offset - 160);
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
      await sleepLocal(900);
      const rect = pill.getBoundingClientRect();
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const top = document.elementFromPoint(cx, cy);
      return {
        pill: true,
        hoverNone: window.matchMedia('(hover: none)').matches,
        rect: { x: Math.round(cx), y: Math.round(cy), w: Math.round(rect.width), inViewport: rect.top > 0 && rect.bottom < innerHeight },
        topEl: top ? { tag: top.tagName, slot: top.getAttribute('data-slot'), insidePill: pill.contains(top) } : null,
      };
    });
    await page.mouse.click(prepared.rect.x, prepared.rect.y);
    await sleep(900);
    const opened = await page.evaluate(() => {
      const pop = document.querySelector('[data-slot="popover-content"]');
      const card = document.querySelector('[data-slot="hover-card-content"]');
      const node = pop ?? card;
      const pill = document.querySelector('[data-conversation-selection-reference-count]');
      return {
        kind: pop ? 'popover' : card ? 'hover-card' : null,
        text: node ? node.innerText.slice(0, 400) : null,
        textLen: node ? node.innerText.length : 0,
        clamped: node
          ? (() => {
              const el = node.querySelector('[class*="line-clamp-3"]');
              return el ? getComputedStyle(el).webkitLineClamp : null;
            })()
          : null,
        pillSlot: pill ? pill.getAttribute('data-slot') : null,
        ariaExpanded: pill ? pill.getAttribute('aria-expanded') : null,
      };
    });
    return { scenario: 'quote', prepared, opened };
  },

  /** 断网（CDP offline）观察横幅：链路静默失败不一定触发客户端重连。 */
  async offline() {
    const MAIN = process.env.R4_MAIN ?? 'sess_<主会话 id>';
    await gotoApp();
    await openSession(MAIN);
    await sleep(5000);
    const before = await page.evaluate(() => ({ snap: window.__r4.snap(), banner: window.__r4.bannerText() }));
    const timeline = [];
    const sampleOnce = async (round, phase) => {
      const state = await page.evaluate(() => ({ banner: window.__r4.bannerText(), snap: window.__r4.snap() }));
      timeline.push({ round, phase, banner: state.banner, top: state.snap ? state.snap.top : null, firstRow: state.snap ? state.snap.firstRow : null });
    };
    for (let round = 1; round <= Number(process.env.R4_OFFLINE_ROUNDS ?? 3); round += 1) {
      await context.setOffline(true);
      for (let i = 0; i < 30; i += 1) {
        await sampleOnce(round, 'offline');
        await sleep(300);
      }
      await context.setOffline(false);
      for (let i = 0; i < 50; i += 1) {
        await sampleOnce(round, 'online');
        await sleep(300);
      }
    }
    let segments = 0;
    let prev = false;
    for (const t of timeline) {
      const on = t.banner !== null;
      if (on && !prev) segments += 1;
      prev = on;
    }
    const last = timeline[timeline.length - 1];
    return {
      scenario: 'offline',
      bannerSegments: segments,
      samplesWithBanner: timeline.filter((t) => t.banner !== null).length,
      scrollMovedPx: before.snap && last ? Math.abs((last.top ?? 0) - before.snap.top) : null,
      transitions: timeline.filter((t, i) => i === 0 || t.banner !== timeline[i - 1].banner || t.top !== timeline[i - 1].top),
    };
  },

  /** 组合断线（close + 离线 + 恢复）×N 轮：最接近真机"切网/后台被冻结"。 */
  async drop() {
    const MAIN = process.env.R4_MAIN ?? 'sess_<主会话 id>';
    const CYCLES = Number(process.env.R4_DROP_CYCLES ?? 3);
    const OFFLINE_MS = Number(process.env.R4_DROP_OFFLINE_MS ?? 6000);
    const RECOVER_MS = Number(process.env.R4_DROP_RECOVER_MS ?? 16000);
    let sockCount = 0;
    const socks = [];
    await page.routeWebSocket(/\/ws(\/|\?|$)/, (ws) => {
      sockCount += 1;
      const server = ws.connectToServer();
      socks.push({ ws, server });
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(m));
      ws.onClose(() => server.close());
      server.onClose(() => ws.close());
    });
    await gotoApp();
    await openSession(MAIN);
    await sleep(5000);
    const before = await page.evaluate(() => ({ snap: window.__r4.snap(), banner: window.__r4.bannerText() }));
    const timeline = [];
    const sampleOnce = async (cycle, phase) => {
      const state = await page.evaluate(() => ({ banner: window.__r4.bannerText(), snap: window.__r4.snap() }));
      timeline.push({ cycle, phase, socketCount: sockCount, banner: state.banner, top: state.snap ? state.snap.top : null, firstRow: state.snap ? state.snap.firstRow : null });
    };
    for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
      const live = socks[socks.length - 1];
      if (live) {
        live.server.close();
        live.ws.close();
      }
      await context.setOffline(true);
      for (let i = 0; i < Math.ceil(OFFLINE_MS / 400); i += 1) {
        await sampleOnce(cycle, 'offline');
        await sleep(400);
      }
      await context.setOffline(false);
      for (let i = 0; i < Math.ceil(RECOVER_MS / 400); i += 1) {
        await sampleOnce(cycle, 'recovering');
        await sleep(400);
      }
    }
    const segmentsByCycle = {};
    let prev = false;
    for (const t of timeline) {
      const on = t.banner !== null;
      if (on && !prev) segmentsByCycle[t.cycle] = (segmentsByCycle[t.cycle] ?? 0) + 1;
      prev = on;
    }
    const last = timeline[timeline.length - 1];
    return {
      scenario: 'drop',
      cycles: CYCLES,
      sockets: sockCount,
      bannerSegments: Object.values(segmentsByCycle).reduce((a, b) => a + b, 0),
      segmentsByCycle,
      samplesWithBanner: timeline.filter((t) => t.banner !== null).length,
      scrollMovedPx: before.snap && last ? Math.abs((last.top ?? 0) - before.snap.top) : null,
      rowMoved:
        before.snap && last && before.snap.firstRow !== null && last.firstRow !== null
          ? Math.abs(last.firstRow - before.snap.firstRow)
          : null,
      before,
    };
  },

  /** RPC 下行记账：按方法统计次数与字节（必须 context.route —— 传输在 Worker 里）。 */
  async rpc() {
    const sid = process.env.R4_RPC_SESSION ?? 'sess_<会话 id>';
    const seconds = Number(process.env.R4_RPC_SECONDS ?? 60);
    const byMethod = new Map();
    const record = (method, wire, plain) => {
      const cur = byMethod.get(method) ?? { count: 0, wire: 0, plain: 0 };
      cur.count += 1;
      cur.wire += wire;
      cur.plain += plain;
      byMethod.set(method, cur);
    };
    await context.route('**/api/rpc**', async (route) => {
      const req = route.request();
      let method = 'unknown';
      try {
        const parsed = JSON.parse(req.postData() ?? '');
        method = String(parsed?.method ?? parsed?.m ?? parsed?.call ?? 'unknown');
      } catch {}
      try {
        const response = await route.fetch();
        const headers = response.headers();
        const wire = Number(headers['content-length'] ?? 0);
        const buf = await response.body();
        record(method, wire, buf ? buf.length : 0);
        await route.fulfill({ response });
      } catch {
        record(method + ':error', 0, 0);
        await route.fallback();
      }
    });
    await gotoApp();
    await openSession(sid);
    await sleep(Math.max(5000, seconds * 1000));
    const rows = [...byMethod.entries()].map(([method, v]) => ({ method, ...v })).sort((a, b) => b.plain - a.plain);
    const totalPlain = rows.reduce((sum, r) => sum + r.plain, 0);
    const totalWire = rows.reduce((sum, r) => sum + r.wire, 0);
    return {
      scenario: 'rpc',
      seconds,
      totalPlainMB: +(totalPlain / 1048576).toFixed(2),
      totalWireMB: +(totalWire / 1048576).toFixed(2),
      plainKBps: Math.round(totalPlain / seconds / 1024),
      wireKBps: Math.round(totalWire / seconds / 1024),
      top: rows.slice(0, 12).map((r) => ({
        method: r.method,
        count: r.count,
        perCallKB: r.count ? Math.round(r.plain / r.count / 1024) : 0,
        totalMB: +(r.plain / 1048576).toFixed(2),
      })),
    };
  },
};

const run = scenarios[SCENARIO] ?? scenarios.smoke;
try {
  const result = await run();
  log('RESULT ' + j(result));
} catch (error) {
  log('ERROR ' + (error && error.stack ? error.stack : String(error)));
  process.exitCode = 1;
} finally {
  await context.close();
}
