// E2E: 半开连接判死验证
// 场景 A（黑洞）: 拦下页面的 /ws，之后把双向转发掐断但不发 close —— 模拟半开。
//   旧代码: 永远不会恢复（页面无感死亡）。
//   新代码: 客户端心跳监视器 15s 探针 / 30s 无帧判死 → 主动 close → 软重连。
//   判定: 45s 内出现第 2 条 WS 连接，且页面未被整页 reload。
// 场景 B（健康不误判）: 正常连接 50s，确认无重连、无 reload、无横幅。
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

if (!process.env.ZCODE_TOKEN) { console.error('usage: ZCODE_TOKEN=<token> [ZCODE_ORIGIN=<origin>] node ' + import.meta.url.split('/').pop()); process.exit(1); }
const TOK = process.env.ZCODE_TOKEN;
const ORIGIN = process.env.ZCODE_ORIGIN ?? 'http://127.0.0.1:3030';
const EXE = process.env.CHROME_PATH ?? undefined;
const mode = process.argv[2] ?? 'blackhole';

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--lang=zh-CN', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const events = [];
let sockCount = 0;
let live = null;
let blackholed = false;

await page.routeWebSocket(/\/ws(\?|$)/, ws => {
  sockCount += 1;
  const id = sockCount;
  events.push(`#${id} open`);
  const server = ws.connectToServer();
  live = { id, ws, server };
  if (mode === 'blackhole' && sockCount === 1) {
    // 第一条连接：先正常握手（让页面完成 bootstrap），等标记后再掐断转发。
    ws.onMessage(m => { if (!blackholed) server.send(m); });
    server.onMessage(m => { if (!blackholed) ws.send(m); });
  } else {
    ws.onMessage(m => server.send(m));
    server.onMessage(m => ws.send(m));
  }
  ws.onClose(() => { events.push(`#${id} client-closed`); server.close(); });
  server.onClose(() => { events.push(`#${id} server-closed`); ws.close(); });
});

await page.goto(`${ORIGIN}/?token=${TOK}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
await page.waitForTimeout(12000);
await page.evaluate(() => { window.__mark = 'ALIVE'; });

const before = await page.evaluate(() => ({
  mark: window.__mark,
  hasComposer: !!document.querySelector('[data-testid="v4-composer-input"]'),
}));
console.log('  就绪:', JSON.stringify(before), '| WS 连接数:', sockCount);
if (!before.hasComposer) { console.log('  ✗ 页面未就绪（无输入框），中止'); await browser.close(); process.exit(1); }

if (mode === 'blackhole') {
  console.log('\n  ▶ 掐断双向转发（不发 close）—— 模拟半开连接…');
  blackholed = true;
  // 同时清空 page 级缓冲？不需要：routeWebSocket 层直接丢弃即可。
  for (const t of [10000, 10000, 10000, 10000]) {
    await page.waitForTimeout(t);
    const s = await page.evaluate(() => ({
      mark: window.__mark,
      hasComposer: !!document.querySelector('[data-testid="v4-composer-input"]'),
      banner: document.getElementById('zcode-web-conn-banner')?.textContent ?? null,
    }));
    console.log(`  +${t / 1000}s: 标记=${s.mark} 输入框=${s.hasComposer} 横幅=${s.banner ? s.banner.slice(0, 30) : '无'}`);
  }
} else {
  console.log('\n  ▶ 健康连接保持 50s，验证不误判…');
  for (const t of [10000, 10000, 10000, 10000, 10000]) {
    await page.waitForTimeout(t);
    const s = await page.evaluate(() => ({
      mark: window.__mark,
      hasComposer: !!document.querySelector('[data-testid="v4-composer-input"]'),
      banner: document.getElementById('zcode-web-conn-banner')?.textContent ?? null,
    }));
    console.log(`  +${t / 1000}s: 标记=${s.mark} 输入框=${s.hasComposer} 横幅=${s.banner ? '有' : '无'}`);
  }
}

console.log('\n  === 事件 ===');
events.forEach(e => console.log('   ', e));
console.log('  === 判定 ===');
const alive = await page.evaluate(() => window.__mark);
if (mode === 'blackhole') {
  console.log('  ', sockCount > 1 ? `✓ 半开被判定，页面发起了重连（共 ${sockCount} 次建连）` : '✗ 没有重连（半开未被判死）');
  console.log('  ', alive === 'ALIVE' ? '✓ 页面未被整页重载（软重连）' : '✗ 页面被整页重载');
} else {
  console.log('  ', sockCount === 1 ? '✓ 健康连接无重连（不误判）' : `✗ 出现了 ${sockCount} 次建连（误判重连）`);
  console.log('  ', alive === 'ALIVE' ? '✓ 页面未被重载' : '✗ 页面被重载');
}
await browser.close();
