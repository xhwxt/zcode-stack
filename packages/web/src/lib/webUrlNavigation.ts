/* web 端"打开 URL"的同源导航收口。
 *
 * 问题：web 端此前把所有"打开链接"意图统一走 window.open(url, "_blank")——
 * 包括指向本站同源路径的链接（/usage、/web-remote、/api/me/preview/file/...）。
 * 在手机 APK WebView 壳里，_blank 会走 onCreateWindow 的 harvester 捕获：
 * 同源目标虽会转回主 WebView 加载，但该通道依赖 isUserGesture 判定，实测
 * 用户的 /usage、/web-remote 点击被壳弹外链确认框拦下（进不去）。
 *
 * 修法：同源 URL（与当前页面同 origin 的 http/https，或相对路径）改为
 * 当前 WebView 直接 location.assign 导航——壳的 shouldOverrideUrlLoading 对
 * 同源主帧导航恒放行（MainActivity.kt routeMainFrameTarget: same-origin
 * return false），浏览器里则是普通站内跳转，两端行为一致且不经过任何
 * 新窗口通道。仅跨源 http/https 才继续 window.open（外链语义不变：
 * 壳照旧弹确认框）。
 */

/** 判定 URL 是否与当前页面同源：相对路径视为同源；绝对 URL 需 http/https 且 origin 相同。 */
export function isSameOriginWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * web 端打开 URL 的统一入口：同源走当前页导航，跨源走 window.open 新标签。
 * 返回 true 表示已处理（调用方无需再退回 window.open）。
 */
export function openWebUrlWithSameOriginNavigation(url: string): boolean {
  if (isSameOriginWebUrl(url)) {
    window.location.assign(url);
    return true;
  }
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
