import pw from '<工作区>/ZCode/node_modules/playwright-core/index.js';
const { chromium } = pw;
import fs from 'fs';
const token = fs.readFileSync('<数据目录>/.zcode-token','utf8').trim();
const browser = await chromium.launch({executablePath:'<Chromium 可执行文件路径>', args:['--no-sandbox','--lang=zh-CN']});
for (const mode of ['zai-dark','zai-light','system']) {
  for (const scheme of ['dark','light']) {
    const ctx = await browser.newContext({viewport:{width:390,height:844}, isMobile:true, hasTouch:true, colorScheme: scheme});
    const page = await ctx.newPage();
    await page.goto('https://zcode.example.com/?token='+token, {waitUntil:'domcontentloaded', timeout:60000});
    await page.waitForTimeout(6000);
    // force the theme preference the way the app stores it, then reload
    await page.evaluate((m) => localStorage.setItem('zcode-theme', m), mode);
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForTimeout(8000);
    const info = await page.evaluate(() => ({
      cls: document.documentElement.className,
      bg: getComputedStyle(document.documentElement).backgroundColor,
      stored: localStorage.getItem('zcode-theme'),
    }));
    console.log(`mode=${mode} os=${scheme} => class="${info.cls}" bg=${info.bg} stored=${info.stored}`);
    await ctx.close();
  }
}
await browser.close();
