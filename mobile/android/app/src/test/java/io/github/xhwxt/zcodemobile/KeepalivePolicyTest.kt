package io.github.xhwxt.zcodemobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeepalivePolicyTest {

    @Test
    fun `backoff doubles and saturates at the cap`() {
        assertEquals(10_000L, KeepalivePolicy.nextIntervalMs(0))
        assertEquals(20_000L, KeepalivePolicy.nextIntervalMs(1))
        assertEquals(40_000L, KeepalivePolicy.nextIntervalMs(2))
        // Saturated: 10s * 2^cap (cap=3) = 80s, no matter how deep the streak.
        assertEquals(80_000L, KeepalivePolicy.nextIntervalMs(3))
        assertEquals(80_000L, KeepalivePolicy.nextIntervalMs(99))
        // Negative streaks clamp to the base interval.
        assertEquals(10_000L, KeepalivePolicy.nextIntervalMs(-5))
    }

    @Test
    fun `probe cadence stays far below the server rate limit`() {
        // Worst case 40s/req vs 600 req / 10 min (0.6s/req): two orders of headroom.
        assertTrue(KeepalivePolicy.nextIntervalMs(3) > 60_000L / 600)
    }

    @Test
    fun `unreachable is the negated reachability`() {
        assertTrue(KeepalivePolicy.isUnreachable(false))
        assertFalse(KeepalivePolicy.isUnreachable(true))
    }

    @Test
    fun `probe body carries the token as json`() {
        assertEquals("""{"deviceToken":"tok"}""", KeepalivePolicy.probeBody("tok"))
    }

    @Test
    fun `probe body escapes quotes and backslashes`() {
        assertEquals(
            """{"deviceToken":"a\"b\\c"}""",
            KeepalivePolicy.probeBody("a\"b\\c"),
        )
    }
}
