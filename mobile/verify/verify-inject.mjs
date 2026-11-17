import pw from '<工作区>/ZCode/node_modules/playwright-core/index.js';
const { chromium } = pw;
import fs from 'fs';

// Extract PAGE_SIDE_JS from the Kotlin source verbatim (no hand-copying).
const kt = fs.readFileSync('<仓库根>/mobile/android/app/src/main/kotlin/io/github/xhwxt/zcodemobile/ThemeChannel.kt', 'utf8');
const block = kt.split('const val PAGE_SIDE_JS =')[1].split('})();"')[0] + '})();"';
const parts = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
const js = parts.join('')
  .replace(/\\"/g, '"')
  .replace(/"\s*\+\s*CONSOLE_PREFIX\s*\+\s*"/g, '__zcode_shell__:');
// The Kotlin uses string concatenation with CONSOLE_PREFIX; after joining, the
// prefix appears literally in the source as: console.log('" + CONSOLE_PREFIX + "'+m)
const finalJs = js.replace(/CONSOLE_PREFIX/g, '__zcode_shell__:');
console.log('extracted JS length:', finalJs.length);

const token = fs.readFileSync('<数据目录>/.zcode-token','utf8').trim();
const browser = await chromium.launch({executablePath:'<Chromium 可执行文件路径>', args:['--no-sandbox','--lang=zh-CN']});
const ctx = await browser.newContext({viewport:{width:390,height:844}, isMobile:true, hasTouch:true, deviceScaleFactor:3, userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36'});
const page = await ctx.newPage();
await page.goto('https://zcode.example.com/?token='+token, {waitUntil:'domcontentloaded', timeout:60000});
await page.waitForTimeout(12000);

// syntax check + stub the native object, then inject exactly our script
const result = await page.evaluate((code) => {
  const captured = [];
  window.zcodeShell = { postMessage: (m) => captured.push(m) };
  try { new Function(code); } catch (e) { return { syntaxError: String(e) }; }
  try { new Function(code)(); } catch (e) { return { runtimeError: String(e) }; }
  window.__captured = captured;
  return { ok: true, initial: captured.slice() };
}, finalJs);

if (result.syntaxError || result.runtimeError) { console.log('FAIL', result); await browser.close(); process.exit(1); }
console.log('initial messages:', JSON.stringify(result.initial));

// Now simulate a long press on the LEFT PANEL CONTROL (the real button).
const press = await page.evaluate(async () => {
  const btns = [...document.querySelectorAll('button')].filter(b => /lucide-panel-left-(open|close)/.test((b.querySelector('svg')||{}).getAttribute?.('class')||''));
  if (btns.length !== 1) return { error: 'expected exactly 1 panel control, got ' + btns.length };
  const b = btns[0];
  const r = b.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, pointerId: 1, pointerType: 'touch', isPrimary: true };
  b.dispatchEvent(new PointerEvent('pointerdown', opts));
  await new Promise(r2 => setTimeout(r2, 700));
  b.dispatchEvent(new PointerEvent('pointerup', opts));
  return { before: window.__captured.slice() };
});
console.log('after long-press:', JSON.stringify(press));

// Negative control: a long press on a non-control area must NOT open devices
const neg = await page.evaluate(async () => {
  window.__captured.length = 0;
  const el = document.elementFromPoint(195, 500);
  const opts = { bubbles: true, cancelable: true, clientX: 195, clientY: 500, pointerId: 2, pointerType: 'touch', isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  await new Promise(r2 => setTimeout(r2, 700));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  return { messages: window.__captured.slice() };
});
console.log('after long-press elsewhere:', JSON.stringify(neg));

// Short tap on the control must NOT open devices
const tap = await page.evaluate(async () => {
  window.__captured.length = 0;
  const b = [...document.querySelectorAll('button')].filter(x => /lucide-panel-left-(open|close)/.test((x.querySelector('svg')||{}).getAttribute?.('class')||''))[0];
  const r = b.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, pointerId: 3, pointerType: 'touch', isPrimary: true };
  b.dispatchEvent(new PointerEvent('pointerdown', opts));
  await new Promise(r2 => setTimeout(r2, 120));
  b.dispatchEvent(new PointerEvent('pointerup', opts));
  await new Promise(r2 => setTimeout(r2, 600));
  return { messages: window.__captured.slice() };
});
console.log('after short tap on control:', JSON.stringify(tap));

await browser.close();
