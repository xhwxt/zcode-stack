package io.github.xhwxt.zcodemobile

/**
 * Pure-JVM contract for the keep-alive status notification's *content and
 * prominence* (the service/Activity only wire Android pieces around it).
 *
 * Line 1 is always the app name. Line 2 shows a status summary by priority:
 *  - "运行中 N · 已完成 M" while N running tasks exist;
 *  - "连接断开，重试中" when the probe has failed repeatedly (streak ≥ 2);
 *  - "未配对或凭据失效" when the shell holds nothing to probe with;
 *  - "已完成 M" when nothing runs but finished tasks await a look;
 *  - "已连接，空闲中" otherwise.
 * M is the unread-finished counter: the page reports `tasks-consumed` over the
 * existing ThemeChannel when the user opens the app, and the shell resets it.
 *
 * The connection dimension comes from the foreground service's probe loop: it
 * is the only honest signal the row has while no task runs. A single failed
 * probe stays silent (transient network hiccups must not flap the text); the
 * mapping lives in [connectionFor].
 *
 * Prominence has two user-facing levels mapping onto Android channel
 * importance: 低调 (LOW: status-bar icon, no banner; the default) and 极简
 * (MIN: no status-bar icon, pull-down only — some ROMs kill MIN-priority apps
 * more aggressively, which the settings copy states verbatim).
 */
object KeepaliveStatusPolicy {

    enum class Prominence { LOW, MIN }

    /**
     * Connection health as seen by the foreground service's probe loop, kept
     * JVM-safe (no Android imports) so the summary mapping stays testable.
     */
    enum class Connection { OK, UNREACHABLE, NO_CREDENTIAL }

    /** Consecutive probe failures before the row admits "断开". One miss stays silent. */
    const val UNREACHABLE_STREAK_THRESHOLD: Int = 2

    data class Summary(
        val running: Int,
        val completedUnread: Int,
        val connection: Connection = Connection.OK,
    ) {
        val isEmpty: Boolean get() = running <= 0 && completedUnread <= 0
    }

    /**
     * Connection state for a probe outcome streak: repeated failures escalate
     * to [Connection.UNREACHABLE]; an explicit no-credential probe (nothing to
     * authenticate with) reports [Connection.NO_CREDENTIAL] regardless of the
     * streak, because retrying cannot fix it. Anything else is [Connection.OK].
     */
    fun connectionFor(unreachableStreak: Int, noCredential: Boolean): Connection = when {
        noCredential -> Connection.NO_CREDENTIAL
        unreachableStreak >= UNREACHABLE_STREAK_THRESHOLD -> Connection.UNREACHABLE
        else -> Connection.OK
    }

    /** Line-2 text for [summary]; all strings live in strings.xml. */
    fun summaryLine(summary: Summary): SummaryLine = when {
        summary.running > 0 -> SummaryLine(R.string.keepalive_status_running, summary.running, summary.completedUnread)
        summary.connection == Connection.UNREACHABLE ->
            SummaryLine(R.string.keepalive_status_disconnected, 0, 0)
        summary.connection == Connection.NO_CREDENTIAL ->
            SummaryLine(R.string.keepalive_status_no_credential, 0, 0)
        summary.completedUnread > 0 -> SummaryLine(R.string.keepalive_status_completed, summary.completedUnread, 0)
        else -> SummaryLine(R.string.keepalive_status_idle, 0, 0)
    }

    /**
     * Which string resource + positional arguments render the summary line:
     * [arg1] fills %1$d of the resource, [arg2] fills %2$d (unused on the
     * single-argument strings).
     */
    data class SummaryLine(val textRes: Int, val arg1: Int, val arg2: Int)

    /** Channel importance for a prominence level (mirrors NotificationManager). */
    fun importanceFor(prominence: Prominence): Int = when (prominence) {
        Prominence.LOW -> 3 // NotificationManager.IMPORTANCE_LOW (JVM-safe literal)
        Prominence.MIN -> 2 // NotificationManager.IMPORTANCE_MIN
    }

    /** Settings storage value for a prominence level. */
    fun storageValue(prominence: Prominence): String = when (prominence) {
        Prominence.LOW -> "low"
        Prominence.MIN -> "min"
    }

    fun prominenceFromStorage(value: String?): Prominence =
        if (value == storageValue(Prominence.MIN)) Prominence.MIN else Prominence.LOW

    /**
     * Reducer for the running counter from WS task-status events: a
     * "started"-shaped event increments, a terminal one decrements, floored at
     * zero (a terminal for an unknown task must not drive the count negative).
     */
    fun nextRunning(current: Int, started: Boolean): Int =
        if (started) current + 1 else (current - 1).coerceAtLeast(0)

    /** The completed counter only grows until the page reports consumption. */
    fun nextCompletedUnread(current: Int, finishedTaskSeen: Boolean): Int =
        if (finishedTaskSeen) current + 1 else current

    // --- probe-driven completion watchdog ---------------------------------------

    /**
     * Outcome of diffing the probe's `completedUnread` against the last value
     * the shell recorded:
     *  - [NONE]: nothing new finished (or the counter moved down — a reset
     *    elsewhere must never fabricate a notification);
     *  - [NOTIFY]: [count] new finished tasks since the last probe — exactly
     *    one notification covers the whole batch;
     *  - [BASELINE]: the field was just seen for the first time (last value
     *    unknown) — record it silently, never notify on a cold start.
     */
    sealed class CompletionDiff {
        object NONE : CompletionDiff()
        data class NOTIFY(val count: Int) : CompletionDiff()
        object BASELINE : CompletionDiff()
    }

    /**
     * Diffs the probe's completed-unread counter against the last recorded
     * value. [lastSeen] is null when the shell has no usable previous value
     * (field absent before, storage empty, or an unparsable stored number) —
     * a lost baseline must not manufacture a notification. An [UNSET] current
     * value (field absent from the response) reaches the caller as null too,
     * and the caller then skips the diff entirely.
     */
    fun completionDiff(lastSeen: Int?, current: Int?): CompletionDiff {
        if (current == null || current < 0) return CompletionDiff.NONE
        if (lastSeen == null || lastSeen < 0) return CompletionDiff.BASELINE
        return when {
            current > lastSeen -> CompletionDiff.NOTIFY(current - lastSeen)
            else -> CompletionDiff.NONE
        }
    }

    // --- probe-driven pending-interaction watchdog ------------------------------

    /**
     * Outcome of diffing the probe's `pendingInteractions` counter (questions /
     * permission prompts waiting for the user) against the last recorded value:
     *  - [NONE]: nothing new is waiting (or the count moved down / returned to
     *    zero — a drop means the user or the page answered; the caller cancels
     *    the standing notification on zero, never notifies on a decrease);
     *  - [NOTIFY]: [current] items now wait — one notification states the
     *    *current* count (not the delta): the count is what the user must
     *    answer, and one notification covers the whole batch;
     *  - [BASELINE]: the field was just seen for the first time — record it
     *    silently, never notify on a cold start.
     *
     * Dedup with the foreground page channel: when the app is visible the page
     * posts the same notification slot (same id) with the real question text;
     * the shell cannot know that text (it lives page-side), so the fallback
     * only ever states the count, and equal values never re-notify — the two
     * paths cannot pile up duplicates for one pending item.
     */
    sealed class PendingInteractionsDiff {
        object NONE : PendingInteractionsDiff()
        data class NOTIFY(val current: Int) : PendingInteractionsDiff()
        object BASELINE : PendingInteractionsDiff()
    }

    /** See [PendingInteractionsDiff]. */
    fun pendingInteractionsDiff(lastSeen: Int?, current: Int?): PendingInteractionsDiff {
        if (current == null || current < 0) return PendingInteractionsDiff.NONE
        if (lastSeen == null || lastSeen < 0) return PendingInteractionsDiff.BASELINE
        return if (current > lastSeen) {
            PendingInteractionsDiff.NOTIFY(current)
        } else {
            PendingInteractionsDiff.NONE
        }
    }

    // --- server-reported running count ------------------------------------------

    /**
     * How many probe cycles ([KeepalivePolicy.POLL_INTERVAL_MS] each) a stored
     * server running-count stays fresh. The probe succeeds roughly every 10 s
     * when the server answers, so three cycles (~90 s) only elapse when the
     * loop is degraded (failure backoff, vendor background freezes) — exactly
     * when the server's number must stop being trusted.
     */
    const val SERVER_RUNNING_FRESH_CYCLES: Int = 3

    /**
     * The running figure for the status row, from the page counter and the
     * server's probe report. The server value leads while it is fresh: after
     * the app is backgrounded the WebView's JS is paused and the page counter
     * freezes at a stale number (historically the row then claimed "空闲中"
     * forever while tasks ran), so a fresh probe reading outranks it — even
     * when *lower* than the page counter, because the page may have missed a
     * terminal event. When the probe reading is fresh but the page counter is
     * momentarily ahead (a task the page just saw start, next probe up to one
     * cycle away), the larger of the two is honest. A stale, absent or
     * never-recorded probe value falls back to the page counter alone.
     */
    fun runningCountForSummary(
        serverRunning: Int?,
        serverRunningAtMillis: Long?,
        pageRunning: Int,
        nowMillis: Long,
    ): Int {
        val fresh = serverRunning != null && serverRunning >= 0 &&
            serverRunningAtMillis != null && serverRunningAtMillis > 0 &&
            (nowMillis - serverRunningAtMillis) / KeepalivePolicy.POLL_INTERVAL_MS <=
            SERVER_RUNNING_FRESH_CYCLES
        if (!fresh) return pageRunning.coerceAtLeast(0)
        return maxOf(pageRunning, serverRunning)
    }
}
