import pw from '<工作区>/ZCode/node_modules/playwright-core/index.js';
const { chromium } = pw;
import fs from 'fs';
const token = fs.readFileSync('<数据目录>/.zcode-token','utf8').trim();
const browser = await chromium.launch({executablePath:'<Chromium 可执行文件路径>', args:['--no-sandbox','--lang=zh-CN']});

// 1) 先在线加载一次，让 Service Worker 缓存页面
const warm = await browser.newContext({viewport:{width:390,height:844}, isMobile:true, hasTouch:true});
const wp = await warm.newPage();
await wp.goto('https://zcode.example.com/?token='+token, {waitUntil:'domcontentloaded', timeout:60000});
await wp.waitForTimeout(15000);
console.log('warm load title:', await wp.title());
await warm.close();

// 2) 断网后重新加载同一页面（模拟用户：断网进入）
const ctx = await browser.newContext({viewport:{width:390,height:844}, isMobile:true, hasTouch:true});
const page = await ctx.newPage();
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0,200)}`));
page.on('pageerror', e => logs.push(`[pageerror] ${String(e).slice(0,200)}`));
await page.goto('https://zcode.example.com/?token='+token, {waitUntil:'domcontentloaded', timeout:60000});
await page.waitForTimeout(3000);
await ctx.setOffline(true);
await page.reload({waitUntil:'domcontentloaded'}).catch(e => logs.push('[reload-fail] '+String(e).slice(0,120)));
await page.waitForTimeout(12000);

const dom = await page.evaluate(() => {
  const txt = document.body ? document.body.innerText.slice(0, 600) : '(no body)';
  const markers = [...document.querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid')).slice(0, 40);
  return { txt, markers };
});
console.log('=== DOM 文本（断网后）===');
console.log(dom.txt);
console.log('=== console 信号（去重后前 25 条）===');
console.log([...new Set(logs)].slice(0, 25).join('\n'));
await browser.close();
