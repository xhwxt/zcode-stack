import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
if (!process.env.ZCODE_TOKEN) { console.error('usage: ZCODE_TOKEN=<token> [ZCODE_ORIGIN=<origin>] node ' + import.meta.url.split('/').pop()); process.exit(1); }
const TOK = process.env.ZCODE_TOKEN;
const ORIGIN = process.env.ZCODE_ORIGIN ?? 'http://127.0.0.1:3030';
const EXE = process.env.CHROME_PATH ?? undefined;
const b = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 393, height: 852 } });
const page = await ctx.newPage();
// 在最早的时刻记录：应用第一次 new WebSocket 时，boot.js 的标记是否已存在
await page.addInitScript(() => {
  window.__order = [];
  const N = window.WebSocket;
  function W(u, p) {
    window.__order.push({ ev: 'app-new-WebSocket', bootReady: !!window.__zusageBoot, at: Math.round(performance.now()) });
    return p === undefined ? new N(u) : new N(u, p);
  }
  W.prototype = N.prototype; ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k => W[k] = N[k]);
  window.WebSocket = W;
});
await page.goto(`${ORIGIN}/?token=${TOK}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
await page.waitForTimeout(10000);
const r = await page.evaluate(() => ({ order: window.__order, bootReadyNow: !!window.__zusageBoot,
  bootFlag: window.__zusageBoot ? Object.keys(window.__zusageBoot).join(',') : null }));
console.log('  应用建 WS 的时刻记录:');
r.order.forEach(o => console.log('   ', JSON.stringify(o)));
console.log('  boot.js 最终标记:', r.bootReadyNow, r.bootFlag);
const ok = r.order.length > 0 && r.order[0].bootReady;
console.log('\n  判定:', ok ? '✓ boot.js 先于应用建连执行 —— 可以安全替换 window.WebSocket'
                            : '✗ boot.js 晚于应用建连 —— 替换方案不成立');
await b.close();
