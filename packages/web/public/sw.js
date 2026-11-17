/**
 * ZCode Web Service Worker —— 页面被浏览器回收后的秒开恢复层。
 *
 * 背景（切后台回来不得出现刷新）：安卓浏览器在内存紧张时会整个回收
 * 后台页面，切回时浏览器重新加载页面——这次加载无法阻止。能做的是让它**瞬间完成、
 * 零网络等待**：导航 HTML 与静态资源全部 cache-first 从本机回放（毫秒级），
 * 更新在后台异步拉取，只影响下一次打开。
 *
 * 策略（cache-first 优先于一切）：
 * - 同源 GET 一律先查缓存：命中立即返回（哪怕可能过期）；
 *   未命中才走网络并写入缓存。更新由后台 refresh 异步完成。
 * - 运行时请求（/ws、/api/*、/zusage/snapshot）绝不缓存——它们是实时数据。
 * - 导航 HTML 同样 cache-first：用户切回前台的瞬间不等待任何网络。
 *   陈旧 HTML 引用的旧 bundle 若已在缓存中，同样从缓存回放，整链路零网络。
 * - 后台 refresh：每次导航后异步 revalidate 当前 HTML 与其资源，供下次使用；
 *   失败静默（离线时旧缓存就是最好的答案）。
 */
'use strict';

// v3：v2 全量 cache-first 有个自我锁死漏洞——部署新构建后若 sw.js 字节不变
// （CACHE_VERSION 不变），浏览器的 update check 判定"无更新"，activate 永远
// 不触发，cache-first 让手机永远回放旧 HTML/旧 bundle（实测：刷新无效）。
// v3 借版本字符串字节变化触发 reinstall → activate 清掉 v2 缓存，下次导航
// 拿到新 HTML/新 bundle。
// v10：CACHE_VERSION 改为构建时注入（vite.config.ts 的 zcode:sw-cache-version
// 插件，值 = 构建时刻 UTC 戳，每次构建必变）——人工递增会忘（刷新无效事故的根因）。
// 同一值注入 zcode-boot-probe.js 的注册参数，保持注册 URL 与 SW 字节同步换版。
// v8：zcode-boot-probe.js 移入 network-first 白名单（v7 及以前 cache-first 会锁死旧 probe）。
// v9：导航从 cache-first 改为 network-first——配对登录 302 时代理旧壳会造成
// "旧壳+启动失败"死锁（旧壳永远占位、302 永不缓存）；同时 v8 激活后缓存的旧壳
// 也需要一次整体失效。副作用：导航改为等网络，秒开变成快开（局域网内百毫秒级）。
const CACHE_VERSION = '__SW_CACHE_VERSION__';
const NEVER_CACHE_RE = /^\/(ws\b|api\/|zusage\/snapshot)/;
const REFRESHED_SESSION = 'zcode-sw-refreshed';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(['/']).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE_RE.test(url.pathname)) return;

  // 无内容哈希的注入脚本（boot.js/overlay.js/boot-probe）：内容随部署变化，必须 network-first
  // + cache 兜底。cache-first 会把它们锁死在旧版本，服务器端的所有修复都无法到达。
  // zcode-boot-probe.js 后补入：server 对静态资源发 immutable 头，若走
  // cache-first，标题收敛等 probe 侧改动永远到不了已缓存设备。
  if (
    url.pathname === '/zusage/boot.js' ||
    url.pathname === '/zusage/overlay.js' ||
    url.pathname === '/zcode-boot-probe.js'
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_VERSION);
        try {
          const response = await fetch(request, { cache: 'no-store' });
          if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
          return response;
        } catch {
          const hit = await cache.match(request);
          return hit || Response.error();
        }
      })(),
    );
    return;
  }

  if (request.mode === 'navigate') {
    // 配对登录联动（设备凭据 + 短期会话模型）：服务器判定"无有效设备会话"时
    // 对入口 HTML 回 302 → 配对页。若照常回放缓存里的旧壳，旧壳会带着过期会话
    // 调 API 弹"启动失败"，且 302 不是 ok 响应、revalidate 不更新存档 → 旧壳
    // 永远占位（手机上实际出现的死锁）。所以导航请求必须**放行到网络**：
    // 无有效会话的浏览器由服务器 302 进配对页；已有会话的正常回 HTML。
    // 缓存只存成功的完整页面。
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request, { cache: 'no-store' });
          if (response && response.ok) {
            const cache = await caches.open(CACHE_VERSION);
            cache.put(request, response.clone()).catch(() => {});
          }
          return response;
        } catch {
          const cache = await caches.open(CACHE_VERSION);
          const hit = await cache.match(request, { ignoreVary: true });
          return hit || Response.error();
        }
      })(),
    );
    return;
  }
  event.respondWith(cacheFirst(request));
});
