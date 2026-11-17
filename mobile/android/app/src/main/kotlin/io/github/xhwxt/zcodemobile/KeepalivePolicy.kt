package io.github.xhwxt.zcodemobile

/**
 * Pure-JVM contract for the keep-alive foreground service's decisions:
 * polling schedule and retry backoff. The service itself owns HTTP, handlers
 * and Android plumbing; everything that decides *what* it does lives here so
 * it stays unit-testable.
 *
 * The status-light content is a placeholder ("running") until the overview
 * design lands; nothing here assumes a data feed yet.
 */
object KeepalivePolicy {

    /** Base probe interval while the server answers (also the WS watchdog). */
    const val POLL_INTERVAL_MS: Long = 30_000L

    /** Faster re-probe while the server looks unreachable (recover quickly). */
    const val RETRY_INTERVAL_MS: Long = 10_000L

    /** Cap on the unreachable streak before the backoff saturates. */
    const val MAX_BACKOFF_STEPS: Int = 3

    /**
     * Exponential backoff for consecutive unreachable probes:
     * 10s, 20s, 40s, 40s, … (base × 2^min(steps, cap)). Far below the server's
     * probe rate limit (600 requests / 10 min / IP). A reachable answer resets
     * the streak.
     */
    fun nextIntervalMs(unreachableStreak: Int): Long {
        val steps = unreachableStreak.coerceIn(0, MAX_BACKOFF_STEPS)
        return RETRY_INTERVAL_MS * (1L shl steps)
    }

    /** True when this probe answer should flip the poll cadence to fast retry. */
    fun isUnreachable(reachable: Boolean): Boolean = !reachable

    /**
     * Probe request body for /api/auth/probe — the one credential-bearing
     * surface the service needs. Kept here so a field rename is a one-line,
     * tested change (mirrors DeviceAuthPolicy.probeBody without org.json).
     */
    fun probeBody(deviceToken: String): String =
        "{\"deviceToken\":\"" + escapeJson(deviceToken) + "\"}"

    /** Minimal JSON string escaping for the token (quotes and backslashes). */
    fun escapeJson(value: String): String = buildString(value.length) {
        for (c in value) {
            when (c) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                else -> append(c)
            }
        }
    }
}
