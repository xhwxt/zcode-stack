package io.github.xhwxt.zcodemobile

import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.net.HttpURLConnection
import java.net.URL

/**
 * Foreground keep-alive service: one lightweight HTTP probe loop that keeps the
 * process alive (and therefore the notification chain page → shim → shell
 * reachable) while the user expects task notifications.
 *
 * Scope discipline:
 *  - The service only *keeps the process alive* and watches reachability. It
 *    does NOT open WebSockets or try to post task notifications itself — the
 *    WS conversation protocol lives on the JS side, and re-implementing it
 *    here would fork the protocol into a second client with no tests behind
 *    it. With the process alive, the WebView's own reconnect re-establishes
 *    the real feed and the page keeps driving notifications through the shim.
 *  - The status row is a two-line summary ("运行中 N · 已完成 M" /
 *    "已连接，空闲中"). The counters are shared through SharedPreferences so
 *    the Activity (which hears the page's telemetry over ThemeChannel) can
 *    update them without a binder; the service re-reads them on each refresh
 *    and no-ops when nothing changed.
 *  - Prominence has two levels (低调/LOW default, 极简/MIN); the level selects
 *    the channel importance, re-created on change.
 *  - A 401 from the probe means the credential was revoked: the service stops
 *    itself (the notification would otherwise outlive the device).
 *  - The stop action on the notification is the user's off switch; the choice
 *    is remembered so a restart does not sneak the service back.
 *
 * Decision logic lives in [KeepalivePolicy] / [KeepaliveStatusPolicy]
 * (JVM-tested); this class only wires Android pieces (handler, HTTP,
 * notifications), which cannot run under a JVM unit test.
 */
class ZcodeKeepaliveService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var unreachableStreak: Int = 0
    /** Last probe failure class (null = last probe succeeded). */
    private var lastProbeFailure: String? = null
    private var probing: Boolean = false
    private var stoppedByUser: Boolean = false
    private var lastSummaryKey: String? = null

    private val probeRun = object : Runnable {
        override fun run() {
            if (stoppedByUser) return
            if (probing) return // a slow probe must not stack with the next tick
            probing = true
            Thread {
                val failure = probeOnce()
                handler.post {
                    probing = false
                    if (stoppedByUser) return@post
                    // Original cadence semantics: only a successful probe resets
                    // the streak (NO_CREDENTIAL backs off like any failure — the
                    // display still says "未配对", see summaryFromPrefs).
                    lastProbeFailure = failure
                    if (KeepalivePolicy.isUnreachable(failure == null)) {
                        unreachableStreak += 1
                    } else {
                        unreachableStreak = 0
                    }
                    if (failure == REVOKED) {
                        // Device revoked server-side: keep-alive has nothing
                        // left to keep and the user must pair again anyway.
                        // The cached (token, origin) is dead too — the next
                        // pairing must rebuild it.
                        ProbeTargetCache.clear()
                        stopByUser()
                        return@post
                    }
                    refreshStatusRow()
                    scheduleNext()
                }
            }.start()
        }
    }

    /** Runs one probe; returns null on success, or the failure class string. */
    private fun probeOnce(): String? {
        val (credential, origin) = probeTarget() ?: run {
            Log.d(TAG, "probe skipped: no usable credential (device list / keystore / link)")
            return NO_CREDENTIAL
        }
        return try {
            val connection = URL("$origin${DeviceAuthPolicy.PROBE_PATH}").openConnection()
                as HttpURLConnection
            connection.requestMethod = "POST"
            connection.connectTimeout = PROBE_TIMEOUT_MS
            connection.readTimeout = PROBE_TIMEOUT_MS
            connection.doOutput = true
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use {
                it.write(KeepalivePolicy.probeBody(credential).toByteArray(Charsets.UTF_8))
            }
            val code = connection.responseCode
            val body = if (code in 200..299) {
                connection.inputStream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            } else {
                null
            }
            connection.disconnect()
            when {
                code in 200..299 -> {
                    // Completion watchdog: the frozen WebView cannot observe a
                    // task reaching a terminal state, so the probe loop (the
                    // one thread that survives a ROM freeze) diffs the
                    // server's completed-unread counter here. Absent fields
                    // (older server) skip the diff silently; failures leave
                    // the recorded baseline untouched.
                    handleProbeBody(body)
                    null
                }
                code == 401 -> REVOKED
                else -> {
                    Log.d(TAG, "probe failed: HTTP $code")
                    UNREACHABLE
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "probe failed: ${e.javaClass.simpleName}")
            UNREACHABLE
        }
    }

    /**
     * Diffs the probe body's `completedUnread` / `pendingInteractions` against
     * the last recorded values and notifies through [CompletionBridge] /
     * [PendingBridge] when new completions / pending questions arrived.
     * Best-effort end to end: a parse failure, a missing field or a storage
     * error only means "no watchdog this tick" — never a crash and never a
     * fabricated notification. The running counter is recorded (with its
     * timestamp, for the status row's freshness window) but its decrease
     * notifies nobody (reset semantics). `pendingInteractions` absent means an
     * older server: the pending watchdog stays entirely dormant, same absence
     * semantics as `completedUnread`. On a pending rising edge the optional
     * `pendingDigest` (see [PendingDigestPolicy]) is read from the same body and
     * handed to the notification layer; absent it, that layer keeps its
     * count-only text.
     */
    private fun handleProbeBody(body: String?) {
        if (body.isNullOrBlank()) return
        val root = try {
            org.json.JSONObject(body)
        } catch (e: Exception) {
            return
        }
        if (!root.optBoolean("reachable", true)) return
        val now = System.currentTimeMillis()
        val completed = root.optInt("completedUnread", UNSET_TASK_COUNT).takeIf { it != UNSET_TASK_COUNT }
        val running = root.optInt("runningTasks", UNSET_TASK_COUNT).takeIf { it != UNSET_TASK_COUNT }
        val pending = root.optInt("pendingInteractions", UNSET_TASK_COUNT).takeIf { it != UNSET_TASK_COUNT }
        val p = preferences()
        val lastCompleted = p.getInt(PREF_SERVER_COMPLETED_UNREAD, UNSET_TASK_COUNT)
            .takeIf { it != UNSET_TASK_COUNT }
        if (completed != null) {
            val diff = KeepaliveStatusPolicy.completionDiff(lastCompleted, completed)
            p.edit().putInt(PREF_SERVER_COMPLETED_UNREAD, completed).apply()
            when (diff) {
                is KeepaliveStatusPolicy.CompletionDiff.NOTIFY ->
                    CompletionBridge.onCompletions?.invoke(diff.count)
                KeepaliveStatusPolicy.CompletionDiff.BASELINE,
                KeepaliveStatusPolicy.CompletionDiff.NONE,
                -> Unit
            }
        }
        if (running != null) {
            p.edit()
                .putInt(PREF_SERVER_RUNNING_TASKS, running)
                .putLong(PREF_SERVER_RUNNING_AT, now)
                .apply()
        }
        if (pending != null) {
            val lastPending = p.getInt(PREF_SERVER_PENDING_INTERACTIONS, UNSET_TASK_COUNT)
                .takeIf { it != UNSET_TASK_COUNT }
            val diff = KeepaliveStatusPolicy.pendingInteractionsDiff(lastPending, pending)
            p.edit().putInt(PREF_SERVER_PENDING_INTERACTIONS, pending).apply()
            when (diff) {
                // The optional digest rides along on the rising edge only: the
                // new-server summary of the first pending item, or null when
                // the field is absent (older server) — the notification layer
                // then falls back to the count-only row unchanged.
                is KeepaliveStatusPolicy.PendingInteractionsDiff.NOTIFY ->
                    PendingBridge.onPending?.invoke(diff.current, PendingDigestPolicy.textFrom(body))
                KeepaliveStatusPolicy.PendingInteractionsDiff.BASELINE,
                KeepaliveStatusPolicy.PendingInteractionsDiff.NONE,
                -> Unit
            }
        }
    }

    /**
     * Probe thread → Activity notification hand-off for the completion
     * watchdog. The service never posts user-facing notifications itself;
     * the Activity owns [TaskNotifier] and its permission state. When no
     * Activity is alive the callback is simply absent — the next successful
     * probe re-runs the diff only against the recorded baseline, so nothing
     * is lost or duplicated.
     */
    object CompletionBridge {
        /** Set by the Activity in onCreate; invoked on the probe thread. */
        @Volatile
        var onCompletions: ((count: Int) -> Unit)? = null
    }

    /**
     * Same hand-off shape as [CompletionBridge] for the pending-interaction
     * watchdog ("有 N 项等待你的回复"). Carries the *current* pending count plus
     * the optional probe digest text (the first pending item's summary, null
     * when the response carried no `pendingDigest`): one notification states the
     * whole batch, and it must be posted even when the Activity is gone (a
     * backgrounded app is exactly when this fallback matters) — so unlike the
     * completion path this one is wired to a static poster, not to the
     * Activity's lifetime.
     */
    object PendingBridge {
        /** Set once at app start; invoked on the probe thread. */
        @Volatile
        var onPending: ((current: Int, digestText: String?) -> Unit)? = null
    }

    /**
     * The credential token and validated origin to probe with.
     *
     * Primary source: [ProbeTargetCache] — the (token, origin) pair the page
     * flow verified at connect/renew time. The page's chat keeps working when
     * the system invalidates the Keystore key mid-session, and the probe must
     * not diverge from that reality by re-decrypting on every tick (a single
     * transient Keystore failure used to flip the row to "未配对" during a
     * perfectly healthy chat).
     *
     * Fallback 2 (cache empty — a cold FGS start that ran before the page
     * connected): DeviceStore → linkOf → [EntryLinkPolicy.validate] →
     * DeviceCredentialStore decrypt.
     *
     * Fallback 3 (both above fail): the WebView cookie jar's long-lived
     * renewal cookie (`zcode_device_renew`, value = the device token itself).
     * A user who paired *inside the page* — or whose Keystore credential died
     * permanently — keeps chatting through the jar while the shell holds no
     * decryptable credential at all; historically the probe reported "未配对"
     * forever in exactly that state. The jar token is returned as the probe
     * credential and [probeOnce]'s existing handling verifies it: 200 → OK
     * (chat's own credential, honest row), 401 → REVOKED (stop, same as the
     * page's own healing would hit), transport failure → UNREACHABLE backoff.
     * The jar is re-read on every tick that reaches this fallback and never
     * written into the cache: the jar (not the shell) owns this credential,
     * so an in-page re-pairing is picked up automatically instead of leaving
     * a stale token behind.
     *
     * Every failure branch logs (Log.d, never the token value) so a user
     * report can be triaged from logcat.
     */
    private fun probeTarget(): Pair<String, String>? {
        ProbeTargetCache.get()?.let { cached ->
            return cached.deviceToken to cached.origin
        }
        Log.d(TAG, "probe target: cache empty (page not connected yet), falling back to store chain")
        resolveProbeTargetFromStores()?.let { return it }
        Log.d(TAG, "probe target: store chain failed, trying renew cookie from webview jar")
        return resolveProbeTargetFromCookie()
    }

    /**
     * Fallback 3: the renewal-cookie token from the WebView cookie jar, used
     * verbatim as the probe credential (the cookie's value is the device
     * token; /api/auth/probe authenticates it like any other). Blocking jar
     * read — probe thread only. Returns null when there is nothing usable;
     * a rejected token surfaces as the probe's own 401 → REVOKED.
     */
    private fun resolveProbeTargetFromCookie(): Pair<String, String>? {
        val origin = activeOriginFromStores() ?: run {
            Log.d(TAG, "probe target unavailable: no device origin for cookie fallback")
            return null
        }
        val cookieHeader = try {
            android.webkit.CookieManager.getInstance().getCookie(origin)
        } catch (e: Exception) {
            Log.d(TAG, "probe target unavailable: webview cookie jar unreadable")
            null
        }
        val token = DeviceAuthPolicy.renewCookieTokenFromHeader(cookieHeader) ?: run {
            Log.d(TAG, "probe target unavailable: no renew cookie in webview jar")
            return null
        }
        return token to origin
    }

    /**
     * The origin the cookie fallback reads the jar with: the active page
     * origin while the Activity holds one, else the most recently used
     * device's stored origin (plaintext metadata — no Keystore cycle, so it
     * survives exactly the failures that brought us here).
     */
    private fun activeOriginFromStores(): String? {
        ActivityOriginBridge.activeOrigin?.let { return it }
        val latest = try {
            deviceStore().list().maxByOrNull { it.lastUsedAt }
        } catch (e: Exception) {
            return null
        } ?: return null
        return latest.origin.takeIf { it.isNotBlank() }
    }

    /** The fallback store chain; extracted so its null branches stay testable in isolation. */
    private fun resolveProbeTargetFromStores(): Pair<String, String>? {
        val latest = try {
            deviceStore().list().maxByOrNull { it.lastUsedAt }
        } catch (e: Exception) {
            Log.d(TAG, "probe target unavailable: device store read failed")
            return null
        }
        if (latest == null) {
            Log.d(TAG, "probe target unavailable: no paired device")
            return null
        }
        val link = try {
            deviceStore().linkOf(latest.id)
        } catch (e: Exception) {
            Log.d(TAG, "probe target unavailable: keystore link read failed")
            return null
        } ?: run {
            Log.d(TAG, "probe target unavailable: no stored link")
            return null
        }
        val result = EntryLinkPolicy.validate(link)
        if (!result.valid) {
            Log.d(TAG, "probe target unavailable: stored link failed validation")
            return null
        }
        val host = result.host ?: run {
            Log.d(TAG, "probe target unavailable: link has no host")
            return null
        }
        val scheme = result.scheme ?: run {
            Log.d(TAG, "probe target unavailable: link has no scheme")
            return null
        }
        val origin = scheme + "://" + host.lowercase() + (result.port?.let { ":$it" } ?: "")
        val credential = try {
            DeviceCredentialStore(this, slot = latest.id).load()
        } catch (e: Exception) {
            Log.d(TAG, "probe target unavailable: keystore credential load failed")
            return null // Keystore failure: nothing to probe with
        }
        val token = credential?.deviceToken?.takeIf { it.isNotEmpty() } ?: run {
            Log.d(TAG, "probe target unavailable: credential holds no token")
            return null
        }
        return token to origin
    }

    private fun deviceStore(): DeviceStore = DeviceStore(this)

    /**
     * Activity → service bridge for the page's live origin (set on every
     * connect/renew/pairing, cleared on revoke/teardown). The service reads it
     * as the cookie fallback's first choice; the process is shared (no
     * android:process in the manifest), so this is plain memory access.
     */
    object ActivityOriginBridge {
        @Volatile
        var activeOrigin: String? = null
    }

    private fun scheduleNext() {
        handler.removeCallbacks(probeRun)
        val interval = KeepalivePolicy.nextIntervalMs(unreachableStreak)
        handler.postDelayed(probeRun, interval)
    }

    override fun onCreate() {
        super.onCreate()
        NotificationTaskBridge.ensureKeepaliveChannel(
            this,
            prominence(),
        )
        startStatusNotification()
        unreachableStreak = 0
        lastProbeFailure = null
        handler.post(probeRun)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopByUser()
                return START_NOT_STICKY
            }

            ACTION_REFRESH -> {
                // Counters or prominence changed underneath us: rebuild the
                // row in place (and the channel when the level changed).
                NotificationTaskBridge.ensureKeepaliveChannel(this, prominence())
                startStatusNotification()
            }

            else -> {
                NotificationTaskBridge.ensureKeepaliveChannel(this, prominence())
                startStatusNotification()
                scheduleNext()
            }
        }
        // START_STICKY: a killed service comes back (the whole point); the
        // aggregation-free probe loop starts over harmlessly.
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacks(probeRun)
        super.onDestroy()
    }

    private fun stopByUser() {
        stoppedByUser = true
        preferences().edit().putBoolean(PREF_KEEPALIVE_ENABLED, false).apply()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun preferences(): SharedPreferences =
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)

    private fun prominence(): KeepaliveStatusPolicy.Prominence =
        KeepaliveStatusPolicy.prominenceFromStorage(
            preferences().getString(PREF_KEEPALIVE_PROMINENCE, null),
        )

    /** Shared counters and probe state: the Activity writes, the service reads. */
    fun refreshStatusRow() {
        val p = preferences()
        val summary = summaryFromPrefs(p)
        val key = "${summary.running}/${summary.completedUnread}/${summary.connection}/${prominence()}"
        if (key == lastSummaryKey) return // nothing changed: no update, no churn
        lastSummaryKey = key
        startStatusNotification()
    }

    /** Prefs counters plus the connection state implied by the probe loop. */
    private fun summaryFromPrefs(p: SharedPreferences): KeepaliveStatusPolicy.Summary {
        // NO_CREDENTIAL is reported from the failure class, not the streak: the
        // streak still drives the retry backoff (unchanged cadence), but the
        // display must say "未配对/凭据失效", not "连接断开" — retrying cannot
        // fix a missing credential.
        val connection = KeepaliveStatusPolicy.connectionFor(
            unreachableStreak = if (lastProbeFailure == NO_CREDENTIAL) 0 else unreachableStreak,
            noCredential = lastProbeFailure == NO_CREDENTIAL,
        )
        // The server's running figure leads the page counter while fresh: a
        // backgrounded WebView freezes the page-driven counter at 0 (the row
        // then claimed "空闲中" forever while tasks actually ran). Probe
        // failures and vendor freezes stretch the loop, so the stored figure
        // is trusted only inside [KeepaliveStatusPolicy.SERVER_RUNNING_FRESH_CYCLES].
        val serverRunning = p.getInt(PREF_SERVER_RUNNING_TASKS, UNSET_TASK_COUNT)
            .takeIf { it != UNSET_TASK_COUNT }
        val serverRunningAt = p.getLong(PREF_SERVER_RUNNING_AT, 0L)
        val running = KeepaliveStatusPolicy.runningCountForSummary(
            serverRunning = serverRunning,
            serverRunningAtMillis = serverRunningAt,
            pageRunning = p.getInt(PREF_RUNNING_COUNT, 0),
            nowMillis = System.currentTimeMillis(),
        )
        return KeepaliveStatusPolicy.Summary(
            running = running,
            completedUnread = p.getInt(PREF_COMPLETED_COUNT, 0),
            connection = connection,
        )
    }

    private fun startStatusNotification() {
        val openIntent = PendingIntent.getActivity(
            this,
            OPEN_REQUEST_CODE,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getBroadcast(
            this,
            STOP_REQUEST_CODE,
            Intent(this, ZcodeKeepaliveService.KeepaliveStopReceiver::class.java).apply {
                action = ACTION_STOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val p = preferences()
        val summary = summaryFromPrefs(p)
        val builder = NotificationTaskBridge.statusNotification(
            this,
            openIntent,
            stopIntent,
            prominence = prominence(),
            summary = summary,
            showCompleted = p.getBoolean(PREF_SHOW_COMPLETED, true),
        )
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            builder,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            } else {
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            },
        )
    }

    class KeepaliveStopReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            // Both the notification entry and any future settings entry land
            // here; the service records the choice before stopping.
            context.startService(
                Intent(context, ZcodeKeepaliveService::class.java).apply {
                    action = ACTION_STOP
                },
            )
        }
    }

    companion object {
        const val ACTION_STOP = "io.github.xhwxt.zcodemobile.KEEPALIVE_STOP"
        const val ACTION_REFRESH = "io.github.xhwxt.zcodemobile.KEEPALIVE_REFRESH"
        const val NOTIFICATION_ID = 7302
        const val CHANNEL_ID = "zcode_keepalive"
        const val OPEN_REQUEST_CODE = 7312
        const val STOP_REQUEST_CODE = 7313

        /** logcat tag for probe diagnostics (never carries token or link data). */
        private const val TAG = "ZcodeKeepalive"

        const val PREFS_NAME = "zcode_shell"
        const val PREF_KEEPALIVE_ENABLED = "keepalive_enabled"
        const val PREF_KEEPALIVE_PROMINENCE = "keepalive_prominence"
        const val PREF_RUNNING_COUNT = "keepalive_running_count"
        const val PREF_COMPLETED_COUNT = "keepalive_completed_count"
        const val PREF_SHOW_COMPLETED = "keepalive_show_completed"

        /** Server-reported running tasks from the probe (absent = not written). */
        const val PREF_SERVER_RUNNING_TASKS = "keepalive_server_running"

        /** When [PREF_SERVER_RUNNING_TASKS] was written (freshness window gate). */
        const val PREF_SERVER_RUNNING_AT = "keepalive_server_running_at"

        /** Server-reported completed-unread from the probe (absent = not written). */
        const val PREF_SERVER_COMPLETED_UNREAD = "keepalive_server_completed_unread"

        /** Server-reported pending interactions from the probe (absent = not written). */
        const val PREF_SERVER_PENDING_INTERACTIONS = "keepalive_server_pending_interactions"

        /** optInt sentinel: the probe response did not carry the field. */
        private const val UNSET_TASK_COUNT = -1

        private const val PROBE_TIMEOUT_MS = 8_000
        private const val REVOKED = "revoked"
        private const val UNREACHABLE = "unreachable"
        private const val NO_CREDENTIAL = "no_credential"

        fun isEnabled(preferences: SharedPreferences): Boolean =
            preferences.getBoolean(PREF_KEEPALIVE_ENABLED, true)

        fun ensureStarted(context: Context, preferences: SharedPreferences) {
            if (!isEnabled(preferences)) return
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                manager?.getNotificationChannel(channelIdFor(
                    KeepaliveStatusPolicy.prominenceFromStorage(
                        preferences.getString(PREF_KEEPALIVE_PROMINENCE, null),
                    ),
                ))?.importance == NotificationManager.IMPORTANCE_NONE
            ) {
                return // channel switched off: a silent FGS would only drain battery
            }
            context.startForegroundService(
                Intent(context, ZcodeKeepaliveService::class.java),
            )
        }

        /** One channel id per prominence level so importance changes are legal. */
        fun channelIdFor(prominence: KeepaliveStatusPolicy.Prominence): String = when (prominence) {
            KeepaliveStatusPolicy.Prominence.LOW -> "${CHANNEL_ID}_low"
            KeepaliveStatusPolicy.Prominence.MIN -> "${CHANNEL_ID}_min"
        }
    }
}
