package io.github.xhwxt.zcodemobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure JVM tests for the connection-lifecycle decisions that do not need an
 * Android device: origin-building from a validated link and the
 * back-navigation / external-link same-origin policy exercised through
 * [EntryLinkPolicy]. Upload-request correlation lives in
 * [UploadRequestState] and needs Android framework types, so its decision
 * contract is documented there and verified on-device (see README).
 */
class NavigationPolicyTest {

    // -- origin building (mirrors MainActivity.originFromResult logic) ----------

    @Test
    fun `origin from validated root link`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test/?token=t")
        val origin = result.let { r ->
            requireNotNull(r.host)
            r.scheme + "://" + r.host + (r.port?.let { ":$it" } ?: "")
        }
        assertEquals("https://zcode.example.test", origin)
    }

    @Test
    fun `origin from validated link with custom port keeps port`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test:8443/?token=t")
        val origin = result.let { r ->
            requireNotNull(r.host)
            r.scheme + "://" + r.host + (r.port?.let { ":$it" } ?: "")
        }
        assertEquals("https://zcode.example.test:8443", origin)
    }

    // -- back navigation policy (same-origin only) -------------------------------

    @Test
    fun `back to same-origin history entry is allowed`() {
        val allowedOrigin = "https://zcode.example.test"
        val previousEntry = "https://zcode.example.test/page-1"
        assertTrue(EntryLinkPolicy.isSameOrigin(allowedOrigin, originOf(previousEntry)))
    }

    @Test
    fun `back to cross-origin history entry is refused`() {
        val allowedOrigin = "https://zcode.example.test"
        val previousEntry = "https://evil-zcode.example.test/page"
        assertFalse(EntryLinkPolicy.isSameOrigin(allowedOrigin, originOf(previousEntry)))
    }

    @Test
    fun `back to external https history entry is refused`() {
        val allowedOrigin = "https://zcode.example.test"
        val previousEntry = "https://www.wikipedia.org/wiki/Main_Page"
        assertFalse(EntryLinkPolicy.isSameOrigin(allowedOrigin, originOf(previousEntry)))
    }

    @Test
    fun `back to credential-bearing history entry is refused`() {
        val allowedOrigin = "https://zcode.example.test"
        val previousEntry = "https://zcode.example.test/?token=old"
        // Same origin but the entry carries a credential query: such entries
        // never appear in the history this shell creates, and any future
        // navigation to a credential-bearing URL must be refused.
        assertTrue(EntryLinkPolicy.hasCredentialInQuery(previousEntry))
        // The same-origin rule alone is not what protects here; the credential
        // guard in navigation handling does.
    }

    @Test
    fun `unparsable history entry is never same-origin`() {
        val allowedOrigin = "https://zcode.example.test"
        assertFalse(EntryLinkPolicy.isSameOrigin(allowedOrigin, originOf(":::bad:::")))
    }

    private fun originOf(url: String): String? {
        val uri = try {
            java.net.URI(url)
        } catch (e: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        return scheme + "://" + host + if (uri.port != -1) ":${uri.port}" else ""
    }
}
