// E2E: 原地恢复（无重挂）验证
// 场景: 页面 hidden 期间服务端真杀 socket（terminate，非优雅 close）→ 回 visible
//   → 守卫判死 → 软重连 → 原地恢复。
// 判定「未整树重挂」：在 body 挂一个不可删除的标记元素（重挂不删 body 子节点，
// 但 connectionEpoch 方案会重挂 Root——Root 卸载不会清 body 外部节点，所以改用
// 「全局自增计数 + React root 内标记节点」双证据）。
// 更硬的证据：window.__zcodeConnProbe 存活性 + 页面内一个挂在 documentElement 上的
// 属性计数。最直接：比较 Root 渲染前后 document.querySelector('#root') 内首个
// zcode 容器节点引用是否同一对象——重挂会创建新 DOM 节点。
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

if (!process.env.ZCODE_TOKEN) { console.error('usage: ZCODE_TOKEN=<token> [ZCODE_ORIGIN=<origin>] node ' + import.meta.url.split('/').pop()); process.exit(1); }
const TOK = process.env.ZCODE_TOKEN;
const ORIGIN = process.env.ZCODE_ORIGIN ?? 'http://127.0.0.1:3030';
const EXE = process.env.CHROME_PATH ?? undefined;
const mode = process.argv[2] ?? 'kill-hidden';

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--lang=zh-CN', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, locale: 'zh-CN' });
const page = await ctx.newPage();
let liveServerWs = null;
let killCount = 0;

await page.routeWebSocket(/\/ws(\?|$)/, ws => {
  const server = ws.connectToServer();
  liveServerWs = server;
  ws.onMessage(m => server.send(m));
  server.onMessage(m => ws.send(m));
  ws.onClose(() => { liveServerWs = null; });
  server.onClose(() => { liveServerWs = null; });
});

await page.goto(`${ORIGIN}/?token=${TOK}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
await page.waitForTimeout(12000);
const ready = await page.evaluate(() => !!document.querySelector('[data-testid="v4-composer-input"]'));
console.log('  就绪: 输入框=' + ready);
if (!ready) { console.log('  ✗ 未就绪'); await browser.close(); process.exit(1); }

// 打开一个会话视图并制造 DOM 标记：给 composer 的父级容器挂自定义属性（重挂后丢失）
await page.evaluate(() => {
  const composer = document.querySelector('[data-testid="v4-composer-input"]');
  let el = composer;
  while (el && el.parentElement) {
    if (el.id === 'root' || !el.parentElement.parentElement) break;
    el = el.parentElement;
  }
  // composer 到 #root 路径上最深的稳定容器打标（重挂 = 新节点 = 标记消失）
  el.setAttribute('data-e2e-epoch', 'first-mount');
  window.__firstComposerNode = document.querySelector('[data-testid="v4-composer-input"]')?.parentElement ?? null;
});

if (mode === 'kill-hidden') {
  console.log('\n  ▶ 切 hidden → 服务端 terminate socket（真断线）→ 回 visible…');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1500);
  if (liveServerWs) { liveServerWs.close({ code: 1006, wasClean: false, reason: '' }); killCount += 1; }
  else console.log('  (无活 socket 可杀——可能已被判死)');
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
} else {
  console.log('\n  ▶ visible 态直接服务端杀 socket（非 hidden 场景回归）…');
  if (liveServerWs) { liveServerWs.close({ code: 1006, wasClean: false, reason: '' }); killCount += 1; }
}

// 等待软重连完成（新 WS 建立 + 输入框回归）
let reconnected = false;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2000);
  const c = await page.evaluate(() => !!document.querySelector('[data-testid="v4-composer-input"]'));
  if (c && killCount > 0) {
    // 给原地恢复/重挂一点时间显形
    await page.waitForTimeout(3000);
    reconnected = true;
    break;
  }
}
const result = await page.evaluate(() => {
  const composer = document.querySelector('[data-testid="v4-composer-input"]');
  const currentParent = composer?.parentElement ?? null;
  const sameNode = window.__firstComposerNode && currentParent &&
    (window.__firstComposerNode === currentParent ||
     window.__firstComposerNode.querySelector('[data-testid="v4-composer-input"]') === composer) ||
    (composer?.closest('[data-e2e-epoch="first-mount"]') != null);
  return {
    sameDomNode: Boolean(sameNode),
    epochMark: composer?.closest('[data-e2e-epoch]')?.getAttribute('data-e2e-epoch') ?? null,
    banner: document.getElementById('zcode-web-conn-banner')?.textContent ?? null,
    composer: Boolean(composer),
  };
});
console.log(`\n  === 结果（杀 socket ${killCount} 次）===`);
console.log('  重连完成:', reconnected);
console.log('  DOM 节点同一（未重挂）:', result.sameDomNode, '| epoch 标记:', result.epochMark);
console.log('  输入框:', result.composer, '| 横幅:', result.banner ?? '无');
const verdict = reconnected && result.composer;
if (mode === 'kill-hidden') {
  console.log('  判定:', verdict ? (result.sameDomNode ? '✓ 原地恢复（无重挂）' : '△ 恢复成功但发生了重挂') : '✗ 未恢复');
} else {
  console.log('  判定:', verdict ? '✓ 恢复成功' : '✗ 未恢复');
}
await browser.close();
