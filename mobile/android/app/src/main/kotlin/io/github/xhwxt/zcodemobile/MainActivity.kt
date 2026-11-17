package io.github.xhwxt.zcodemobile

import android.annotation.SuppressLint
import android.app.Dialog
import android.app.DownloadManager
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.os.Build
import android.webkit.CookieManager
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import java.io.File
import java.net.URI

/**
 * The only Activity. Owns the shell screens (device list, add device) and the
 * WebView container.
 *
 * The shell palette follows the *page* theme (which is zai-dark by default and
 * independent of the OS day/night setting), and the status-bar strip always
 * matches whatever the page is actually painting. The connection link is
 * validated by [EntryLinkPolicy], stored encrypted by [DeviceStore], and never
 * placed into instance state, intent extras, logs, titles, or error messages.
 */
class MainActivity : ComponentActivity() {

    private enum class Mode { CONNECT, WEB, DEVICES }

    private lateinit var store: DeviceStore
    private val uploadRequests = UploadRequestState()

    private var mode: Mode = Mode.CONNECT
    private var savedLink: String? = null
    private var allowedOrigin: String? = null
    /** Id of the device currently loaded in the shell, for the list highlight. */
    private var activeDeviceId: String? = null
    private var connectionId: Long = 0

    private var webView: WebView? = null
    private var currentBackdrop: View? = null
    /**
     * The single load-state view (loading / failed / revoked) overlaid on the
     * web slot, if any. One view serves both former screens so switching states
     * never rebuilds or reflows it.
     */
    private var currentLoadStateView: View? = null
    /** Which state [currentLoadStateView] currently renders. */
    private var currentLoadStateKind: LoadStatePolicy.Kind? = null
    /** True once the current page has committed a first paint. */
    private var pageCommitted: Boolean = false
    /**
     * True when the native reachability probe could not reach the device origin.
     * The page itself is not evidence of success: with the network down it still
     * renders from its Service Worker cache and then fails its WebSocket.
     */
    private var reachabilityFailed: Boolean = false
    private val probeExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()

    // Per-device credential auth (device-credential protocol). Requests run off
    // the main thread; the session token is never persisted.
    private val authExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val authClient by lazy { DeviceAuthClient() }

    /** When the current session expires (0 = none established this run). */
    private var sessionExpiresAt: Long = 0L
    private var renewInFlight: Boolean = false
    private val taskNotifier by lazy { TaskNotifier(this) }
    /** One permission warning per app run, not per notification. */
    private var notificationWarningShown: Boolean = false
    private val reprobe = Runnable { probeReachability() }
    private var pageThemeColor: Int? = null
    private val preferences by lazy { getSharedPreferences(PREFS_NAME, MODE_PRIVATE) }

    /**
     * Whether the ZCode page currently renders its dark theme. The page defaults
     * to zai-dark, so a device that has never reported yet starts dark to match.
     */
    private var pageIsDark: Boolean = true

    // --- shell palette (follows the page, never the OS) ----------------------

    /** Persists WebView cookies to disk (no-op if the profile is unavailable). */
    private fun flushCookies() {
        runCatching { CookieManager.getInstance().flush() }
    }

    /** True when the WebView's current main-frame document is the app's page. */
    private fun isTrustedPage(): Boolean =
        EntryLinkPolicy.isSameOrigin(webView?.url, allowedOrigin)

    /** Current shell palette, derived from the page theme last observed. */
    private fun palette(): ShellPalette = ShellPalette.of(this, pageIsDark)

    /**
     * Paints the shell window background for [palette] and matches the status-bar
     * glyphs to it. Called on every screen change so no stale-palette frame is
     * shown while a new content view inflates.
     *
     * The palette is applied to views in code (never through a runtime theme
     * switch): Android caches themed drawables per resource id, which previously
     * left cards/buttons painted with the previous palette while text colors
     * switched.
     */
    private fun applyWindowChrome(p: ShellPalette) {
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(p.background))
        applyStatusBarIconsFor(p.background)
    }

    // --- screen styling ------------------------------------------------------

    private fun styleConnectScreen(p: ShellPalette) {
        findViewById<View>(R.id.connect_container).setBackgroundColor(p.background)
        findViewById<android.widget.ImageView>(R.id.connect_icon).setColorFilter(p.accent)
        findViewById<TextView>(R.id.connect_heading).setTextColor(p.foreground)
        findViewById<TextView>(R.id.connect_subtitle).setTextColor(p.secondary)
        for (id in intArrayOf(R.id.name_input, R.id.connect_input)) {
            findViewById<EditText>(id).apply {
                background = ShellUi.input(this@MainActivity, p)
                setTextColor(p.foreground)
                setHintTextColor(p.secondary)
            }
        }
        findViewById<TextView>(R.id.connect_error).setTextColor(p.error)
        findViewById<Button>(R.id.connect_submit).apply {
            background = ShellUi.primaryButton(this@MainActivity, p)
            setTextColor(p.foreground)
        }
        findViewById<Button>(R.id.connect_cancel).apply {
            background = ShellUi.secondaryButton(this@MainActivity, p)
            setTextColor(p.secondary)
        }
    }

    private fun styleDevicesScreen(p: ShellPalette) {
        findViewById<View>(R.id.devices_container).setBackgroundColor(p.background)
        findViewById<TextView>(R.id.devices_title).setTextColor(p.foreground)
        findViewById<TextView>(R.id.devices_description).setTextColor(p.secondary)
        findViewById<android.widget.ImageView>(R.id.devices_empty_icon).setColorFilter(p.secondary)
        findViewById<TextView>(R.id.devices_empty_title).setTextColor(p.foreground)
        findViewById<TextView>(R.id.devices_empty_description).setTextColor(p.secondary)
        findViewById<Button>(R.id.devices_add).apply {
            background = ShellUi.primaryButton(this@MainActivity, p)
            setTextColor(p.foreground)
        }
    }

    /** Repaints the shared load-state view (loading / failed) for [palette]. */
    private fun styleLoadState(view: View, p: ShellPalette) {
        view.findViewById<View>(R.id.load_state_container).setBackgroundColor(p.background)
        view.findViewById<android.widget.ImageView>(R.id.load_state_icon).setColorFilter(p.secondary)
        view.findViewById<TextView>(R.id.load_state_title).setTextColor(p.foreground)
        view.findViewById<TextView>(R.id.load_state_body).setTextColor(p.secondary)
        view.findViewById<Button>(R.id.load_state_primary).apply {
            background = ShellUi.primaryButton(this@MainActivity, p)
            setTextColor(p.foreground)
        }
        view.findViewById<Button>(R.id.load_state_secondary).apply {
            background = ShellUi.secondaryButton(this@MainActivity, p)
            setTextColor(p.secondary)
        }
    }

    /** Repaints the screen currently on display after a page-theme change. */
    private fun restyleCurrentScreen() {
        val p = palette()
        when (mode) {
            Mode.CONNECT -> styleConnectScreen(p)
            Mode.DEVICES -> {
                styleDevicesScreen(p)
                findViewById<android.widget.ListView>(R.id.devices_list).adapter?.let { adapter ->
                    (adapter as? DeviceListAdapter)?.updatePalette(p)
                }
            }
            Mode.WEB -> currentLoadStateView?.let { styleLoadState(it, p) }
        }
        applyWindowChrome(p)
    }

    // --- lifecycle ---------------------------------------------------------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = DeviceStore(this)

        // Crash evidence: without a connected device there is no logcat; the last
        // uncaught exception is persisted (class + message only, never link data)
        // and shown on the connect screen so a crash is diagnosable from the phone.
        val previousCrash = try {
            File(filesDir, CRASH_FILE).takeIf { it.exists() }?.readText()?.take(400)
        } catch (e: Exception) {
            null
        }
        try {
            File(filesDir, CRASH_FILE).delete()
        } catch (e: Exception) {
        }
        val systemHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                File(filesDir, CRASH_FILE).writeText(
                    "${throwable.javaClass.name}: ${throwable.message ?: "(no message)"} @ ${thread.name}",
                )
            } catch (e: Exception) {
            }
            systemHandler?.uncaughtException(thread, throwable)
        }

        @Suppress("DEPRECATION")
        window.run {
            // True edge-to-edge: the shell owns the status-bar strip with a themed
            // backdrop (dsh-mobile pattern), so system bars are transparent.
            statusBarColor = android.graphics.Color.TRANSPARENT
            navigationBarColor = android.graphics.Color.TRANSPARENT
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                setDecorFitsSystemWindows(false)
            } else {
                decorView.systemUiVisibility = decorView.systemUiVisibility or
                    android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            }
        }

        // The shell palette follows the page theme last reported (zai-dark by
        // default), not the OS day/night setting.
        pageIsDark = preferences.getBoolean(PREF_PAGE_IS_DARK, true)
        preferences.getInt(PREF_PAGE_THEME_COLOR, 0).takeIf { it != 0 }?.let { pageThemeColor = it }
        applyWindowChrome(palette())
        // Keep-alive: the process must survive backgrounding for the page's
        // notifications to keep arriving; default on, user can switch it off
        // from the devices screen or the notification itself.
        ZcodeKeepaliveService.ensureStarted(this, preferences)
        preferences.getInt(PREF_PAGE_THEME_COLOR, 0).takeIf { it != 0 }?.let {
            taskNotifier.themeColor = it
        }

        // Probe-driven completion watchdog: when the ROM freezes the WebView
        // thread, the page can no longer observe terminal states and the
        // shim's notification chain goes silent — but the keep-alive probe
        // loop keeps running. The service diffs the server's completed-unread
        // counter and hands the delta here; one system notification covers
        // each batch, and the status row follows.
        ZcodeKeepaliveService.CompletionBridge.onCompletions = { count ->
            runOnUiThread { postCompletionWatchdogNotification(count) }
        }

        // Pending-interaction watchdog ("有 N 项等待你的回复"): wired once here
        // but posted through TaskNotifier's static path, so it keeps working
        // after this Activity is destroyed (a backgrounded app is exactly the
        // case the watchdog exists for). One notification per rising edge,
        // same task channel as the page's own notifications. The optional
        // digest text rides along as the body when the probe carried one.
        ZcodeKeepaliveService.PendingBridge.onPending = { current, digestText ->
            runOnUiThread {
                taskNotifier.themeColor = pageThemeColor
                TaskNotifier.postPendingStatic(applicationContext, current, digestText)
            }
        }

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    handleBack()
                }
            },
        )

        // Launcher behavior: connect straight to the most recently used
        // device when one exists; otherwise the connect form.
        val latest = try {
            store.list().maxByOrNull { it.lastUsedAt }
        } catch (e: Exception) {
            null
        }
        if (latest != null) {
            // Load first, exactly like dsh-mobile: the page is opened even when
            // the network looks down, and the reachability probe below turns a
            // real failure into the native retry / back-to-list screen.
            try {
                connectToDevice(latest.id)
            } catch (e: Exception) {
                showConnect(restoreFailed = true)
            }
        } else {
            showConnect(crashNote = previousCrash)
        }
    }

    override fun onPause() {
        super.onPause()
        webView?.onPause()
        flushCookies()
    }

    override fun onStop() {
        super.onStop()
        flushCookies()
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
        // Deliberately no reload on resume — but a session that expired while the
        // app sat in the background must be renewed, otherwise the page's next
        // request 401s and the user is asked to pair again.
        renewSessionIfDue()
    }

    /**
     * Silently renews the web session when it is at or near expiry. The page is
     * NOT reloaded: its own reconnect path picks up the fresh cookies, so the user
     * keeps their place. A 401 here means the device was revoked on the server,
     * which surfaces as the "removed" screen.
     */
    private fun renewSessionIfDue() {
        if (mode != Mode.WEB) return
        val id = activeDeviceId ?: return
        val origin = allowedOrigin ?: return
        // 0 means this run has not established a session yet; entering the device
        // owns that first renew.
        if (sessionExpiresAt <= 0L) return
        if (System.currentTimeMillis() < sessionExpiresAt - SESSION_RENEW_SKEW_MS) return
        if (renewInFlight) return
        val credential = loadCredential(id) ?: return
        renewInFlight = true
        authExecutor.execute {
            val pairing = authClient.renew(origin, credential.toPolicy())
            runOnUiThread {
                renewInFlight = false
                if (activeDeviceId != id) return@runOnUiThread
                when {
                    pairing.ok -> {
                        sessionExpiresAt = pairing.session.expiresAt
                        injectSessionCookies(origin, pairing.session)
                        // Renew succeeded with the in-memory credential: keep the
                        // probe's shared target in step (device switched mid-run).
                        activeCredentialToken()?.let { ProbeTargetCache.put(it, origin) }
                    }

                    pairing.failure == DeviceAuthPolicy.Failure.UNAUTHORIZED -> {
                        dropCredential(id)
                        showRevokedScreen()
                    }

                    else -> Unit // network trouble: retry on the next resume
                }
            }
        }
    }

    override fun onDestroy() {
        webView?.removeCallbacks(reprobe)
        probeExecutor.shutdownNow()
        authExecutor.shutdownNow()
        uploadRequests.invalidate()
        ZcodeKeepaliveService.ActivityOriginBridge.activeOrigin = null
        ZcodeKeepaliveService.CompletionBridge.onCompletions = null
        // Deliberately NOT cleared: the pending watchdog must outlive this
        // Activity (it posts through the static, application-scoped path).
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    // No onSaveInstanceState override: the link is never persisted into
    // Activity saved state. Configuration changes do not recreate this
    // Activity (see android:configChanges in the manifest).

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == UploadRequestState.REQUEST_CODE) {
            // Resolves only when the request, this Activity, and the current
            // connection all still match; otherwise the stale request is dropped.
            uploadRequests.resolve(requestCode, resultCode, data, this, connectionId)
        }
    }

    // --- add device form ---------------------------------------------------

    private fun showConnect(restoreFailed: Boolean = false, crashNote: String? = null) {
        currentLoadStateView = null
        currentLoadStateKind = null
        reachabilityFailed = false
        mode = Mode.CONNECT
        val p = palette()
        applyWindowChrome(p)
        setContentView(R.layout.activity_connect)
        styleConnectScreen(p)
        val container = findViewById<ViewGroup>(R.id.connect_container)
        // Same inset contract as the web mode: the shell clears the status bar,
        // content starts below it. Original paddings come from the layout; only
        // the safe-area offsets are added on top.
        val basePaddingLeft = container.paddingLeft
        val basePaddingRight = container.paddingRight
        val basePaddingTopDp = 72
        val basePaddingBottomDp = 32
        val density = resources.displayMetrics.density
        container.setOnApplyWindowInsetsListener { _, insets ->
            val top = resolveTopSafeInset(insets)
            val ime = resolveWebViewImeInset(insets)
            container.setPadding(
                basePaddingLeft,
                top + (basePaddingTopDp * density).toInt(),
                basePaddingRight,
                (basePaddingBottomDp * density).toInt() + ime,
            )
            insetsForWebContent(insets, top)
        }
        container.requestApplyInsets()

        val input = findViewById<EditText>(R.id.connect_input)
        val nameInput = findViewById<EditText>(R.id.name_input)
        val error = findViewById<TextView>(R.id.connect_error)
        val cancelButton = findViewById<Button>(R.id.connect_cancel)
        val submitButton = findViewById<Button>(R.id.connect_submit)

        findViewById<TextView>(R.id.connect_heading).setText(R.string.connect_title)
        input.setText("")
        error.text = ""
        error.visibility = TextView.GONE

        // Cancel is only meaningful when there is somewhere to go back to:
        // the device list (another device exists) or an already-open page.
        val hasDevices = try {
            store.list().isNotEmpty()
        } catch (e: Exception) {
            false
        }
        val canCancel = savedLink != null || hasDevices
        cancelButton.visibility = if (canCancel) TextView.VISIBLE else TextView.GONE
        cancelButton.setOnClickListener { cancelAddDevice() }

        submitButton.setText(R.string.connect_button)

        input.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) {
                // Clear any error as soon as the user edits, without echoing content.
                if (error.visibility == TextView.VISIBLE) {
                    error.visibility = TextView.GONE
                    error.text = ""
                }
            }
        })

        submitButton.setOnClickListener {
            val raw = input.text?.toString()
            val result = EntryLinkPolicy.validate(raw)
            if (!result.valid) {
                error.text = result.error ?: EntryLinkPolicy.ERROR_LINK_INVALID
                error.visibility = TextView.VISIBLE
                return@setOnClickListener
            }
            val link = result.url ?: return@setOnClickListener
            val origin = originFromResult(result) ?: return@setOnClickListener
            // Default device name is the host; rename later via long-press.
            val name = nameInput.text?.toString()?.trim().takeIf { !it.isNullOrEmpty() }
                ?: result.host ?: getString(R.string.app_name)
            val kind = if (result.path == EntryLinkPolicy.WEB_REMOTE_PATH) "remote" else "direct"
            try {
                val id = store.save(name, link, origin, kind)
                val saved = result.copy(url = link)
                onConnectionEstablished(saved, id)
            } catch (e: Exception) {
                error.text = getString(R.string.connect_save_failed)
                error.visibility = TextView.VISIBLE
                return@setOnClickListener
            }
        }

        if (restoreFailed) {
            error.text = getString(R.string.connect_restore_failed)
            error.visibility = TextView.VISIBLE
        }
        if (crashNote != null) {
            // Show the recorded crash class/message so a repeat crash can be
            // reported precisely; never contains link data.
            error.text = "上次异常：$crashNote"
            error.visibility = TextView.VISIBLE
        }

        // First launch with no device yet: the web screen's prompt hook never
        // runs, so the permissions the shell depends on (notifications and the
        // battery exemption) are offered here instead — from the visible
        // screen's first frame, bounded by the same gates as everywhere else.
        window.decorView.post {
            if (mode != Mode.CONNECT) return@post
            requestShellPermissionsOnce()
        }
    }

    /** Leaves the add-device form without changing anything. */
    private fun cancelAddDevice() {
        // An open page is kept untouched; otherwise fall back to the list.
        if (savedLink != null) {
            enterWebMode()
        } else {
            showDevices()
        }
    }

    private fun onConnectionEstablished(result: EntryLinkPolicy.Result, deviceId: String) {
        activeDeviceId = deviceId
        savedLink = result.url
        allowedOrigin = originFromResult(result)
        connectionId += 1
        uploadRequests.invalidate()
        // A new connection means the old page state must not survive.
        destroyWebView()
        // Credentialless link: the page will pair inside itself and self-heal
        // its session through the renewal cookie afterwards — publish the
        // origin so the keep-alive probe's cookie fallback reads the right jar.
        ZcodeKeepaliveService.ActivityOriginBridge.activeOrigin = allowedOrigin
        enterWebMode()
    }

    // --- web mode ----------------------------------------------------------

    private fun enterWebMode() {
        val link = savedLink ?: return
        mode = Mode.WEB
        applyWindowChrome(palette())
        setContentView(R.layout.activity_web)
        // The new container holds no overlays yet.
        currentLoadStateView = null
        currentLoadStateKind = null

        val slot = findViewById<FrameLayout>(R.id.web_slot)
        val view = webView ?: buildWebView().also { webView = it }
        (view.parent as? ViewGroup)?.removeView(view)
        slot.addView(
            view,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        // dsh-mobile pattern: the WebView itself sits below the status bar via
        // topMargin; a backdrop strip painted with the theme background covers
        // the status-bar area so the page never slides under the clock. No
        // native top bar: the ZCode page is the whole UI.
        val root = findViewById<ViewGroup>(R.id.web_container)
        var backdrop = currentBackdrop
        if (backdrop == null || backdrop.parent !== root) {
            backdrop = View(this).apply {
                // Last known page background wins; the page's own report updates
                // it a moment later. Falls back to the shell theme color.
                setBackgroundColor(
                    pageThemeColor
                        ?: preferences.getInt(PREF_PAGE_THEME_COLOR, palette().background),
                )
            }
            currentBackdrop = backdrop
        }
        (backdrop.parent as? ViewGroup)?.removeView(backdrop)
        root.addView(
            backdrop,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                0,
            ),
        )
        val backdropRef = backdrop

        // Paint the status-bar glyphs for the strip color we start with; the
        // page's own report refines it moments later.
        applyStatusBarIconsFor(
            pageThemeColor
                ?: preferences.getInt(PREF_PAGE_THEME_COLOR, palette().background),
        )
        root.setOnApplyWindowInsetsListener { _, insets ->
            val top = resolveTopSafeInset(insets)
            val ime = resolveWebViewImeInset(insets)
            view.layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ).apply {
                topMargin = top
                bottomMargin = ime
            }
            backdropRef.layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                top,
            )
            insetsForWebContent(insets, top)
        }
        root.requestApplyInsets()

        if (view.url == null) {
            pageCommitted = false
            reachabilityFailed = false
            showLoadingState()
            view.loadUrl(link)
        }
        probeReachability()
        requestShellPermissionsOnce()
        // Otherwise the existing instance keeps its document as-is.
    }

    // --- load-state view (merged connecting / failed) ------------------------

    /**
     * A slow or dead network must never leave the user staring at a blank
     * WebView: while the first page has not committed, a native load-state view
     * offers the device list (dsh-mobile has the same escape hatch); a timeout
     * turns a stalled load into the failed state of the *same* view. The former
     * two layouts (view_connecting / activity_error) differed in icon, type
     * scale and button order, so the 15s switch read as a scene change — now
     * loading and failed differ only in indicator and copy, and the retry flow
     * (failed → loading) also just flips state in place.
     */
    private fun showLoadingState() = showLoadState(LoadStatePolicy.Kind.LOADING)

    private fun showLoadState(kind: LoadStatePolicy.Kind) {
        val slot = findViewById<FrameLayout>(R.id.web_slot) ?: return
        val existing = currentLoadStateView
        if (existing != null && existing.parent === slot) {
            // Same view, in place: no remove+add, so nothing blinks.
            applyLoadState(existing, kind)
            return
        }
        if (currentLoadStateView != null) {
            // Stale reference to a detached view (the user left the web screen).
            (currentLoadStateView?.parent as? ViewGroup)?.removeView(currentLoadStateView)
            currentLoadStateView = null
            currentLoadStateKind = null
        }
        val view = layoutInflater.inflate(R.layout.view_load_state, slot, false)
        styleLoadState(view, palette())
        bindLoadStateActions(view)
        slot.addView(view)
        currentLoadStateView = view
        applyLoadState(view, kind)
        if (kind == LoadStatePolicy.Kind.LOADING) armLoadTimeout()
    }

    /** Flips the shared view's indicator, copy and secondary label for [kind]. */
    private fun applyLoadState(view: View, kind: LoadStatePolicy.Kind) {
        currentLoadStateKind = kind
        val visual = LoadStatePolicy.visual(kind)
        view.findViewById<View>(R.id.load_state_icon).visibility =
            if (visual.iconVisible) View.VISIBLE else View.GONE
        view.findViewById<View>(R.id.load_state_spinner).visibility =
            if (visual.spinnerVisible) View.VISIBLE else View.GONE
        when (kind) {
            LoadStatePolicy.Kind.LOADING -> {
                view.findViewById<TextView>(R.id.load_state_title)
                    .setText(R.string.connecting_title)
                view.findViewById<TextView>(R.id.load_state_body)
                    .setText(R.string.connecting_detail)
                view.findViewById<Button>(R.id.load_state_secondary)
                    .setText(R.string.error_page_retry)
            }

            LoadStatePolicy.Kind.FAILED -> {
                // Default failed copy; showRevokedScreen overwrites the texts.
                view.findViewById<TextView>(R.id.load_state_title)
                    .setText(R.string.error_page_title)
                view.findViewById<TextView>(R.id.load_state_body)
                    .setText(R.string.error_page_body)
                view.findViewById<Button>(R.id.load_state_secondary)
                    .setText(R.string.error_page_retry)
            }
        }
    }

    /**
     * Button wiring, fixed for every state: primary = device list, secondary =
     * retry (re-labelled for the revoked screen, with its own onRetry when set).
     */
    private fun bindLoadStateActions(view: View) {
        view.findViewById<Button>(R.id.load_state_primary).setOnClickListener {
            hideLoadState()
            showDevices()
        }
        view.findViewById<Button>(R.id.load_state_secondary).setOnClickListener {
            val custom = loadStateRetryAction
            loadStateRetryAction = null
            if (custom != null) {
                custom()
                return@setOnClickListener
            }
            pageCommitted = false
            showLoadState(LoadStatePolicy.Kind.LOADING)
            webView?.reload()
            probeReachability()
        }
    }

    /** One-shot retry override for the revoked screen's pairing action. */
    private var loadStateRetryAction: (() -> Unit)? = null

    private fun hideLoadState() {
        // Detach through the view's own parent: the container may already be
        // gone (the user left the web screen), and the reference must still be
        // cleared so a later load can show the view again.
        currentLoadStateView?.let { view ->
            (view.parent as? ViewGroup)?.removeView(view)
        }
        currentLoadStateView = null
        currentLoadStateKind = null
        loadStateRetryAction = null
    }

    /** If the page still has not committed after [LOAD_TIMEOUT_MS], show failure. */
    private fun armLoadTimeout() {
        val view = webView ?: return
        view.removeCallbacks(loadTimeout)
        view.postDelayed(loadTimeout, LOAD_TIMEOUT_MS)
    }

    private val loadTimeout = Runnable {
        if (!pageCommitted) {
            showErrorPage(true)
        }
    }

    /** The page committed a first paint: the shell is no longer needed. */
    private fun onPageCommitted() {
        pageCommitted = true
        webView?.removeCallbacks(loadTimeout)
        hideLoadState()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        val view = WebView(this)
        view.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )

        // Cookie session persistence. WebView keeps cookies in memory and only
        // writes them to disk lazily; without an explicit flush a recent login
        // is lost when the process is killed (swipe-away / low memory), which
        // looks exactly like "I paired and it asks me to pair again".
        runCatching {
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        }

        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(true)
            mediaPlaybackRequiresUserGesture = true
            safeBrowsingEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        // ZCode ships its own light/dark themes, so the WebView must never
        // auto-darken the page: user-agent darkening rendered a light page dark
        // whenever the engine considered itself in night mode — exactly the
        // symptom of the web UI picking up a dark system colour scheme. The
        // page's own "follow system" theme stays authoritative.
        runCatching {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
                WebSettingsCompat.setAlgorithmicDarkeningAllowed(view.settings, false)
            } else {
                @Suppress("DEPRECATION")
                WebSettingsCompat.setForceDark(view.settings, WebSettingsCompat.FORCE_DARK_OFF)
            }
        }

        // The page draws its own scroll affordances; the platform overlay bar
        // only steals visual width from the session area.
        view.isVerticalScrollBarEnabled = false
        view.isHorizontalScrollBarEnabled = false
        view.scrollBarStyle = View.SCROLLBARS_INSIDE_OVERLAY

        // Live theme channel (dsh-mobile WebMessage pattern): the page reports
        // its real background so the status bar matches the *page* theme, not
        // the system theme (the page defaults to zai-dark independent of OS).
        // Task notifications: the page's own "task finished" call needs the Web
        // Notifications API, which WebView does not implement. Install the shim
        // before page scripts so the bundle never sees it missing.
        allowedOrigin?.let { origin -> ThemeChannel.installNotificationShim(view, origin) }

        allowedOrigin?.let { origin ->
            ThemeChannel.install(view, origin) { text ->
                runOnUiThread { handleShellMessage(text) }
            }
        }

        view.webViewClient = ShellWebViewClient()
        view.webChromeClient = ShellWebChromeClient()
        // The WebView cannot render a download (the page itself asked for a
        // file, e.g. an APK link), and the system browser holds no pairing
        // session — handing a session-protected URL to it dead-ends in a 401
        // page. Downloads therefore resolve inside the shell: the system
        // DownloadManager fetches the file into the public Downloads
        // directory, carrying the WebView session cookie only when the target
        // is the app's own origin. DownloadPolicy decides; any URL it refuses
        // (plain HTTP, blob:, credential-bearing, unparsable) surfaces the
        // unsupported toast, and a manager failure surfaces the start-failed
        // toast. Nothing about the request is logged.
        view.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            handleDownload(url, contentDisposition, mimeType)
        }
        return view
    }

    /**
     * Handles a WebView download request. DownloadPolicy decides: HTTPS URLs
     * it accepts go to the system DownloadManager (session cookie attached
     * only for same-origin targets), everything else surfaces the
     * unsupported toast. No part of the request is logged.
     */
    private fun handleDownload(url: String?, contentDisposition: String?, mimeType: String?) {
        // Cookie jar lookup is best-effort: any failure counts as "no cookie",
        // and DownloadPolicy still refuses cookie attachment for foreign
        // origins regardless of this value.
        val hasCookies = url != null &&
            runCatching { !CookieManager.getInstance().getCookie(url).isNullOrEmpty() }
                .getOrDefault(false)
        val decision = DownloadPolicy.decide(
            url = url,
            contentDisposition = contentDisposition,
            mimeType = mimeType,
            pageOrigin = allowedOrigin,
            hasCookies = hasCookies,
            nowMillis = System.currentTimeMillis(),
        )
        when (decision.action) {
            DownloadPolicy.Action.DOWNLOAD_VIA_MANAGER -> enqueueDownload(url ?: return, decision)
            DownloadPolicy.Action.HAND_OFF_BROWSER, DownloadPolicy.Action.UNSUPPORTED ->
                toast(EntryLinkPolicy.DOWNLOAD_UNSUPPORTED)
        }
    }

    /**
     * Enqueues the download into the system DownloadManager, which stores it
     * in the public Downloads directory and posts its own completion
     * notification — the shell adds none. The session cookie rides only when
     * DownloadPolicy judged the target same-origin, and the request is
     * network-only so the header is not exposed through cached/downloaded
     * UI surfaces.
     */
    private fun enqueueDownload(url: String, decision: DownloadPolicy.Decision) {
        try {
            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle(decision.fileName)
                .setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED,
                )
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(true)
            decision.mimeType?.let { request.setMimeType(it) }
            if (decision.attachCookies) {
                runCatching { CookieManager.getInstance().getCookie(url) }.getOrNull()?.let { cookie ->
                    request.addRequestHeader("Cookie", cookie)
                }
            }
            request.setDestinationInExternalPublicDir(
                Environment.DIRECTORY_DOWNLOADS,
                decision.fileName,
            )
            getSystemService(DownloadManager::class.java).enqueue(request)
        } catch (e: Exception) {
            // Manager refused (rare: malformed URL it rejects, storage
            // unavailable). Static toast, no exception details surfaced.
            toast(DownloadPolicy.DOWNLOAD_START_FAILED)
        }
    }

    private fun destroyWebView() {
        flushCookies()
        uploadRequests.invalidate()
        (webView?.parent as? ViewGroup)?.removeView(webView)
        webView?.destroy()
        webView = null
        currentBackdrop = null
        pageThemeColor = null
    }

    // --- per-device credential client ---------------------------------------

    private fun credentialStoreFor(id: String): DeviceCredentialStore =
        DeviceCredentialStore(this, slot = id)

    private fun loadCredential(id: String): DeviceCredentialStore.Credential? = try {
        credentialStoreFor(id).load()
    } catch (e: Exception) {
        // Keystore key invalidated (factory reset, app data restored elsewhere):
        // treat as "no credential" and let the user pair again.
        null
    }

    /**
     * Renews the session for a device that already holds a credential, injects the
     * resulting cookies into the WebView, then loads the origin. Runs off the main
     * thread; the connecting overlay is reused as the progress surface.
     */
    private fun renewThenLoad(id: String, origin: String, credential: DeviceCredentialStore.Credential) {
        destroyWebView()
        enterWebMode()
        showLoadingState()
        authExecutor.execute {
            val pairing = authClient.renew(origin, credential.toPolicy())
            runOnUiThread {
                if (activeDeviceId != id) return@runOnUiThread
                when {
                    pairing.ok -> {
                        sessionExpiresAt = pairing.session.expiresAt
                        injectSessionCookies(origin, pairing.session)
                        // This renew runs on the credential that just passed the
                        // server check — the same pair the probe should use.
                        ProbeTargetCache.put(credential.deviceToken, origin)
                        pageCommitted = false
                        showLoadingState()
                        webView?.loadUrl(origin + "/")
                        probeReachability()
                    }

                    pairing.failure == DeviceAuthPolicy.Failure.UNAUTHORIZED -> {
                        dropCredential(id)
                        hideLoadState()
                        showRevokedScreen()
                    }

                    else -> {
                        // Network trouble: fall through to a plain load, the server
                        // may still honour the cookies already in the jar.
                        hideLoadState()
                        pageCommitted = false
                        webView?.loadUrl(origin + "/")
                        probeReachability()
                    }
                }
            }
        }
    }

    private fun injectSessionCookies(origin: String, session: DeviceAuthPolicy.Session) {
        if (session.token.isEmpty()) return
        runCatching {
            val manager = CookieManager.getInstance()
            manager.setAcceptCookie(true)
            for (header in DeviceAuthPolicy.cookieHeaders(session)) {
                manager.setCookie(origin, header)
            }
            manager.flush()
        }
    }

    private fun dropCredential(id: String) {
        runCatching { credentialStoreFor(id).clear() }
        // The revoked device's cached probe target is dead: the probe falls
        // back to the store chain (and then to "未配对") until the user
        // re-pairs, which repopulates the cache with the fresh token.
        ProbeTargetCache.clear()
        // The origin's cookie jar belongs to the revoked device too: without
        // this the probe's renew-cookie fallback would keep presenting a dead
        // token (fail closed — the server answers 401 → REVOKED → stop).
        ZcodeKeepaliveService.ActivityOriginBridge.activeOrigin = null
    }

    /**
     * The device token of the credential currently loaded for the active
     * device, or null. Used to refresh [ProbeTargetCache] from paths that
     * verified the session but did not keep the credential object in scope.
     */
    private fun activeCredentialToken(): String? {
        val id = activeDeviceId ?: return null
        return loadCredential(id)?.deviceToken
    }

    /** The server answered 401 for a device credential: it was revoked there. */
    private fun showRevokedScreen() {
        // Same shared view, failed rendering with pairing copy; onRetry wins for
        // one tap, then the default retry wiring resumes.
        showErrorPage(
            show = true,
            titleRes = R.string.device_revoked_title,
            bodyRes = R.string.device_revoked_body,
            retryLabelRes = R.string.device_pair_action,
            onRetry = {
                val id = activeDeviceId
                if (id != null) showPairingDialog(id) else showDevices()
            },
        )
    }

    /**
     * Native pairing: the one-time code is redeemed by the shell (not by the page)
     * so the long-lived device credential lands in the Keystore and the session
     * cookie is injected by us. That is what makes renewal possible later.
     */
    private fun showPairingDialog(id: String) {
        val device = try {
            store.list().find { it.id == id }
        } catch (e: Exception) {
            null
        } ?: return
        val origin = try {
            store.linkOf(id)?.let { EntryLinkPolicy.validate(it) }?.let { originFromResult(it) }
        } catch (e: Exception) {
            null
        } ?: return

        val p = palette()
        val input = EditText(this).apply {
            hint = getString(R.string.device_pair_hint)
            inputType = android.text.InputType.TYPE_CLASS_TEXT
            maxLines = 1
            background = ShellUi.input(this@MainActivity, p)
            setTextColor(p.foreground)
            setHintTextColor(p.secondary)
            setPadding(dp(14), dp(12), dp(14), dp(12))
        }
        val error = TextView(this).apply {
            setTextColor(p.error)
            textSize = 13f
            visibility = View.GONE
            setPadding(0, dp(8), 0, 0)
        }
        val wrapper = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        wrapper.addView(
            input,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        wrapper.addView(
            error,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )

        val dialog = ShellDialogs.show(
            context = this,
            palette = p,
            title = getString(R.string.device_pair_action),
            contentView = wrapper,
            primaryText = getString(R.string.action_confirm),
            onPrimary = { d ->
                val code = input.text?.toString()?.trim().orEmpty()
                if (code.isEmpty()) {
                    error.text = getString(R.string.device_pair_code_required)
                    error.visibility = View.VISIBLE
                    return@show
                }
                val submit = d.primaryButton
                submit?.isEnabled = false
                error.visibility = View.GONE
                authExecutor.execute {
                    val pairing = authClient.redeem(origin, code, device.name)
                    runOnUiThread {
                        when {
                            pairing.ok -> {
                                try {
                                    credentialStoreFor(id).save(
                                        DeviceCredentialStore.Credential(
                                            deviceId = pairing.credential.deviceId,
                                            deviceToken = pairing.credential.deviceToken,
                                            expiresAt = pairing.credential.expiresAt,
                                        ),
                                    )
                                } catch (e: Exception) {
                                    error.text = getString(R.string.device_pair_save_failed)
                                    error.visibility = View.VISIBLE
                                    submit?.isEnabled = true
                                    return@runOnUiThread
                                }
                                sessionExpiresAt = pairing.session.expiresAt
                                injectSessionCookies(origin, pairing.session)
                                // Fresh pairing: the new device token is the one
                                // truth from now on (any earlier cache entry is
                                // for a revoked or replaced device).
                                ProbeTargetCache.put(pairing.credential.deviceToken, origin)
                                d.dismiss()
                                // Pairing is pointless if the stored link still
                                // points at the dead token URL, so normalise the
                                // entry to the bare origin.
                                runCatching {
                                    store.save(device.name, origin + "/", origin, device.kind, id)
                                }
                                connectToDevice(id)
                            }

                            pairing.failure == DeviceAuthPolicy.Failure.INVALID_CODE -> {
                                error.text = getString(R.string.device_pair_invalid)
                                error.visibility = View.VISIBLE
                                submit?.isEnabled = true
                            }

                            else -> {
                                error.text = getString(R.string.device_pair_failed)
                                error.visibility = View.VISIBLE
                                submit?.isEnabled = true
                            }
                        }
                    }
                }
            },
            secondaryText = getString(R.string.action_cancel),
            onSecondary = { d -> d.dismiss() },
        )
    }

    private fun DeviceCredentialStore.Credential.toPolicy() = DeviceAuthPolicy.Credential(
        deviceId = deviceId,
        deviceToken = deviceToken,
        expiresAt = expiresAt,
    )

    // --- task notifications --------------------------------------------------

    /**
     * A task finished (or needs input) while the page was unfocused. The page
     * sends `{title, body}`; text is sanitised and capped before it is shown, and
     * an empty payload is dropped. When notifications are blocked the user is
     * told once per run instead of silently losing every reminder.
     */
    /**
     * The keep-alive probe observed new finished tasks while the page could
     * not (frozen WebView). One notification per batch, page-style copy;
     * posting goes through [TaskNotifier] so permission/channel handling
     * stays in one place. The status row's own unread figure is page-driven
     * (tasks-consumed) and deliberately untouched here.
     */
    private fun postCompletionWatchdogNotification(count: Int) {
        if (count <= 0) return
        pageThemeColor?.let { taskNotifier.themeColor = it }
        taskNotifier.post(
            getString(R.string.task_completion_watchdog_title),
            getString(R.string.task_completion_watchdog_body, count),
        )
        refreshKeepaliveRow()
    }

    private fun handleTaskNotification(json: String) {        val payload = try {
            org.json.JSONObject(json)
        } catch (e: Exception) {
            return
        }
        val title = NotificationTextPolicy.title(payload.optString("title", ""))
        val body = NotificationTextPolicy.body(payload.optString("body", ""))
        if (NotificationTextPolicy.isEmpty(title, body)) return
        // The page's theme report feeds the notification accent.
        pageThemeColor?.let { taskNotifier.themeColor = it }
        if (!taskNotifier.post(title, body) && !notificationWarningShown) {
            notificationWarningShown = true
            android.widget.Toast.makeText(this, R.string.notification_blocked, android.widget.Toast.LENGTH_LONG)
                .show()
        }
    }

    /**
     * The page reports that the user has seen the finished tasks in the app:
     * the keep-alive row's "已完成 M" figure drops back to zero and the row
     * refreshes. Best-effort — the service may be stopped (switch off), in
     * which case there is nothing to refresh.
     */
    private fun onTasksConsumed() {
        preferences.edit().putInt(ZcodeKeepaliveService.PREF_COMPLETED_COUNT, 0).apply()
        // The user is looking at the answers inside the app: a standing
        // probe-side "有 N 项等待你的回复" row is stale the moment they see
        // the questions here.
        taskNotifier.cancelPending(applicationContext)
        refreshKeepaliveRow()
    }

    /**
     * Page → shell task accounting, feeding the keep-alive row's running /
     * completed figures. The events are *incremental*, so the reduce functions
     * (floor-at-zero, grow-until-consumed) live in [KeepaliveStatusPolicy] to
     * stay unit-tested; here only the prefs write and the row nudge remain.
     * A page restart is handled by clearing the running count when a new main
     * document starts ([ShellWebViewClient.onPageStarted]) — the page re-asserts
     * its running tasks after reconnect.
     */
    private fun onTaskStarted() {
        val current = preferences.getInt(ZcodeKeepaliveService.PREF_RUNNING_COUNT, 0)
        preferences.edit()
            .putInt(
                ZcodeKeepaliveService.PREF_RUNNING_COUNT,
                KeepaliveStatusPolicy.nextRunning(current, started = true),
            )
            .apply()
        refreshKeepaliveRow()
    }

    private fun onTaskFinished() {
        val p = preferences
        val current = p.getInt(ZcodeKeepaliveService.PREF_RUNNING_COUNT, 0)
        p.edit()
            .putInt(
                ZcodeKeepaliveService.PREF_RUNNING_COUNT,
                KeepaliveStatusPolicy.nextRunning(current, started = false),
            )
            .putInt(
                ZcodeKeepaliveService.PREF_COMPLETED_COUNT,
                KeepaliveStatusPolicy.nextCompletedUnread(
                    p.getInt(ZcodeKeepaliveService.PREF_COMPLETED_COUNT, 0),
                    finishedTaskSeen = true,
                ),
            )
            .apply()
        refreshKeepaliveRow()
    }

    /** Nudges the keep-alive service to rebuild its status row from prefs. */
    private fun refreshKeepaliveRow() {
        runCatching {
            startService(
                Intent(this, ZcodeKeepaliveService::class.java).apply {
                    action = ZcodeKeepaliveService.ACTION_REFRESH
                },
            )
        }
    }

    /**
     * Asks for the notification permission from a *visible* screen only: a
     * background page must never open a system dialog over another app
     * (dsh-mobile has the same rule). Asked at most once.
     */
    private fun requestNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (taskNotifier.canNotify()) return
        // Count *answered* prompts, not attempts: marking the request before it
        // is answered meant one accidental "don't allow" silenced the shell
        // forever. Android stops showing the dialog after repeated denials, so
        // the bound plus the rationale check is what the platform itself does.
        val prompts = preferences.getInt(PREF_NOTIFICATION_PROMPTS, 0)
        if (prompts >= MAX_NOTIFICATION_PROMPTS) return
        if (prompts > 0 &&
            !shouldShowRequestPermissionRationale(android.Manifest.permission.POST_NOTIFICATIONS)
        ) {
            return
        }
        preferences.edit().putInt(PREF_NOTIFICATION_PROMPTS, prompts + 1).apply()
        // Deferred to the first frame: enterWebMode also runs from onCreate, and
        // a runtime permission request is only reliably delivered once the
        // Activity is actually visible. The outcome is consumed implicitly on the
        // next call (checkSelfPermission / rationale), so no result override is
        // needed to keep state correct.
        window.decorView.post { taskNotifier.requestPermissionIfNeeded() }
    }

    /**
     * The one hook every visible entry screen calls once per showing: each
     * prompt below owns its own gates (notification grant state / battery
     * exemption state, per-prompt counters, dismissal), so an early-out in one
     * must never swallow the other.
     */
    private fun requestShellPermissionsOnce() {
        window.decorView.post {
            requestNotificationPermissionOnce()
            maybePromptBatteryOptimization()
        }
    }

    // --- battery-optimization exemption --------------------------------------

    /**
     * Asks the system to exempt the app from battery optimization (the
     * "电量白名单"): without it, aggressive ROMs freeze or kill the background
     * process and the whole keep-alive + completion-notification chain dies,
     * which is exactly what the user is being asked to allow here.
     *
     * The flow is deliberately gentle:
     *  - the system dialog itself is only opened from a visible screen, after
     *    a shell dialog explained *why* (one tap = 同意, the user stays in
     *    control; the vendor's own switches stay manual);
     *  - declined prompts stay bounded ([PermissionPolicy.MAX_PROMPTS] total,
     *    mirroring the POST_NOTIFICATIONS gate) and an explicit "不再提醒"
     *    silences the flow for good — the devices screen's permission card
     *    remains the manual re-entry.
     *
     * The request intent (ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS) needs
     * the REQUEST_IGNORE_BATTERY_OPTIMIZATIONS manifest declaration; it is
     * acceptable for this self-signed, personally distributed build only.
     */
    private fun maybePromptBatteryOptimization() {
        if (isIgnoringBatteryOptimizations()) return
        val prompts = preferences.getInt(PREF_BATTERY_PROMPTS, 0)
        val dismissed = preferences.getBoolean(PREF_BATTERY_PROMPT_DISMISSED, false)
        if (!PermissionPolicy.shouldPrompt(prompts, dismissed)) return
        preferences.edit().putInt(PREF_BATTERY_PROMPTS, PermissionPolicy.nextPromptCount(prompts)).apply()
        ShellDialogs.show(
            context = this,
            palette = palette(),
            title = getString(R.string.battery_prompt_title),
            message = PermissionPolicy.BATTERY_PROMPT_EXPLANATION,
            primaryText = getString(R.string.battery_prompt_go),
            onPrimary = { dialog ->
                dialog.dismiss()
                launchBatteryExemptionRequest()
            },
            secondaryText = getString(R.string.battery_prompt_dismiss),
            onSecondary = { dialog ->
                dialog.dismiss()
                // An explicit "不再提醒" outweighs the prompt counter forever.
                preferences.edit().putBoolean(PREF_BATTERY_PROMPT_DISMISSED, true).apply()
            },
        )
    }

    /**
     * True when the system already exempts the app from battery optimization
     * (user granted it, or the ROM never applies one). Best-effort: a failure
     * reads as "not exempt" so the card keeps offering the request.
     */
    private fun isIgnoringBatteryOptimizations(): Boolean = runCatching {
        val power = getSystemService(android.os.PowerManager::class.java) ?: return@runCatching false
        power.isIgnoringBatteryOptimizations(packageName)
    }.getOrDefault(false)

    /**
     * Opens the system exemption dialog. Returns false when this ROM refuses
     * the activity even with the declaration (OEM rewrites do): the caller
     * falls back to the app-info page, where an equivalent switch lives.
     */
    private fun launchBatteryExemptionRequest(): Boolean = runCatching {
        startActivity(
            Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:$packageName")),
        )
    }.isSuccess

    /**
     * The application-details page: the shell's one reachable system surface
     * for everything without a public API (autostart, 后台高耗电, notification
     * and battery switches on rewritten ROMs).
     */
    private fun openAppInfoSettings() {
        runCatching {
            startActivity(
                Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:$packageName")),
            )
        }
    }

    // --- server reachability -------------------------------------------------

    /**
     * Probes the device origin over HTTP from native code. This is the only
     * signal that distinguishes "the app opened the page" from "the server is
     * actually there": with no network the page still paints from its Service
     * Worker cache, so the shell would otherwise leave the user on the page's
     * own WebSocket error card with no native way out.
     *
     * A failure raises the native retry / back-to-device-list screen (the same
     * behaviour dsh-mobile has); recovery dismisses it automatically, and while
     * it is up the probe keeps re-running so the page returns as soon as the
     * server is reachable again.
     */
    private fun probeReachability() {
        val view = webView ?: return
        view.removeCallbacks(reprobe)
        val origin = allowedOrigin ?: return
        runCatching { probeExecutor.execute {
            val reachable = try {
                val connection = java.net.URL("$origin/").openConnection() as java.net.HttpURLConnection
                connection.requestMethod = "GET"
                connection.connectTimeout = PROBE_TIMEOUT_MS
                connection.readTimeout = PROBE_TIMEOUT_MS
                connection.useCaches = false
                connection.instanceFollowRedirects = false
                connection.setRequestProperty("Cache-Control", "no-cache")
                val code = connection.responseCode
                connection.disconnect()
                // Any HTTP status (including 401/404) proves the origin answers.
                code in 100..599
            } catch (e: Exception) {
                false
            }
            view.post {
                if (mode != Mode.WEB) return@post
                if (!reachable && !pageCommitted && !reachabilityFailed) {
                    // The page never painted and the origin does not answer: this
                    // is a dead load, not a page-level failure.
                    reachabilityFailed = true
                    showErrorPage(true)
                }
                // Keep watching while the error screen is up: the page's own
                // "state:ok" (or a successful commit) dismisses it.
                if (currentLoadStateView != null &&
                    LoadStatePolicy.dismissibleOnErrorDismiss(currentLoadStateKind)
                ) {
                    view.postDelayed(reprobe, REPROBE_INTERVAL_MS)
                }
            }
        } }  // end probe task (guarded: the executor may be shut down)
    }

    // --- in-app error page ---------------------------------------------------

    /**
     * Toggles the failed state of the shared load-state view (see
     * [showLoadingState]) over the WebView slot. The WebView instance is never
     * destroyed or reloaded by this: when the network returns, the user taps
     * 重试 and the same document loads again. A shown loading state is never
     * cleared by a dismissal (`show = false`) — the page fires those on every
     * main-frame start, and the overlay must survive mid-load.
     */
    private fun showErrorPage(
        show: Boolean,
        titleRes: Int = R.string.error_page_title,
        bodyRes: Int = R.string.error_page_body,
        retryLabelRes: Int = R.string.error_page_retry,
        onRetry: (() -> Unit)? = null,
    ) {
        if (mode != Mode.WEB) return
        if (!show) {
            // A *loading* view is not a failure: leave it up.
            if (!LoadStatePolicy.dismissibleOnErrorDismiss(currentLoadStateKind)) return
            hideLoadState()
            return
        }
        val slot = findViewById<FrameLayout>(R.id.web_slot) ?: return
        showLoadState(LoadStatePolicy.Kind.FAILED)
        // The view is reused in place: refresh copy and the secondary label so a
        // revoked screen does not keep the generic network text.
        val view = currentLoadStateView ?: return
        view.findViewById<TextView>(R.id.load_state_title).setText(titleRes)
        view.findViewById<TextView>(R.id.load_state_body).setText(bodyRes)
        view.findViewById<Button>(R.id.load_state_secondary).setText(retryLabelRes)
        loadStateRetryAction = onRetry
    }

    // --- back key ----------------------------------------------------------

    private fun handleBack() {
        hideImeIfVisible()
        when (mode) {
            // Add-device form: go back to where the user came from, or leave.
            Mode.CONNECT -> {
                val hasDevices = try {
                    store.list().isNotEmpty()
                } catch (e: Exception) {
                    false
                }
                if (savedLink != null || hasDevices) {
                    cancelAddDevice()
                } else {
                    finish()
                }
            }
            Mode.DEVICES -> returnFromDevices()
            Mode.WEB -> handleWebBack()
        }
    }

    // --- devices page ---------------------------------------------------------

    /**
     * Multi-device list modeled on the dsh-mobile paired-device page: every
     * saved ZCode server is one card (name, "page kind · host", status with a
     * colored dot, ⋮ actions, chevron). Tap connects; long-press or ⋮ opens the
     * action sheet; 添加设备 opens the add-device form. Long-pressing the ZCode
     * sidebar in the page also opens this screen via [ThemeChannel].
     */
    private fun showDevices() {
        currentLoadStateView = null
        currentLoadStateKind = null
        reachabilityFailed = false
        mode = Mode.DEVICES
        val p = palette()
        applyWindowChrome(p)
        setContentView(R.layout.activity_devices)
        styleDevicesScreen(p)

        val container = findViewById<ViewGroup>(R.id.devices_container)
        val basePaddingTop = container.paddingTop
        val density = resources.displayMetrics.density
        container.setOnApplyWindowInsetsListener { _, insets ->
            // Header starts below the status bar; the add button clears the
            // navigation bar / keyboard.
            container.setPadding(
                container.paddingLeft,
                basePaddingTop + resolveTopSafeInset(insets),
                container.paddingRight,
                (12 * density).toInt() + resolveWebViewImeInset(insets),
            )
            insetsForWebContent(insets, resolveTopSafeInset(insets))
        }
        container.requestApplyInsets()

        val list = findViewById<android.widget.ListView>(R.id.devices_list)
        val empty = findViewById<View>(R.id.devices_empty)
        val addBtn = findViewById<Button>(R.id.devices_add)

        val devices = try {
            store.list().sortedByDescending { it.lastUsedAt }
        } catch (e: Exception) {
            // Metadata unreadable: same recovery path as a failed restore.
            showConnect(restoreFailed = true)
            return
        }

        addBtn.setOnClickListener { showConnect() }
        renderNotificationSettings()

        if (devices.isEmpty()) {
            list.visibility = View.GONE
            empty.visibility = View.VISIBLE
            return
        }

        empty.visibility = View.GONE
        list.visibility = View.VISIBLE

        val adapter = DeviceListAdapter(
            this,
            devices,
            palette(),
            activeDeviceId,
            deviceExpiresAt = credentialExpiries(devices),
            onOpen = { device -> connectToDevice(device.id) },
            onActions = { device -> showDeviceActions(device.id, device.name, device.origin) },
        )
        list.adapter = adapter
        // Clicks and long-presses are handled inside the row itself (see adapter):
        // a clickable row would swallow ListView item-click callbacks.
        list.setOnItemClickListener(null)
        list.setOnItemLongClickListener(null)
    }

    // --- notification & background settings card ------------------------------

    /**
     * The devices screen's "通知与后台" card, painted like every other shell
     * surface (no system-styled switch/checkbox widgets): toggle rows built
     * from [ShellUi] shapes, prominence picked from two quiet/less-quiet
     * levels, and a permission self-check linking into the system settings.
     */
    private fun renderNotificationSettings() {
        val container = findViewById<LinearLayout>(R.id.devices_settings) ?: return
        container.removeAllViews()
        val p = palette()
        val density = resources.displayMetrics.density

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = ShellUi.rounded(this@MainActivity, p.surface, p.border, radiusDp = 14f)
            setPadding((16 * density).toInt(), (14 * density).toInt(), (16 * density).toInt(), (14 * density).toInt())
        }

        card.addView(
            TextView(this).apply {
                setText(R.string.settings_section_title)
                setTextColor(p.foreground)
                textSize = 15f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
            },
        )

        // 1. Keep-alive switch (default on).
        val keepaliveOn = ZcodeKeepaliveService.isEnabled(preferences)
        card.addView(
            settingsToggleRow(
                p,
                label = getString(R.string.settings_keepalive_toggle),
                summary = getString(R.string.settings_keepalive_toggle_summary),
                checked = keepaliveOn,
                onToggled = { on ->
                    preferences.edit().putBoolean(ZcodeKeepaliveService.PREF_KEEPALIVE_ENABLED, on).apply()
                    if (on) {
                        ZcodeKeepaliveService.ensureStarted(this, preferences)
                    } else {
                        runCatching {
                            startService(
                                Intent(this, ZcodeKeepaliveService::class.java).apply {
                                    action = ZcodeKeepaliveService.ACTION_STOP
                                },
                            )
                        }
                    }
                },
            ),
        )

        // 2. Prominence: 低调 (LOW, default) / 极简 (MIN).
        val current = KeepaliveStatusPolicy.prominenceFromStorage(
            preferences.getString(ZcodeKeepaliveService.PREF_KEEPALIVE_PROMINENCE, null),
        )
        card.addView(
            settingsRadioRow(
                p,
                label = getString(R.string.settings_prominence_title),
                options = listOf(
                    getString(R.string.settings_prominence_low) to KeepaliveStatusPolicy.Prominence.LOW,
                    getString(R.string.settings_prominence_min) to KeepaliveStatusPolicy.Prominence.MIN,
                ),
                selected = current,
                onPicked = { level ->
                    preferences.edit()
                        .putString(
                            ZcodeKeepaliveService.PREF_KEEPALIVE_PROMINENCE,
                            KeepaliveStatusPolicy.storageValue(level),
                        ).apply()
                    // Channel importance is fixed at creation: nudge the
                    // service so it rebuilds the row on the new channel.
                    if (ZcodeKeepaliveService.isEnabled(preferences)) {
                        runCatching {
                            startService(
                                Intent(this, ZcodeKeepaliveService::class.java).apply {
                                    action = ZcodeKeepaliveService.ACTION_REFRESH
                                },
                            )
                        }
                    }
                },
            ),
        )

        // 3. Show completed figure in the status row (default on).
        val showCompleted = preferences.getBoolean(ZcodeKeepaliveService.PREF_SHOW_COMPLETED, true)
        card.addView(
            settingsToggleRow(
                p,
                label = getString(R.string.settings_completed_toggle),
                summary = null,
                checked = showCompleted,
                onToggled = { on ->
                    preferences.edit().putBoolean(ZcodeKeepaliveService.PREF_SHOW_COMPLETED, on).apply()
                    refreshKeepaliveRow()
                },
            ),
        )

        // 4. Permission self-check: notifications + FGS visibility.
        val notificationsOk = taskNotifier.canNotify()
        card.addView(
            settingsLinkRow(
                p,
                label = if (notificationsOk) {
                    getString(R.string.settings_permission_notifications_ok)
                } else {
                    getString(R.string.settings_permission_notifications_blocked)
                },
                action = if (!notificationsOk) {
                    getString(R.string.settings_open_system_settings)
                } else {
                    null
                },
                onClick = {
                    runCatching {
                        startActivity(
                            Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName),
                        )
                    }
                },
            ),
        )
        val fgsOk = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ can revoke FGS starts; the service records a hard stop
            // via the notification action. A restricted state shows the hint.
            ZcodeKeepaliveService.isEnabled(preferences)
        } else {
            true
        }
        card.addView(
            settingsLinkRow(
                p,
                label = if (fgsOk) {
                    getString(R.string.settings_permission_fgs_ok)
                } else {
                    getString(R.string.settings_permission_fgs_blocked)
                },
                action = if (!fgsOk) {
                    getString(R.string.settings_open_system_settings)
                } else {
                    null
                },
                onClick = {
                    runCatching {
                        startActivity(
                            Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                                .setData(Uri.parse("package:$packageName")),
                        )
                    }
                },
            ),
        )

        // 5. Battery-optimization exemption ("电量白名单"): the gate the vendor
        // ROMs actually honour. Hidden once granted; while missing it offers
        // the system request again (the prompt-counter bound only guards the
        // automatic flow, never this manual re-entry).
        if (!isIgnoringBatteryOptimizations()) {
            card.addView(
                settingsLinkRow(
                    p,
                    label = getString(R.string.settings_battery_blocked),
                    action = getString(R.string.settings_battery_action),
                    onClick = {
                        if (!launchBatteryExemptionRequest()) {
                            // This ROM refuses the request activity: the app
                            // info page is where the equivalent switch lives.
                            openAppInfoSettings()
                        }
                    },
                ),
            )
        }

        // 6. App info / vendor autostart: vivo 等的"自启动 / 后台高耗电"没有
        // 公开 API，只能打开应用信息页并说明要手动开什么（[PermissionPolicy.
        // SETTINGS_HINT] 为摘要文案）。
        card.addView(
            settingsLinkRow(
                p,
                label = getString(R.string.settings_app_info),
                action = getString(R.string.settings_app_info_action),
                onClick = { openAppInfoSettings() },
            ),
        )

        container.addView(
            card,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
    }

    /** One switch-styled row: label + summary, tap anywhere flips it. */
    private fun settingsToggleRow(
        p: ShellPalette,
        label: String,
        summary: String?,
        checked: Boolean,
        onToggled: (Boolean) -> Unit,
    ): View {
        var state = checked
        val headline = TextView(this).apply {
            text = label
            setTextColor(p.foreground)
            textSize = 14f
        }
        val stateMark = TextView(this).apply {
            text = if (state) "●" else "○"
            setTextColor(if (state) p.success else p.secondary)
            textSize = 18f
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = ShellUi.rippleOver(
                this@MainActivity,
                p.border,
                ShellUi.rounded(this@MainActivity, p.background, p.border, radiusDp = 10f),
            )
            setPadding(dp(14), dp(11), dp(14), dp(11))
            setOnClickListener {
                state = !state
                stateMark.text = if (state) "●" else "○"
                stateMark.setTextColor(if (state) p.success else p.secondary)
                onToggled(state)
            }
        }
        val line = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
        }
        line.addView(
            headline,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        line.addView(stateMark)
        row.addView(line)
        if (summary != null) {
            row.addView(
                TextView(this).apply {
                    text = summary
                    setTextColor(p.secondary)
                    textSize = 12f
                    setLineSpacing(0f, 1.3f)
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = dp(4) },
            )
        }
        return row
    }

    /** Two radio-styled options under a heading. */
    private fun settingsRadioRow(
        p: ShellPalette,
        label: String,
        options: List<Pair<String, KeepaliveStatusPolicy.Prominence>>,
        selected: KeepaliveStatusPolicy.Prominence,
        onPicked: (KeepaliveStatusPolicy.Prominence) -> Unit,
    ): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(11), dp(14), dp(11))
        }
        row.addView(
            TextView(this).apply {
                text = label
                setTextColor(p.foreground)
                textSize = 14f
            },
        )
        options.forEach { (optionText, level) ->
            val isOn = level == selected
            row.addView(
                TextView(this).apply {
                    setText((if (isOn) "◉ " else "○ ") + optionText)
                    setTextColor(if (isOn) p.foreground else p.secondary)
                    textSize = 13f
                    background = ShellUi.rippleOver(
                        this@MainActivity,
                        p.border,
                        ShellUi.rounded(this@MainActivity, p.background, p.border, radiusDp = 8f),
                    )
                    setPadding(dp(8), dp(7), dp(8), dp(7))
                    setOnClickListener {
                        onPicked(level)
                        // Repaint the whole card so the selection mark moves.
                        renderNotificationSettings()
                    }
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = dp(6) },
            )
        }
        return row
    }

    /** Status line with an optional "open settings" affordance. */
    private fun settingsLinkRow(
        p: ShellPalette,
        label: String,
        action: String?,
        onClick: (() -> Unit)?,
    ): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            background = if (onClick != null) {
                ShellUi.rippleOver(
                    this@MainActivity,
                    p.border,
                    ShellUi.rounded(this@MainActivity, p.background, p.border, radiusDp = 10f),
                )
            } else {
                null
            }
            setPadding(dp(14), dp(11), dp(14), dp(11))
            if (onClick != null) setOnClickListener { onClick() }
        }
        row.addView(
            TextView(this).apply {
                text = label
                setTextColor(if (action == null) p.success else p.secondary)
                textSize = 13f
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        if (action != null) {
            row.addView(
                TextView(this).apply {
                    text = action
                    setTextColor(p.accent)
                    textSize = 13f
                },
            )
        }
        return row
    }

    /**
     * Device-expiry lookup for the list's temporary-device marker: one Keystore
     * load per saved device, recomputed on every show so a freshly paired or
     * revoked device is never shown stale. A slot that fails to decrypt is
     * simply absent — the marker disappears, never a crash in list rendering.
     */
    private fun credentialExpiries(devices: List<DeviceStore.DeviceMeta>): Map<String, Long> {        val map = HashMap<String, Long>(devices.size)
        for (device in devices) {
            val credential = loadCredential(device.id) ?: continue
            if (credential.expiresAt > 0L) map[device.id] = credential.expiresAt
        }
        return map
    }

    /** Action sheet for a device: connect / rename / edit address / delete. */
    private fun showDeviceActions(id: String, name: String, origin: String) {
        val options = listOf(
            getString(R.string.device_action_connect),
            getString(R.string.device_pair_action),
            getString(R.string.device_rename),
            getString(R.string.device_edit_address),
            getString(R.string.device_delete),
        )
        ShellDialogs.showOptions(
            context = this,
            palette = palette(),
            title = "$name\n$origin",
            options = options,
            onPick = { which, dialog ->
                dialog.dismiss()
                when (which) {
                    0 -> connectToDevice(id)
                    1 -> showPairingDialog(id)
                    2 -> showRenameDialog(id, name)
                    3 -> showEditAddressDialog(id, name)
                    4 -> confirm(
                        titleRes = R.string.device_delete_confirm_title,
                        messageRes = R.string.device_delete_confirm_message,
                    ) {
                        try {
                            store.delete(id)
                        } catch (e: Exception) {
                            toast(getString(R.string.device_store_unreadable))
                        }
                        // Drop the device credential too: leaving it behind would
                        // keep a live 90-day secret for a device the user removed.
                        dropCredential(id)
                        if (activeDeviceId == id) {
                            activeDeviceId = null
                            savedLink = null
                            allowedOrigin = null
                            destroyWebView()
                        }
                        showDevices()
                    }
                }
            },
        )
    }

    /**
     * Edits a saved device's entry link in place.
     *
     * The add form never had an edit path, so replacing a stale link (for example
     * the legacy `?token=…` URL the server now routes to the pairing page even
     * when the session cookie is valid) meant deleting and re-adding the device —
     * or keeping two entries for the same origin, which share one cookie jar.
     * The name is untouched here; renaming stays its own action.
     */
    private fun showEditAddressDialog(id: String, currentName: String) {
        val currentLink = try {
            store.linkOf(id)
        } catch (e: Exception) {
            toast(getString(R.string.device_store_unreadable))
            return
        } ?: return

        val p = palette()
        val input = EditText(this).apply {
            setText(currentLink)
            setSelection(text.length)
            hint = getString(R.string.device_edit_address_hint)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_VARIATION_URI
            maxLines = 1
            background = ShellUi.input(this@MainActivity, p)
            setTextColor(p.foreground)
            setHintTextColor(p.secondary)
            setPadding(dp(14), dp(12), dp(14), dp(12))
        }
        val error = TextView(this).apply {
            setTextColor(p.error)
            textSize = 13f
            visibility = View.GONE
            setPadding(0, dp(8), 0, 0)
        }
        val wrapper = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        wrapper.addView(
            input,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        wrapper.addView(
            error,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )

        // Validation must not dismiss the dialog: the handler checks first and
        // keeps the card up on a bad link.
        ShellDialogs.show(
            context = this,
            palette = p,
            title = getString(R.string.device_edit_address),
            contentView = wrapper,
            primaryText = getString(R.string.action_confirm),
            onPrimary = { dialog ->
                val result = EntryLinkPolicy.validate(input.text?.toString())
                if (!result.valid) {
                    error.text = result.error ?: EntryLinkPolicy.ERROR_LINK_INVALID
                    error.visibility = View.VISIBLE
                    return@show
                }
                val link = result.url ?: return@show
                val origin = originFromResult(result) ?: return@show
                val kind = if (result.path == EntryLinkPolicy.WEB_REMOTE_PATH) "remote" else "direct"
                try {
                    store.save(currentName, link, origin, kind, id)
                } catch (e: Exception) {
                    error.text = getString(R.string.connect_save_failed)
                    error.visibility = View.VISIBLE
                    return@show
                }
                dialog.dismiss()
                // The edited device only takes effect by reloading it; the other
                // entries just refresh their row (origin may have changed).
                if (activeDeviceId == id) connectToDevice(id) else showDevices()
            },
            secondaryText = getString(R.string.action_cancel),
            onSecondary = { dialog -> dialog.dismiss() },
        )
    }

    private fun showRenameDialog(id: String, currentName: String) {
        // Themed input matching the add-device form so the dialog belongs to the
        // same visual language as the rest of the shell.
        val p = palette()
        val input = EditText(this).apply {
            setText(currentName)
            setSelection(text.length)
            hint = getString(R.string.device_rename_hint)
            inputType = android.text.InputType.TYPE_CLASS_TEXT
            maxLines = 1
            background = ShellUi.input(this@MainActivity, p)
            setTextColor(p.foreground)
            setHintTextColor(p.secondary)
            setPadding(dp(14), dp(12), dp(14), dp(12))
        }
        val wrapper = LinearLayout(this)
        wrapper.addView(
            input,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )

        ShellDialogs.show(
            context = this,
            palette = p,
            title = getString(R.string.device_rename),
            contentView = wrapper,
            primaryText = getString(R.string.action_confirm),
            onPrimary = { dialog ->
                val newName = input.text.toString().trim()
                if (newName.isNotEmpty()) {
                    try {
                        val device = store.list().find { it.id == id }
                        if (device != null) {
                            val link = store.linkOf(id) ?: return@show
                            store.save(newName, link, device.origin, device.kind, id)
                        }
                    } catch (e: Exception) {
                        toast(getString(R.string.device_store_unreadable))
                    }
                    showDevices()
                }
                dialog.dismiss()
            },
            secondaryText = getString(R.string.action_cancel),
            onSecondary = { dialog -> dialog.dismiss() },
        )
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    /** Connects to a specific device by loading its link into the WebView. */
    private fun connectToDevice(id: String) {
        // Every store access can throw StoreException (Keystore key invalidated,
        // payload unreadable). Callers reach this from list clicks and the launch
        // path, so a failure must degrade to a message, never crash the shell.
        val device = try {
            store.list().find { it.id == id } ?: return
        } catch (e: Exception) {
            toast(getString(R.string.device_store_unreadable))
            showConnect(restoreFailed = true)
            return
        }
        val link = try {
            store.linkOf(id) ?: return
        } catch (e: Exception) {
            toast(getString(R.string.device_store_unreadable))
            showConnect(restoreFailed = true)
            return
        }
        val result = EntryLinkPolicy.validate(link)
        if (!result.valid) return

        // Update last-used timestamp only (metadata rewrite, no crypto cycle).
        try {
            store.touch(id)
        } catch (e: Exception) {
            // Best-effort bookkeeping: connecting can proceed without it.
        }

        activeDeviceId = id
        savedLink = link
        val origin = originFromResult(result)
        allowedOrigin = origin
        connectionId += 1
        uploadRequests.invalidate()

        // A stored credential means the native client owns the session: renew it
        // and inject the cookies before the page loads. Without one (server not
        // on the device-credential model yet) the link path stays as before.
        val credential = loadCredential(id)
        if (credential != null && origin != null) {
            // The page flow has verified this (token, origin) pair — publish it
            // for the keep-alive probe so it never diverges from what the page
            // is actually using (memory-held credential vs the probe's per-tick
            // Keystore decrypt, which transient failures would break).
            ProbeTargetCache.put(credential.deviceToken, origin)
            renewThenLoad(id, origin, credential)
            return
        }

        // No usable shell-side credential, but the origin is now live in the
        // WebView and the page will self-heal its session through the renewal
        // cookie (or an in-page pairing). Publish the origin so the keep-alive
        // probe's cookie fallback targets the right jar — without this the
        // probe reports "未配对" forever while chat works.
        ZcodeKeepaliveService.ActivityOriginBridge.activeOrigin = origin
        destroyWebView()
        enterWebMode()
    }

    private fun returnFromDevices() {
        val latest = try {
            store.list().maxByOrNull { it.lastUsedAt }
        } catch (e: Exception) {
            null
        }
        if (latest != null) {
            connectToDevice(latest.id)
        } else {
            showConnect()
        }
    }

    private fun handleWebBack() {
        val view = webView ?: run {
            moveTaskToBack(true)
            return
        }

        // The page never loaded: back must lead somewhere useful, not to a
        // blank screen or out of the app.
        if (!pageCommitted) {
            hideLoadState()
            showDevices()
            return
        }

        val history = view.copyBackForwardList()
        if (view.canGoBack() && history.currentIndex > 0) {
            val previousUrl = history.getItemAtIndex(history.currentIndex - 1).url
            val previousOrigin = originFromUrl(previousUrl)
            if (previousOrigin != null &&
                EntryLinkPolicy.isSameOrigin(allowedOrigin, previousOrigin)
            ) {
                view.goBack()
                return
            }
        }
        // A page whose server was unreachable has no history worth walking:
        // back leads to the device list instead of a dead screen.
        if (reachabilityFailed) {
            showDevices()
            return
        }
        // Otherwise background the task. Never reload or leave the same-origin
        // document.
        moveTaskToBack(true)
    }

    @Suppress("DEPRECATION")
    private fun hideImeIfVisible() {
        currentFocus?.let { focus ->
            (getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)
                ?.hideSoftInputFromWindow(focus.windowToken, 0)
        }
    }

    /**
     * Shared main-frame routing for both the current WebView and the
     * throwaway one that harvests a window.open target (see
     * [onCreateWindow]). Same-origin targets load in the given WebView;
     * everything external is refused there and [openExternally] decides.
     */
    private fun routeMainFrameTarget(view: WebView, target: String, hasGesture: Boolean): Boolean {
        val uri = try {
            URI(target)
        } catch (e: Exception) {
            return true // unparsable target: refuse
        }

        val scheme = uri.scheme?.lowercase()
        val candidateOrigin = originFromUrl(target)

        // Same origin stays in the WebView regardless of gesture.
        if (candidateOrigin != null &&
            EntryLinkPolicy.isSameOrigin(allowedOrigin, candidateOrigin)
        ) {
            return false
        }

        // A long-press inside an active text selection would pop the shell's
        // link confirmation over the system selection menu, killing 复制/分享.
        // Selection wins: while the selection ActionMode is up the shell
        // refuses the external-link dialog (return true = consume) so the
        // system menu keeps operating. Normal taps are unaffected — by then
        // the selection menu has been dismissed and currentActionMode is
        // null. Only the main WebView is guarded: the throwaway window.open
        // harvester never hosts a selection.
        if (view === webView && isViewSelectingText(view)) return true

        // Everything not same-origin is external: HTTPS only, no credentials
        // in query, then a host-only confirmation.
        if (scheme != "https") return true
        if (EntryLinkPolicy.hasCredentialInQuery(target)) return true
        openExternally(target, uri, hasGesture)
        return true
    }

    /**
     * True while the WebView shows text-selection UI. The signal is the
     * selection ActionMode: the platform starts one whenever a selection
     * exists (floating or inserted), and stops it when the selection goes
     * away. Recorded by the Activity's own start/stop callbacks — no JS probe
     * needed, and the answer stays synchronous for [routeMainFrameTarget].
     */
    private var currentActionMode: android.view.ActionMode? = null

    override fun onActionModeStarted(mode: android.view.ActionMode?) {
        currentActionMode = mode
        super.onActionModeStarted(mode)
    }

    override fun onActionModeFinished(mode: android.view.ActionMode?) {
        if (currentActionMode === mode) currentActionMode = null
        super.onActionModeFinished(mode)
    }

    /** True when the WebView's text-selection menu is up (selection active). */
    private fun isViewSelectingText(view: WebView): Boolean = currentActionMode != null

    /**
     * Confirmation dialog for an https target outside the app's origin, then
     * the system browser. Never called with same-origin or credential-bearing
     * URLs — [routeMainFrameTarget] screens those.
     */
    private fun openExternally(target: String, uri: URI, hasGesture: Boolean) {
        val targetHost = uri.host ?: return
        if (!hasGesture) return
        ShellDialogs.show(
            context = this,
            palette = palette(),
            title = getString(R.string.external_confirm_title),
            message = getString(R.string.external_confirm_message, targetHost),
            primaryText = getString(R.string.action_confirm),
            onPrimary = { dialog ->
                dialog.dismiss()
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target)))
                } catch (e: Exception) {
                    // No browser available; nothing to do.
                }
            },
            secondaryText = getString(R.string.action_cancel),
            onSecondary = { dialog -> dialog.dismiss() },
        )
    }

    // --- navigation policy ---------------------------------------------------

    /**
     * Builds the app-origin string ("https://host[:port]") for a validated link.
     */
    private fun originFromResult(result: EntryLinkPolicy.Result): String? {
        val host = result.host ?: return null
        val scheme = result.scheme ?: return null
        // Lowercased like originFromUrl: java.net.URI keeps the input's case, and
        // the WebView origin allowlist compares these strings.
        return scheme + "://" + host.lowercase() + (result.port?.let { ":$it" } ?: "")
    }

    /** Best-effort origin string for an arbitrary URL; null when unparsable. */
    private fun originFromUrl(url: String?): String? {
        if (url.isNullOrBlank()) return null
        val uri = try {
            URI(url)
        } catch (e: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        val port = uri.port
        return scheme + "://" + host + if (port != -1) ":$port" else ""
    }

    private fun confirm(titleRes: Int, messageRes: Int, onConfirmed: () -> Unit) {
        ShellDialogs.show(
            context = this,
            palette = palette(),
            title = getString(titleRes),
            message = getString(messageRes),
            primaryText = getString(R.string.action_confirm),
            onPrimary = { dialog ->
                dialog.dismiss()
                onConfirmed()
            },
            secondaryText = getString(R.string.action_cancel),
            onSecondary = { dialog -> dialog.dismiss() },
        )
    }

    private fun injectScrollbarCompat(view: WebView) {
        if (mode != Mode.WEB) return
        view.evaluateJavascript(SCROLLBAR_COMPAT_JS, null)
        view.evaluateJavascript(ThemeChannel.PAGE_SIDE_JS, null)
    }

    // --- live page theme → shell chrome ---------------------------------------

    /**
     * Single dispatcher for page → shell messages, used by both delivery paths
     * (console message and WebMessage listener), so a duplicate delivery of the
     * same message is harmless. Parsing rules live in [ShellMessagePolicy];
     * unknown messages are ignored so older/newer page bundles never crash or
     * surprise the shell.
     */
    private fun handleShellMessage(text: String) {
        when (val message = ShellMessagePolicy.parse(text)) {
            is ShellMessagePolicy.ShellMessage.Theme ->
                applyPageTheme(text.removePrefix("theme:").startsWith("dark"),
                    text.removePrefix("theme:").substringAfter(':', ""))

            ShellMessagePolicy.ShellMessage.Devices -> if (mode == Mode.WEB) showDevices()
            is ShellMessagePolicy.ShellMessage.Notify ->
                handleTaskNotification(message.json)

            // The page answered/handled the pending interaction outside the
            // notification (the user opened the app): drop the stale entry.
            ShellMessagePolicy.ShellMessage.NotifyClear -> taskNotifier.cancel()

            // The user has seen the finished tasks in the app: reset the
            // unread-completed counter feeding the keep-alive status row.
            ShellMessagePolicy.ShellMessage.TasksConsumed -> onTasksConsumed()

            // Task accounting (parameterless, incremental): keep the keep-alive
            // row's running/completed figures in step with the page's task list.
            ShellMessagePolicy.ShellMessage.TaskStarted -> onTaskStarted()
            ShellMessagePolicy.ShellMessage.TaskFinished -> onTaskFinished()

            // The page reports its own bootstrap failure (it cannot reach the
            // server). Hand the user the native retry / device-list screen;
            // a later "ok" means the page recovered and the screen goes away.
            ShellMessagePolicy.ShellMessage.StateFailed -> if (mode == Mode.WEB) showErrorPage(true)
            ShellMessagePolicy.ShellMessage.StateOk -> if (mode == Mode.WEB) {
                reachabilityFailed = false
                showErrorPage(false)
            }

            ShellMessagePolicy.ShellMessage.Ignore -> Unit
        }
    }

    /**
     * Applies the live page theme to the shell. The rendered page background is
     * the authoritative signal: dark/light is derived from its luminance (the
     * page's own class name is only a fallback when the colour is unparsable),
     * which keeps the shell correct in the page's "system/auto" theme mode too.
     * The strip colour and the palette choice are persisted so the next launch
     * paints correctly before the page has reported.
     */
    private fun applyPageTheme(reportedDark: Boolean, colorRgb: String) {
        val color = parseRgb(colorRgb)
        val dark = color?.let { !ShellPalette.isLight(it) } ?: reportedDark
        val themeChanged = dark != pageIsDark
        if (themeChanged) {
            pageIsDark = dark
            preferences.edit().putBoolean(PREF_PAGE_IS_DARK, dark).apply()
        }
        if (color != null && color != pageThemeColor) {
            pageThemeColor = color
            preferences.edit().putInt(PREF_PAGE_THEME_COLOR, color).apply()
            currentBackdrop?.setBackgroundColor(color)
            applyStatusBarIconsFor(color)
        }
        // Repaint the shell screen in place — no re-inflation, so text already
        // typed into the add-device form survives a live theme change.
        if (themeChanged && mode != Mode.WEB) restyleCurrentScreen()
    }

    /**
     * Status-bar glyph contrast from the strip color, using the same luminance
     * rule as the dsh-mobile shell (StatusBarChrome.kt): light background →
     * dark glyphs, dark background → light glyphs.
     *
     * Uses WindowInsetsControllerCompat: the legacy decorView.systemUiVisibility
     * LIGHT_STATUS_BAR flag is ignored on Android 11+ once the window is
     * edge-to-edge (setDecorFitsSystemWindows(false)), which is why the status
     * bar previously kept dark glyphs on the dark page.
     */
    private fun applyStatusBarIconsFor(color: Int) {
        val lightBackground = ShellPalette.isLight(color)
        runCatching {
            WindowCompat.getInsetsController(window, window.decorView)
                .isAppearanceLightStatusBars = lightBackground
        }
    }

    /** Parses "rgb(22, 22, 22)" into an ARGB int; null when unparsable. */
    private fun parseRgb(rgb: String): Int? {
        val m = Regex("rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)").find(rgb) ?: return null
        val (r, g, b) = m.destructured
        return try {
            android.graphics.Color.argb(0xFF, r.toInt(), g.toInt(), b.toInt())
        } catch (e: NumberFormatException) {
            null
        }
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    // --- WebView clients -----------------------------------------------------

    private inner class ShellWebViewClient : WebViewClient() {

        override fun onPageCommitVisible(view: WebView, url: String?) {
            super.onPageCommitVisible(view, url)
            // First paint of the real document: drop the connecting fallback, and
            // persist cookies now — a login established by this page load must
            // survive an immediate kill.
            onPageCommitted()
            flushCookies()
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            super.onPageStarted(view, url, favicon)
            // A successful navigation attempt always brings the real page back.
            showErrorPage(false)
            // A fresh main document means the page's task-list state restarts:
            // drop the running count so the page's baseline re-assert never
            // double-counts (the events are incremental). Per the agreed
            // protocol the page sends one `task-started` per still-running
            // task when its baseline frame lands (see useTaskNotifications),
            // so the row recovers as soon as the page finishes booting —
            // until then it truthfully shows idle. Completed-unread survives;
            // it only clears when the user actually sees the tasks
            // (tasks-consumed).
            preferences.edit()
                .putInt(ZcodeKeepaliveService.PREF_RUNNING_COUNT, 0)
                .apply()
            refreshKeepaliveRow()
            // Apply at document-start of every main-frame navigation so the
            // scrollbars never flash in (evaluateJavascript runs after paint).
            injectScrollbarCompat(view)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            super.onPageFinished(view, url)
            // A finished load means the fallback is no longer needed, even if
            // onPageCommitVisible never fired on this WebView version.
            onPageCommitted()
            flushCookies()
            // Re-assert: SPA soft-reconnects rebuild the DOM without a
            // navigation, so re-apply the <style> element on every load event.
            injectScrollbarCompat(view)
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError,
        ) {
            // Only a failed main frame is a real "cannot connect"; subresource
            // failures (tracking pixels, slow assets) must not mask the page.
            if (request.isForMainFrame) {
                hideLoadState()
                showErrorPage(true)
            }
        }

        override fun onReceivedHttpError(
            view: WebView,
            request: WebResourceRequest,
            errorResponse: WebResourceResponse,
        ) {
            if (request.isForMainFrame) {
                hideLoadState()
                showErrorPage(true)
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val target = request.url?.toString() ?: return true
            return routeMainFrameTarget(view, target, request.hasGesture())
        }

        override fun onReceivedSslError(view: WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError) {
            // Never proceed on any certificate error; no logging of details.
            handler.cancel()
        }

        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            // Consume the event, rebuild the WebView from the saved link.
            if (view === webView) {
                destroyWebView()
                savedLink?.let {
                    enterWebMode()
                    toast(getString(R.string.renderer_recovered))
                }
            }
            return true
        }
    }

    private inner class ShellWebChromeClient : WebChromeClient() {

        /**
         * Primary page → shell path. Console messages always reach this hook,
         * with no feature detection or origin configuration, so it carries the
         * theme report and the long-press device-list signal even where the
         * WebMessage listener is unavailable. Only our own prefix is consumed;
         * nothing is logged or persisted, and the page's console output is not
         * echoed anywhere.
         */
        override fun onConsoleMessage(message: android.webkit.ConsoleMessage): Boolean {
            val text = message.message()
            if (text != null && text.startsWith(ThemeChannel.CONSOLE_PREFIX)) {
                // Only the app's own document may drive the shell: a page that
                // arrived through a server redirect would otherwise be able to
                // forge notifications or open the device list. Checked against
                // the WebView's current main-frame URL rather than the console
                // message's source id, which is not reliable for scripts
                // injected with evaluateJavascript.
                if (!isTrustedPage()) return super.onConsoleMessage(message)
                handleShellMessage(text.removePrefix(ThemeChannel.CONSOLE_PREFIX))
                return true
            }
            return super.onConsoleMessage(message)
        }

        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            result.cancel()
            return true
        }

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            result.cancel()
            return true
        }

        override fun onJsPrompt(
            view: WebView,
            url: String?,
            message: String?,
            defaultValue: String?,
            result: android.webkit.JsPromptResult,
        ): Boolean {
            result.cancel()
            return true
        }

        /**
         * window.open targets arrive here because the shell never creates a real
         * window: returning true while ignoring the transport swallowed every
         * `_blank` link (openExternal / feedback / community on the page). The
         * target URL is harvested through a throwaway WebView handed to the
         * transport — it is never attached to the view tree and destroyed as
         * soon as it reports the first URL, so its settings never run page
         * scripts. The captured target goes through the same routing as a
         * regular tap: same-origin loads in the main WebView, external https
         * gets the usual confirmation dialog.
         */
        override fun onCreateWindow(
            view: WebView,
            isDialog: Boolean,
            isUserGesture: Boolean,
            resultMsg: android.os.Message?,
        ): Boolean {
            val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return true
            val harvester = WebView(view.context).apply {
                settings.javaScriptEnabled = false
                settings.allowContentAccess = false
                settings.allowFileAccess = false
                settings.blockNetworkLoads = true
                settings.loadsImagesAutomatically = false
                webViewClient = object : WebViewClient() {
                    private var captured = false
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        v.stopLoading()
                        if (!captured) {
                            captured = true
                            val target = request.url?.toString()
                            v.post {
                                v.destroy()
                            }
                            if (target != null) {
                                val uri = try {
                                    URI(target)
                                } catch (e: Exception) {
                                    null
                                }
                                val sameOrigin = uri != null &&
                                    EntryLinkPolicy.isSameOrigin(
                                        allowedOrigin,
                                        originFromUrl(target),
                                    )
                                if (sameOrigin) {
                                    // Same-origin "_blank" target: load it in the
                                    // page's own WebView (isUserGesture carries the
                                    // gesture the standard path loses).
                                    if (isUserGesture) {
                                        view.loadUrl(target)
                                    } else {
                                        routeMainFrameTarget(view, target, hasGesture = false)
                                    }
                                } else if (uri != null) {
                                    // External: same screen as a direct tap; the
                                    // confirmation itself guards against no-gesture
                                    // abuse, so the gesture flag is not required.
                                    openExternally(target, uri, hasGesture = true)
                                }
                            }
                        }
                        return true
                    }
                }
            }
            transport.webView = harvester
            resultMsg.sendToTarget()
            return true
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread { request.deny() }
        }

        override fun onGeolocationPermissionsShowPrompt(
            origin: String?,
            callback: android.webkit.GeolocationPermissions.Callback,
        ) {
            callback.invoke(origin, false, false)
        }

        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            // Any previously pending request is dead once a new one arrives.
            uploadRequests.invalidate()
            val id = uploadRequests.begin(callback, connectionId)
            if (id == null) {
                callback.onReceiveValue(null)
                return true
            }
            val multiple = WebFiles.allowsMultiple(params.mode)
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = WebFiles.ACCEPT_TYPE
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
            }
            return try {
                startActivityForResult(intent, UploadRequestState.REQUEST_CODE)
                true
            } catch (e: Exception) {
                uploadRequests.invalidate()
                callback.onReceiveValue(null)
                true
            }
        }
    }

    private companion object {
        const val CRASH_FILE = "last_crash.txt"
        const val PREFS_NAME = "zcode_shell"
        const val PREF_PAGE_THEME_COLOR = "page_theme_color"
        const val PREF_PAGE_IS_DARK = "page_is_dark"

        /** How long a first load may stall before the shell offers the error page. */
        const val LOAD_TIMEOUT_MS = 15_000L

        /** Native origin probe timeouts (connect / read). */
        const val PROBE_TIMEOUT_MS = 6_000

        /** Renew the session this long before it expires. */
        const val SESSION_RENEW_SKEW_MS = 5 * 60 * 1000L

        /** How many POST_NOTIFICATIONS prompts have been answered (bounded). */
        const val PREF_NOTIFICATION_PROMPTS = "notification_permission_prompts"

        /** Matches the platform's own limit before it stops prompting. */
        const val MAX_NOTIFICATION_PROMPTS = 2

        /** How many battery-exemption dialogs have been raised (bounded). */
        const val PREF_BATTERY_PROMPTS = "battery_optimization_prompts"

        /** Set by the user's "不再提醒": no further battery prompts this install. */
        const val PREF_BATTERY_PROMPT_DISMISSED = "battery_optimization_prompt_dismissed"

        /** Re-probe cadence while the error screen is up, so recovery is automatic. */
        const val REPROBE_INTERVAL_MS = 5_000L

        /**
         * ZCode's own web CSS gives every scroll container a 14px classic
         * ::-webkit-scrollbar plus `scrollbar-gutter: stable`, which permanently
         * narrows the conversation/input column inside this shell. The shell
         * hides the *visual* scrollbar through overlay rules only — scroll
         * behavior itself is untouched. Idempotent: repeated calls reuse the
         * same <style> node.
         */
        private const val SCROLLBAR_COMPAT_JS =
            "(function(){var id='zcode-shell-scrollbars';" +
                "var s=document.getElementById(id);" +
                "if(!s){s=document.createElement('style');s.id=id;" +
                "try{var d=document.createElement('div');" +
                "d.style.cssText='position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll';" +
                "(document.body||document.documentElement).appendChild(d);" +
                "var w=d.offsetWidth-d.clientWidth;" +
                "(document.body||document.documentElement).removeChild(d);" +
                // The page reserves layout space for scrollbars only on engines that
                // take over ::-webkit-scrollbar; once the page stops doing that for
                // touch viewports there is nothing to compensate, so stay out of it.
                "if(w<=0)return;}catch(e){return}" +
                "s.textContent='*{scrollbar-width:none!important;scrollbar-gutter:auto!important}'+" +
                "'*::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}';" +
                "(document.head||document.documentElement).appendChild(s);}})();"
    }
}
