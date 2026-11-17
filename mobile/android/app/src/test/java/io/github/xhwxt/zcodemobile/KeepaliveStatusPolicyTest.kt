package io.github.xhwxt.zcodemobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeepaliveStatusPolicyTest {

    @Test
    fun `running tasks dominate the summary`() {
        val line = KeepaliveStatusPolicy.summaryLine(KeepaliveStatusPolicy.Summary(2, 5))
        assertEquals(R.string.keepalive_status_running, line.textRes)
        assertEquals(2, line.arg1)
        assertEquals(5, line.arg2)
    }

    @Test
    fun `completed-only state shows the completion count`() {
        val line = KeepaliveStatusPolicy.summaryLine(KeepaliveStatusPolicy.Summary(0, 3))
        assertEquals(R.string.keepalive_status_completed, line.textRes)
        assertEquals(3, line.arg1)
    }

    @Test
    fun `zero and negative counts collapse to idle`() {
        assertEquals(
            R.string.keepalive_status_idle,
            KeepaliveStatusPolicy.summaryLine(KeepaliveStatusPolicy.Summary(0, 0)).textRes,
        )
        assertEquals(
            R.string.keepalive_status_idle,
            KeepaliveStatusPolicy.summaryLine(KeepaliveStatusPolicy.Summary(-1, -2)).textRes,
        )
    }

    @Test
    fun `prominence maps to channel importance and storage round-trips`() {
        assertEquals(3, KeepaliveStatusPolicy.importanceFor(KeepaliveStatusPolicy.Prominence.LOW))
        assertEquals(2, KeepaliveStatusPolicy.importanceFor(KeepaliveStatusPolicy.Prominence.MIN))

        val stored = KeepaliveStatusPolicy.storageValue(KeepaliveStatusPolicy.Prominence.MIN)
        assertEquals(
            KeepaliveStatusPolicy.Prominence.MIN,
            KeepaliveStatusPolicy.prominenceFromStorage(stored),
        )
        // Null / anything unknown falls back to the LOW default.
        assertEquals(
            KeepaliveStatusPolicy.Prominence.LOW,
            KeepaliveStatusPolicy.prominenceFromStorage(null),
        )
        assertEquals(
            KeepaliveStatusPolicy.Prominence.LOW,
            KeepaliveStatusPolicy.prominenceFromStorage("garbage"),
        )
    }

    @Test
    fun `running counter floors at zero and grows on starts`() {
        assertEquals(1, KeepaliveStatusPolicy.nextRunning(0, started = true))
        assertEquals(3, KeepaliveStatusPolicy.nextRunning(2, started = true))
        assertEquals(0, KeepaliveStatusPolicy.nextRunning(0, started = false))
        assertEquals(0, KeepaliveStatusPolicy.nextRunning(1, started = false))
        assertEquals(4, KeepaliveStatusPolicy.nextRunning(5, started = false))
    }

    @Test
    fun `completed counter only grows until consumed`() {
        assertEquals(4, KeepaliveStatusPolicy.nextCompletedUnread(3, finishedTaskSeen = true))
        assertEquals(3, KeepaliveStatusPolicy.nextCompletedUnread(3, finishedTaskSeen = false))
    }

    // --- connection dimension -------------------------------------------------

    @Test
    fun `single unreachable probe stays silent, streak reaches disconnected at threshold`() {
        assertEquals(
            KeepaliveStatusPolicy.Connection.OK,
            KeepaliveStatusPolicy.connectionFor(0, noCredential = false),
        )
        assertEquals(
            KeepaliveStatusPolicy.Connection.OK,
            KeepaliveStatusPolicy.connectionFor(1, noCredential = false),
        )
        assertEquals(
            KeepaliveStatusPolicy.Connection.UNREACHABLE,
            KeepaliveStatusPolicy.connectionFor(2, noCredential = false),
        )
        assertEquals(
            KeepaliveStatusPolicy.Connection.UNREACHABLE,
            KeepaliveStatusPolicy.connectionFor(9, noCredential = false),
        )
    }

    @Test
    fun `no credential reports the pairing state regardless of streak`() {
        assertEquals(
            KeepaliveStatusPolicy.Connection.NO_CREDENTIAL,
            KeepaliveStatusPolicy.connectionFor(0, noCredential = true),
        )
        assertEquals(
            KeepaliveStatusPolicy.Connection.NO_CREDENTIAL,
            KeepaliveStatusPolicy.connectionFor(5, noCredential = true),
        )
    }

    @Test
    fun `running tasks outrank every connection state`() {
        for (connection in KeepaliveStatusPolicy.Connection.values()) {
            val line = KeepaliveStatusPolicy.summaryLine(
                KeepaliveStatusPolicy.Summary(2, 5, connection),
            )
            assertEquals(R.string.keepalive_status_running, line.textRes)
            assertEquals(2, line.arg1)
            assertEquals(5, line.arg2)
        }
    }

    @Test
    fun `disconnected connection state wins over completed and idle`() {
        val line = KeepaliveStatusPolicy.summaryLine(
            KeepaliveStatusPolicy.Summary(0, 3, KeepaliveStatusPolicy.Connection.UNREACHABLE),
        )
        assertEquals(R.string.keepalive_status_disconnected, line.textRes)
    }

    @Test
    fun `no-credential connection state wins over completed and idle`() {
        val line = KeepaliveStatusPolicy.summaryLine(
            KeepaliveStatusPolicy.Summary(0, 3, KeepaliveStatusPolicy.Connection.NO_CREDENTIAL),
        )
        assertEquals(R.string.keepalive_status_no_credential, line.textRes)
    }

    @Test
    fun `ok connection keeps the old priority completed before idle`() {
        assertEquals(
            R.string.keepalive_status_completed,
            KeepaliveStatusPolicy.summaryLine(
                KeepaliveStatusPolicy.Summary(0, 3, KeepaliveStatusPolicy.Connection.OK),
            ).textRes,
        )
        assertEquals(
            R.string.keepalive_status_idle,
            KeepaliveStatusPolicy.summaryLine(
                KeepaliveStatusPolicy.Summary(0, 0, KeepaliveStatusPolicy.Connection.OK),
            ).textRes,
        )
    }

    @Test
    fun `summary defaults to ok connection`() {
        assertEquals(
            KeepaliveStatusPolicy.Connection.OK,
            KeepaliveStatusPolicy.Summary(0, 0).connection,
        )
    }

    // --- probe-driven completion watchdog ---------------------------------------

    private fun diff(last: Int?, current: Int?) = KeepaliveStatusPolicy.completionDiff(last, current)

    @Test
    fun `first sight of the counter is a silent baseline`() {
        assertEquals(KeepaliveStatusPolicy.CompletionDiff.BASELINE, diff(null, 3))
        assertEquals(KeepaliveStatusPolicy.CompletionDiff.BASELINE, diff(null, 0))
    }

    @Test
    fun `counter increase notifies with the delta`() {
        assertEquals(KeepaliveStatusPolicy.CompletionDiff.NOTIFY(1), diff(3, 4))
        assertEquals(KeepaliveStatusPolicy.CompletionDiff.NOTIFY(5), diff(3, 8))
    }

    @Test
    fun `counter decrease or equal stays silent`() {
        assertEquals(KeepaliveStatusPolicy.CompletionDiff.NONE, diff(5, 5))
        assertEquals(KeepaliveStatusPolicy.CompletionDiff.NONE, diff(5, 2))
        assertEquals(KeepaliveStatusPolicy.CompletionDiff.NONE, diff(5, 0))
    }

    @Test
    fun `current unknown means no diff at all`() {
        // Field absent from the probe response: caller skips the diff, the
        // policy agrees by returning NONE (no baseline overwrite either).
        assertEquals(KeepaliveStatusPolicy.CompletionDiff.NONE, diff(5, null))
        assertEquals(KeepaliveStatusPolicy.CompletionDiff.NONE, diff(null, null))
    }

    @Test
    fun `corrupt negative values are treated as unknown`() {
        // A stored garbage number must not manufacture a notification.
        assertEquals(KeepaliveStatusPolicy.CompletionDiff.BASELINE, diff(-1, 4))
        assertEquals(KeepaliveStatusPolicy.CompletionDiff.NONE, diff(5, -1))
    }

    @Test
    fun `single completion notifies exactly once per increase`() {
        // The batch semantic: 0→1 notifies one, then 1→1 stays silent until
        // the counter moves again (dedup across probes).
        assertEquals(KeepaliveStatusPolicy.CompletionDiff.NOTIFY(1), diff(0, 1))
        assertEquals(KeepaliveStatusPolicy.CompletionDiff.NONE, diff(1, 1))
    }

    // --- pending-interactions watchdog ---------------------------------------

    private fun pending(last: Int?, current: Int?) =
        KeepaliveStatusPolicy.pendingInteractionsDiff(last, current)

    @Test
    fun `pending rising edge notifies with the current count`() {
        // The count (not the delta) is what the user must answer.
        assertEquals(KeepaliveStatusPolicy.PendingInteractionsDiff.NOTIFY(1), pending(0, 1))
        assertEquals(KeepaliveStatusPolicy.PendingInteractionsDiff.NOTIFY(3), pending(1, 3))
    }

    @Test
    fun `pending equal value never re-notifies`() {
        // Dedup across probes: the page channel posts the same slot when the
        // app is foreground; a repeated equal count must not pile up.
        assertEquals(KeepaliveStatusPolicy.PendingInteractionsDiff.NONE, pending(2, 2))
    }

    @Test
    fun `pending decrease or back to zero stays silent`() {
        // A drop means the user (or the page) answered; the caller cancels the
        // standing notification on zero, never notifies on a decrease.
        assertEquals(KeepaliveStatusPolicy.PendingInteractionsDiff.NONE, pending(3, 1))
        assertEquals(KeepaliveStatusPolicy.PendingInteractionsDiff.NONE, pending(1, 0))
    }

    @Test
    fun `pending first sighting only records the baseline`() {
        // Cold start: the field was never seen before — no notification, no
        // matter how many are pending (parity with completionDiff BASELINE).
        assertEquals(KeepaliveStatusPolicy.PendingInteractionsDiff.BASELINE, pending(null, 2))
        assertEquals(KeepaliveStatusPolicy.PendingInteractionsDiff.BASELINE, pending(null, 0))
    }

    @Test
    fun `pending absent field skips the diff`() {
        // Older server: the watchdog stays entirely dormant.
        assertEquals(KeepaliveStatusPolicy.PendingInteractionsDiff.NONE, pending(2, null))
        assertEquals(KeepaliveStatusPolicy.PendingInteractionsDiff.NONE, pending(null, null))
    }

    @Test
    fun `pending corrupt negative values are unknown`() {
        assertEquals(KeepaliveStatusPolicy.PendingInteractionsDiff.BASELINE, pending(-1, 2))
        assertEquals(KeepaliveStatusPolicy.PendingInteractionsDiff.NONE, pending(2, -1))
    }

    // --- server-reported running count for the status row ---------------------

    private val now = 1_000_000_000_000L
    private val cycle = KeepalivePolicy.POLL_INTERVAL_MS

    private fun running(server: Int?, at: Long?, page: Int) =
        KeepaliveStatusPolicy.runningCountForSummary(server, at, page, now)

    @Test
    fun `fresh server reading outranks a stale page counter`() {
        // The backgrounded WebView freezes the page counter at 0 while the
        // server reports 2 — the row must show the server's number.
        assertEquals(2, running(server = 2, at = now - cycle, page = 0))
    }

    @Test
    fun `equal fresh figures converge on the same count`() {
        // Positive conflict between the two sources resolves to the larger
        // (here equal) figure — the page may be one probe ahead, the server
        // may lag; never the sum, never the page value blindly.
        assertEquals(3, running(server = 1, at = now - cycle, page = 3))
    }

    @Test
    fun `stale server reading falls back to the page counter`() {
        // Probe failures and vendor freezes stretch the loop: past the
        // freshness window the server figure stops being trusted.
        val staleAt = now - cycle * (KeepaliveStatusPolicy.SERVER_RUNNING_FRESH_CYCLES + 1)
        assertEquals(4, running(server = 2, at = staleAt, page = 4))
    }

    @Test
    fun `boundary of the freshness window is still fresh`() {
        val edgeAt = now - cycle * KeepaliveStatusPolicy.SERVER_RUNNING_FRESH_CYCLES
        assertEquals(2, running(server = 2, at = edgeAt, page = 0))
    }

    @Test
    fun `never-recorded server figure falls back to the page counter`() {
        // Field absent so far (old server / cold start): page counter alone.
        assertEquals(5, running(server = null, at = null, page = 5))
        assertEquals(0, running(server = null, at = null, page = 0))
    }

    @Test
    fun `absent or corrupt timestamp makes the server figure stale`() {
        assertEquals(4, running(server = 2, at = 0L, page = 4))
        assertEquals(4, running(server = 2, at = null, page = 4))
        assertEquals(4, running(server = -1, at = now, page = 4))
    }
}
