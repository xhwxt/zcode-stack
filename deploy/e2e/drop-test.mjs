import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
if (!process.env.ZCODE_TOKEN) { console.error('usage: ZCODE_TOKEN=<token> [ZCODE_ORIGIN=<origin>] node ' + import.meta.url.split('/').pop()); process.exit(1); }
const TOK = process.env.ZCODE_TOKEN;
const ORIGIN = process.env.ZCODE_ORIGIN ?? 'http://127.0.0.1:3030';
const EXE = process.env.CHROME_PATH ?? undefined;
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--lang=zh-CN','--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const events = [];
let sockCount = 0, live = null;
await page.routeWebSocket(/\/ws(\?|$)/, ws => {
  sockCount += 1; const id = sockCount;
  events.push(`#${id} open`);
  const server = ws.connectToServer();
  live = { id, ws, server };
  ws.onMessage(m => server.send(m));
  server.onMessage(m => ws.send(m));
  ws.onClose(() => { events.push(`#${id} client-closed`); server.close(); });
  server.onClose(() => { events.push(`#${id} server-closed`); ws.close(); });
});
await page.goto(`${ORIGIN}/?token=${TOK}`, { waitUntil:'domcontentloaded', timeout: 40000 });
await page.waitForTimeout(12000);
await page.evaluate(() => { window.__mark = 'ALIVE'; });
const before = await page.evaluate(() => ({ mark: window.__mark, hasComposer: !!document.querySelector('[data-testid="v4-composer-input"]'),
  text: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,60) }));
console.log('  就绪:', JSON.stringify(before), '| WS 连接数:', sockCount);

console.log('\n  ▶ 强制掐断服务端侧 WS（模拟后台冻结/换网）…');
live.server.close(); live.ws.close();
await page.waitForTimeout(1500);
let s = await page.evaluate(() => ({ mark: window.__mark, text: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,80) }));
console.log('  1.5s 后: 标记 =', s.mark, '| 文案:', s.text);

for (const t of [3000, 5000, 8000]) {
  await page.waitForTimeout(t);
  s = await page.evaluate(() => ({ mark: window.__mark, hasComposer: !!document.querySelector('[data-testid="v4-composer-input"]'),
    text: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,80) }));
  console.log(`  +${t}ms: 标记=${s.mark} 输入框=${s.hasComposer} 文案: ${s.text}`);
}
console.log('\n  === 事件 ===');
events.forEach(e => console.log('   ', e));
console.log('  === 判定 ===');
console.log('  ', sockCount > 1 ? `✓ 页面自己重连了（共 ${sockCount} 次建连）` : '✗ 没有重连');
console.log('  ', (await page.evaluate(() => window.__mark)) === 'ALIVE' ? '✓ 页面未被整页重载' : '✗ 页面被整页重载');
await browser.close();
