package io.github.xhwxt.zcodemobile

import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.WebMessageCompat

/**
 * One-way signalling from the live ZCode page to the shell.
 *
 * Two delivery paths, both one-way (the page can never call native APIs):
 *  1. console messages prefixed [CONSOLE_PREFIX] — always delivered through
 *     [android.webkit.WebChromeClient.onConsoleMessage]; no feature detection,
 *     no origin configuration, cannot silently no-op. This is the primary path.
 *  2. androidx.webkit WebMessageListener (the dsh-mobile pattern) on the app's
 *     own origin, kept as a second path where supported.
 *
 * Page-side messages:
 *   "theme:dark:rgb(22, 22, 22)"  — live page background + light/dark
 *   "devices"                     — open the device list
 *   "task-started" / "task-finished" — task counters for the keep-alive row
 *                                    (incremental: send exactly once each;
 *                                    helpers on window.zcodeShellTaskEvents)
 */
object ThemeChannel {

    /** Console-message prefix the shell listens for. */
    const val CONSOLE_PREFIX = "__zcode_shell__:"

    /** Name registered from the page side for the WebMessage path. */
    const val JS_OBJECT_NAME = "zcodeShell"

    fun isSupported(): Boolean =
        WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

    /** Installs the WebMessage path; call once per WebView instance. */
    fun install(
        view: WebView,
        allowedOrigin: String,
        onMessage: (String) -> Unit,
    ) {
        if (!isSupported()) return
        runCatching {
            WebViewCompat.addWebMessageListener(
                view,
                JS_OBJECT_NAME,
                setOf(allowedOrigin),
            ) { _, message: WebMessageCompat, sourceOrigin, isMainFrame, _ ->
                // The allowlist above already restricts which frames get the
                // object; checking again keeps a sub-frame of an allowed origin
                // from driving the shell.
                if (!isMainFrame) return@addWebMessageListener
                if (sourceOrigin?.toString()?.trimEnd('/') != allowedOrigin) {
                    return@addWebMessageListener
                }
                val text = message.data ?: return@addWebMessageListener
                onMessage(text)
            }
        }
    }

    /**
     * Page-side shim for the Web Notifications API plus the focus quirk.
     *
     * The page already asks for a notification when a task finishes while it is
     * unfocused (`packages/web/src/main.tsx` → `new window.Notification(...)`),
     * but Android WebView does not implement that API, so `window.Notification`
     * is undefined there and the page returns silently. Defining it here routes
     * the payload to the shell, which posts a real Android notification.
     *
     * Self-contained (its own `post`) because it is installed at document start,
     * before the shell's other hooks exist; the console channel always works.
     * An already-granted real implementation is left untouched; one that reports
     * `default`/`denied` is taken over, which is the WebView case.
     */
    const val NOTIFICATION_SHIM_JS =
        "(function(){if(window.__zcodeNotifyShim)return;window.__zcodeNotifyShim=true;" +
            // The page only notifies while it believes it is unfocused. WebView
            // can keep answering hasFocus()===true for a backgrounded document,
            // and a hidden document claiming focus is wrong anyway; dsh-mobile's
            // own page-side notifier gates on document.hidden/visibilitychange
            // for the same reason (dsh-mobile/src/task-notify.ts:382,414).
            "try{var hf=Document.prototype.hasFocus;" +
            "Document.prototype.hasFocus=function(){try{if(document.hidden)return false}catch(e){}" +
            "return hf.call(this)}}catch(e){}" +
            // A real, already-granted implementation wins (desktop-class engine).
            // A WebView reports Notification as missing — or, on engines that
            // expose the API without a notification presenter, as permanently
            // 'denied' — so those cases must be taken over, otherwise the page
            // gives up before the shell ever hears about the task.
            "var native=window.Notification;" +
            "try{if(typeof native==='function'&&native.permission==='granted')return}catch(e){}" +
            "function post(m){try{if(window.zcodeShell&&zcodeShell.postMessage){zcodeShell.postMessage(m);return}}catch(e){}" +
            "try{console.log('" + CONSOLE_PREFIX + "'+m)}catch(_){}}" +
            // Capped here as well as in the shell: if the channel ever truncates
            // a long message, the JSON must still parse (a broken payload would
            // drop the notification silently instead of shortening the text).
            "function clip(v,n){v=String(v==null?'':v);return v.length>n?v.slice(0,n):v}" +
            "function Shim(title,options){try{post('notify:'+JSON.stringify({" +
            "title:clip(title,200),body:clip(options&&options.body,500)}))}catch(e){}}" +
            "Shim.permission='granted';" +
            "Shim.requestPermission=function(cb){try{if(cb)cb('granted')}catch(e){}" +
            "try{return Promise.resolve('granted')}catch(e){return null}};" +
            "try{window.Notification=Shim}catch(e){}" +
            "})();"

    /**
     * Installs [NOTIFICATION_SHIM_JS] before any page script runs, so the page's
     * bundle always sees a Web Notifications API. Falls back to the
     * [PAGE_SIDE_JS] injection on WebView versions without document-start
     * scripting.
     */
    fun installNotificationShim(view: WebView, allowedOrigin: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        runCatching {
            WebViewCompat.addDocumentStartJavaScript(view, NOTIFICATION_SHIM_JS, setOf(allowedOrigin))
        }
    }

    /**
     * Page-side half, injected on every finished load.
     *
     * Contents: the notification shim above, live-theme reporting, the page's
     * connection-failure state, the long-press target for the device list, and
     * (for the page bundle to call directly) the task-accounting messages
     * "task-started" / "task-finished" — see window.zcodeShellTaskEvents below.
     *
     * Long-press target is the left-panel control: the top-left overlay button
     * whose icon is lucide-panel-left-open / lucide-panel-left-close. Verified
     * against the live page (390x844 mobile emulation): exactly one such button
     * exists. The earlier attempt targeted aside[data-testid="sidebar"] — the
     * drawer *content*, which is off-screen with pointer-events:none while the
     * drawer is closed, so it could never receive a long press.
     */
    const val PAGE_SIDE_JS =
        "(function(){" +
            "if(window.__zcodeShellHooks)return;window.__zcodeShellHooks=true;" +
            NOTIFICATION_SHIM_JS +
            // Exactly-once transport: task-started/finished are *incremental*
            // counters, so the shell must hear each event once. Try the
            // WebMessage object first; only when it is missing (or throws) fall
            // back to the console channel — never both, or the count drifts.
            "function post(m){var sent=false;" +
            "try{if(window.zcodeShell&&zcodeShell.postMessage){zcodeShell.postMessage(m);sent=true}}catch(e){}" +
            "if(!sent){try{console.log('" + CONSOLE_PREFIX + "'+m)}catch(e){}}}" +
            // Page-facing helpers (no-ops outside this shell): call these on
            // confirmed task state changes, exactly once per transition.
            "window.zcodeShellTaskEvents={started:function(){post('task-started')}," +
            "finished:function(){post('task-finished')}};" +
            // --- live page theme (authoritative: computed, not the OS theme) ---
            "function report(){var bg='';try{bg=getComputedStyle(document.documentElement).backgroundColor||''}catch(e){}" +
            "var dark=true;try{var c=document.documentElement.className;dark=c.indexOf('zai-dark')>=0||c.indexOf('dark')>=0}catch(e){}" +
            "post('theme:'+(dark?'dark':'light')+':'+bg)}" +
            // --- page connection-failure state ---
            // ZCode's own bootstrap failure screen is a <h1> reading
            // "Web 启动失败" / "Web bootstrap failed"; when it is on screen the
            // page cannot reach its server, so the shell must offer its native
            // retry / back-to-device-list screen instead of leaving the user on
            // the page's dead end.
            "function failed(){try{var hs=document.getElementsByTagName('h1');" +
            "for(var i=0;i<hs.length;i++){var t=hs[i].textContent||'';" +
            "if(/\u542f\u52a8\u5931\u8d25|bootstrap failed/i.test(t))return true}}catch(e){}return false}" +
            "var lastFail=null;" +
            "function tick(){report();var f=failed();if(f!==lastFail){lastFail=f;post('state:'+(f?'failed':'ok'))}}" +
            "window.__zcodeShellTick=tick;" +
            // --- long-press the left panel control ---
            "function toggleButton(el){while(el&&el.tagName){if(el.tagName==='BUTTON'){" +
            "var s=el.querySelector('svg');var c=s?(s.getAttribute('class')||''):'';" +
            "return /lucide-panel-left-(open|close)/.test(c)?el:null;}el=el.parentElement;}return null;}" +
            "var t=null;" +
            "function clr(){if(t){clearTimeout(t);t=null;}}" +
            "function down(e){var b=toggleButton(e.target);if(!b)return;clr();" +
            "t=setTimeout(function(){t=null;post('devices')},500);}" +
            "function move(e){if(!t)return;if(!toggleButton(document.elementFromPoint(e.clientX,e.clientY)))clr();}" +
            "document.addEventListener('pointerdown',down,{passive:true,capture:true});" +
            "document.addEventListener('pointerup',clr,{passive:true,capture:true});" +
            "document.addEventListener('pointercancel',clr,{passive:true,capture:true});" +
            "document.addEventListener('pointermove',move,{passive:true,capture:true});" +
            "try{(new MutationObserver(tick)).observe(document.documentElement," +
            "{attributes:true,attributeFilter:['class','style'],childList:true,subtree:true})}catch(e){}" +
            "tick();" +
            "try{setInterval(tick,2000)}catch(e){}" +
            "})();"
}
