package io.github.xhwxt.zcodemobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * JVM tests for the probe target resolution semantics (0.1.3): the page-verified
 * cache wins, the store fallback chain only runs when the cache is empty, and a
 * revoked/cleared cache sends the probe back to the fallback (or "未配对").
 */
class ProbeTargetCacheTest {

    @Test
    fun `cache empty resolves to null so the fallback chain runs`() {
        ProbeTargetCache.clear()
        assertNull(ProbeTargetCache.resolve(ProbeTargetCache.get()))
    }

    @Test
    fun `cached target is returned verbatim without touching stores`() {
        ProbeTargetCache.clear()
        ProbeTargetCache.put("token-1", "https://device.example.com")
        val resolved = ProbeTargetCache.resolve(ProbeTargetCache.get())
        assertEquals(ProbeTargetCache.Target("token-1", "https://device.example.com"), resolved)
        assertNull(ProbeTargetCache.resolve(null)) // empty argument never synthesizes a target
        ProbeTargetCache.clear()
    }

    @Test
    fun `a fresher put replaces a stale entry (device switched or re-paired)`() {
        ProbeTargetCache.clear()
        ProbeTargetCache.put("old-token", "https://old.example.com")
        ProbeTargetCache.put("new-token", "https://new.example.com")
        assertEquals(
            ProbeTargetCache.Target("new-token", "https://new.example.com"),
            ProbeTargetCache.get(),
        )
        ProbeTargetCache.clear()
    }

    @Test
    fun `empty token or origin is rejected - a blank pair must not shadow the fallback`() {
        ProbeTargetCache.clear()
        ProbeTargetCache.put("", "https://host.example.com")
        assertNull(ProbeTargetCache.get())
        ProbeTargetCache.put("token", "")
        assertNull(ProbeTargetCache.get())
        ProbeTargetCache.clear()
    }

    @Test
    fun `clear drops the entry - revoked device falls back to the store chain`() {
        ProbeTargetCache.clear()
        ProbeTargetCache.put("token", "https://host.example.com")
        ProbeTargetCache.clear()
        assertNull(ProbeTargetCache.get())
        assertNull(ProbeTargetCache.resolve(ProbeTargetCache.get()))
    }

    @Test
    fun `empty cache keeps the fallback in charge until a verified write arrives`() {
        // 0.1.3 field failure semantics: the page authenticated through its
        // renewal cookie (no shell-side credential), so no cache write ever
        // happened and every probe stayed NO_CREDENTIAL. The 0.1.4 cookie
        // fallback deliberately never writes the jar token into the cache —
        // the jar owns that credential and an in-page re-pairing must be
        // picked up on the next tick — so an empty cache stays empty and the
        // fallback chain keeps running until a *verified* (connect/renew/
        // pairing) write lands.
        ProbeTargetCache.clear()
        assertNull(ProbeTargetCache.get())
        assertNull(ProbeTargetCache.resolve(ProbeTargetCache.get()))
        // A verified page-flow write (connect/renew/pairing) takes over:
        ProbeTargetCache.put("dt-from-shell", "https://host.example.com")
        assertEquals(
            ProbeTargetCache.Target("dt-from-shell", "https://host.example.com"),
            ProbeTargetCache.resolve(ProbeTargetCache.get()),
        )
        ProbeTargetCache.clear()
    }
}
