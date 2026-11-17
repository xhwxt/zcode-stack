/**
 * ZCode 直连页 / 官方远控页 共用的页面探针（随 ZCode web dist 发布）。
 *
 * 历史教训：这三段逻辑（SW 注册 / 刷新+崩溃遥测 / dsh-mobile App 兼容标记）
 * 曾寄存在 zusage 状态栏旁挂服务的注入脚本（/zusage/boot.js）里 —— 那是
 * 「不重新编译就能改」的偷懒选择，代价是 ZCode 连接线与无关插件耦合：
 * 状态栏一停用，SW 与诊断全灭，改补丁线的人也找不到这里。
 * 现归位本文件：由 nginx sub_filter 与状态栏脚本并列注入，两条产品线互不依赖。
 *
 * 三段职责（全部幂等、失败静默）：
 *  1. Service Worker（秒开恢复层）：后台页被浏览器回收后的重载无法阻止，
 *     SW 让那次重载从本机缓存瞬间完成。scope=/，直连页与远控页共用。
 *  2. 刷新 + 崩溃遥测（favicon 信标，nginx 日志可查）：
 *     - type=reload/navigate + 会话内计数（区分代码刷新 / 用户刷新 / 浏览器丢弃重载）
 *     - crash=1 遗嘱（beforeunload 清除；crash 来不及清 → 下次加载发现即上一次崩溃）
 *  3. dsh-mobile App 兼容标记：App 的 WebView 恢复策略 probe
 *     document.querySelector('.dshm-shell')，不存在即整页 reload。
 *     挂一个隐藏标记让 probe 返回 true。仅影响 App 挂载判定，无样式/行为副作用。
 */
(function () {
  'use strict';
  if (window.__zcodeBootProbe) return;
  window.__zcodeBootProbe = true;

  /* ---------- 崩溃检测遗嘱 ---------- */
  try {
    var hadCrashWill = sessionStorage.getItem('zcode-crash-will') === '1';
    sessionStorage.setItem('zcode-crash-will', '1');
    window.addEventListener('beforeunload', function () {
      try { sessionStorage.removeItem('zcode-crash-will'); } catch (e) {}
    });
    if (hadCrashWill) {
      var crashImg = new Image();
      crashImg.src = '/favicon.svg?crash=1&ts=' + Date.now() + '&page=' + encodeURIComponent(location.pathname);
    }
  } catch (e) {}

  /* ---------- 刷新遥测 ---------- */
  try {
    var navEntry = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
    var navType = navEntry ? (navEntry.type || 'unknown') : 'unknown';
    // document.wasDiscarded=true = 浏览器把后台页面丢弃后重载（Chrome 内存管理，
    // 非任何代码调用 reload）。区分「代码刷新」与「浏览器丢弃重载」的决定性证据。
    var discarded = document.wasDiscarded === true;
    if (discarded) navType += '+discarded';

    var cnt = 0;
    try {
      cnt = parseInt(sessionStorage.getItem('zcode-pv-cnt') || '0', 10) || 0;
      cnt += 1;
      sessionStorage.setItem('zcode-pv-cnt', String(cnt));
    } catch (e) {}
    var pvImg = new Image();
    pvImg.src = '/favicon.svg?pv=' + Date.now() + '&type=' + navType + '&cnt=' + cnt
      + '&page=' + encodeURIComponent(location.pathname);
  } catch (e) {}

  /* ---------- dsh-mobile App 兼容标记 ---------- */
  try {
    if (!document.querySelector('.dshm-shell')) {
      var shellMark = document.createElement('div');
      shellMark.className = 'dshm-shell';
      shellMark.style.cssText = 'display:none!important;width:0;height:0;overflow:hidden;';
      shellMark.setAttribute('aria-hidden', 'true');
      (document.body || document.documentElement).appendChild(shellMark);
    }
  } catch (e) {}

  /* ---------- 标签页标题收敛为「zcode」----------
   * bundle 会在启动后把 document.title 改成 "ZCode - Web" / "ZCode - Sign In" 等
   * （assets/index-*.js，content-hash 文件名，不可直接改）。在这里钉住最终值：
   * 立即改一次 + MutationObserver 跟踪后续改写，一律收敛为 zcode。
   * 幂等（title 本来就是 zcode 时零开销），失败静默。 */
  try {
    var WANTED_TITLE = 'Zcode';
    var lockTitle = function () {
      if (document.title !== WANTED_TITLE) document.title = WANTED_TITLE;
    };
    lockTitle();
    var titleEl = document.head && document.head.querySelector('title');
    if (titleEl) {
      new MutationObserver(lockTitle).observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  } catch (e) {}

  /* ---------- Service Worker 注册 ----------
   * 每次导航浏览器都会字节比对 sw.js 检查更新（server 对 /sw.js 返回 no-cache）。
   * 版本参数 = 构建时注入的 CACHE_VERSION 同值（vite.config.ts 的
   * zcode:sw-cache-version 插件），SW 字节换版时注册 URL 同步换版。 */
  if ('serviceWorker' in navigator) {
    try {
      navigator.serviceWorker.register('/sw.js?v=__SW_CACHE_VERSION__', { scope: '/' })
        .catch(function () {});
    } catch (e) {}
  }
})();
