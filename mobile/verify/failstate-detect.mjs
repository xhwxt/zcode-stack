import pw from '<工作区>/ZCode/node_modules/playwright-core/index.js';
const { chromium } = pw;
import fs from 'fs';
const token = fs.readFileSync('<数据目录>/.zcode-token','utf8').trim();
const browser = await chromium.launch({executablePath:'<Chromium 可执行文件路径>', args:['--no-sandbox','--lang=zh-CN']});
const ctx = await browser.newContext({viewport:{width:390,height:844}, isMobile:true, hasTouch:true});
const page = await ctx.newPage();

// 只让 WebSocket 失败，HTTP 正常（精确复现"页面能渲染但连不上服务端"）
await page.addInitScript(() => {
  class FailingWebSocket extends EventTarget {
    constructor(url) {
      super(); this.url = url; this.readyState = 0;
      setTimeout(() => {
        this.readyState = 3;
        this.dispatchEvent(new Event('error'));
        this.dispatchEvent(new CloseEvent('close', { code: 1006, wasClean: false }));
      }, 20);
    }
    send() {}
    close() {}
  }
  window.WebSocket = FailingWebSocket;
});

const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0,160)}`));
await page.goto('https://zcode.example.com/?token='+token, {waitUntil:'domcontentloaded', timeout:60000});
await page.waitForTimeout(9000);

const state = await page.evaluate(() => {
  const h1s = [...document.querySelectorAll('h1')].map(e => (e.textContent||'').trim());
  const body = (document.body?.innerText || '').slice(0, 300);
  return { h1s, body, hasFailedH1: h1s.some(t => /启动失败|bootstrap failed/i.test(t)) };
});
console.log('=== 检测信号 ===');
console.log('h1 列表:', JSON.stringify(state.h1s));
console.log('hasFailedH1:', state.hasFailedH1);
console.log('页面可见文本前 300 字:', JSON.stringify(state.body.slice(0,300)));
console.log('=== console（去重前 12）===');
console.log([...new Set(logs)].slice(0,12).join('\n'));
await browser.close();
