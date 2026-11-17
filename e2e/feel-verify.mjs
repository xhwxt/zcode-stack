// E2E: 体感优化验证（心跳存活 + 热换底软重连）
// 场景 A（黑洞）: 半开（双向转发掐断不发 close）→ 判死仍需工作（二次探针后杀）→ 软重连
// 场景 B（健康+hidden 切换）: 健康连接切 hidden 60s 再回来 → 不误杀、不重连（此前误杀主因）
// 场景 C（横幅惰性）: 黑洞恢复过程首试成功时横幅从不出现
import { chromium } from 'playwright-core';

if (!process.env.ZCODE_TOKEN) { console.error('usage: ZCODE_TOKEN=<token> [ZCODE_ORIGIN=<origin>] node ' + import.meta.url.split('/').pop()); process.exit(1); }
const TOK = process.env.ZCODE_TOKEN;
const ORIGIN = process.env.ZCODE_ORIGIN ?? 'http://127.0.0.1:3030';
const EXE = process.env.CHROME_PATH ?? undefined;
const mode = process.argv[2] ?? 'blackhole';

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--lang=zh-CN', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const events = [];

let blackholed = false;

let routeCount = 0;
await page.routeWebSocket(/\/ws(\?|$)/, ws => {
  routeCount += 1;
  const id = routeCount;
  events.push(`#${id} open`);
  const server = ws.connectToServer();
  if (mode === 'blackhole') {
    ws.onMessage(m => { if (!blackholed) server.send(m); });
    server.onMessage(m => { if (!blackholed) ws.send(m); });
  } else {
    ws.onMessage(m => server.send(m));
    server.onMessage(m => ws.send(m));
  }
  ws.onClose(() => events.push(`#${id} client-closed`));
  server.onClose(() => events.push(`#${id} server-closed`));
});

await page.goto(`${ORIGIN}/?token=${TOK}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
await page.waitForTimeout(12000);
await page.evaluate(() => { window.__mark = 'ALIVE'; });
const ready = await page.evaluate(() => !!document.querySelector('[data-testid="v4-composer-input"]'));
console.log(`  就绪: 输入框=${ready} | socks=${routeCount}`);
if (!ready) { console.log('  ✗ 未就绪，中止'); await browser.close(); process.exit(1); }

if (mode === 'blackhole') {
  console.log('\n  ▶ 掐断双向转发（半开），等待判死+软重连…');
  blackholed = true;
  const t0 = Date.now();
  let reconnected = false;
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(2500);
    if (routeCount > 1) { reconnected = true; break; }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const mark = await page.evaluate(() => window.__mark);
  const bannerSeen = await page.evaluate(() => !!document.getElementById('zcode-web-conn-banner'));
  console.log(`  判死+重连耗时: ${dt}s | socks=${routeCount} | 页面未重载=${mark === 'ALIVE'}`);
  console.log(`  横幅可见=${bannerSeen}`);
  console.log('  判定:', reconnected && mark === 'ALIVE' ? '✓ 半开判死 + 软重连（未整页刷新）' : '✗ 失败');
} else {
  console.log('\n  ▶ 健康连接切 hidden 60s → 回 visible，验证不误杀…');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(60000);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(8000);
  const mark = await page.evaluate(() => window.__mark);
  const composer = await page.evaluate(() => !!document.querySelector('[data-testid="v4-composer-input"]'));
  const banner = await page.evaluate(() => document.getElementById('zcode-web-conn-banner')?.textContent ?? null);
  console.log(`  socks=${routeCount} | 输入框=${composer} | 横幅=${banner ?? '无'}`);
  console.log('  判定:', routeCount === 1 && composer && mark === 'ALIVE' ? '✓ 短切回零重连（无感）' : routeCount > 1 ? `✗ 误杀重连（${routeCount} 次）` : '✗ 页面异常');
}

console.log('\n  === 事件 ===');
events.forEach(e => console.log('   ', e));
await browser.close();
