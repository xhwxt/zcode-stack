package io.github.xhwxt.zcodemobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure JVM tests for [EntryLinkPolicy]. No Android framework classes involved.
 *
 * Spec mapping: accepted URL shapes, malformed URI,
 * user-info, port boundaries, origin/similar-host decisions, external
 * credential links, HTTP rejection, query encoding/duplicates/extra params,
 * safe-navigation decisions, download rejection text, and the rule that error
 * messages never echo the supplied input.
 */
class EntryLinkPolicyTest {

    // -- accepted forms -----------------------------------------------------

    @Test
    fun `accepts root path with token`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test/?token=abc123")
        assertTrue(result.valid)
        assertEquals("/", result.path)
        assertEquals("zcode.example.test", result.host)
        assertEquals("https", result.scheme)
        assertNull(result.port)
        assertEquals("https://zcode.example.test/?token=abc123", result.url)
    }

    @Test
    fun `accepts web-remote path with remoteControlToken`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test/web-remote?remoteControlToken=xyz789")
        assertTrue(result.valid)
        assertEquals("/web-remote", result.path)
        assertEquals("zcode.example.test", result.host)
        assertEquals("xyz789", result.url?.substringAfter("remoteControlToken="))
    }

    @Test
    fun `accepts explicit port 443`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test:443/?token=t")
        assertTrue(result.valid)
        assertEquals(443, result.port)
    }

    @Test
    fun `accepts custom port in range`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test:8443/web-remote?remoteControlToken=t")
        assertTrue(result.valid)
        assertEquals(8443, result.port)
    }

    @Test
    fun `preserves fragment without rewriting`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test/?token=t#section")
        assertTrue(result.valid)
        assertEquals("https://zcode.example.test/?token=t#section", result.url)
    }

    // -- malformed / null / empty -------------------------------------------

    @Test
    fun `rejects null input`() {
        val result = EntryLinkPolicy.validate(null)
        assertFalse(result.valid)
        assertEquals(EntryLinkPolicy.ERROR_LINK_REQUIRED, result.error)
    }

    @Test
    fun `rejects blank input`() {
        val result = EntryLinkPolicy.validate("   ")
        assertFalse(result.valid)
        assertEquals(EntryLinkPolicy.ERROR_LINK_REQUIRED, result.error)
    }

    @Test
    fun `rejects malformed URI`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test:port/?token=t")
        assertFalse(result.valid)
        assertFalse(errorMentionsInput(result, "port"))
    }

    @Test
    fun `rejects empty host`() {
        assertFalse(EntryLinkPolicy.validate("https:///?token=t").valid)
    }

    @Test
    fun `rejects missing scheme`() {
        assertFalse(EntryLinkPolicy.validate("zcode.example.test/?token=t").valid)
    }

    // -- user-info -----------------------------------------------------------

    @Test
    fun `rejects user-info with credentials`() {
        val result = EntryLinkPolicy.validate("https://user:pass@zcode.example.test/?token=t")
        assertFalse(result.valid)
        assertFalse(errorMentionsInput(result, "user"))
        assertFalse(errorMentionsInput(result, "pass"))
    }

    // -- HTTP / other schemes -------------------------------------------------

    @Test
    fun `rejects http`() {
        val result = EntryLinkPolicy.validate("http://zcode.example.test/?token=t")
        assertFalse(result.valid)
        assertEquals(EntryLinkPolicy.ERROR_NOT_HTTPS, result.error)
    }

    @Test
    fun `rejects javascript scheme`() {
        assertFalse(EntryLinkPolicy.validate("javascript:alert(1)").valid)
    }

    @Test
    fun `rejects data scheme`() {
        assertFalse(EntryLinkPolicy.validate("data:text/html,hello").valid)
    }

    @Test
    fun `rejects file scheme`() {
        assertFalse(EntryLinkPolicy.validate("file:///etc/passwd").valid)
    }

    @Test
    fun `rejects intent scheme`() {
        assertFalse(EntryLinkPolicy.validate("intent://example.com/#Intent;scheme=https;end").valid)
    }

    // -- port boundaries -------------------------------------------------------

    @Test
    fun `rejects port 0`() {
        assertFalse(EntryLinkPolicy.validate("https://zcode.example.test:0/?token=t").valid)
    }

    @Test
    fun `accepts port 1`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test:1/?token=t")
        assertTrue(result.valid)
        assertEquals(1, result.port)
    }

    @Test
    fun `accepts port 65535`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test:65535/?token=t")
        assertTrue(result.valid)
        assertEquals(65535, result.port)
    }

    @Test
    fun `rejects port 65536`() {
        assertFalse(EntryLinkPolicy.validate("https://zcode.example.test:65536/?token=t").valid)
    }

    @Test
    fun `rejects unparsable port`() {
        assertFalse(EntryLinkPolicy.validate("https://zcode.example.test:abc/?token=t").valid)
    }

    // -- path rules --------------------------------------------------------------

    @Test
    fun `rejects unknown path`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test/some/page?token=t")
        assertFalse(result.valid)
        assertEquals(EntryLinkPolicy.ERROR_UNSUPPORTED_PAGE, result.error)
    }

    @Test
    fun `rejects path with trailing slash beyond accepted forms`() {
        assertFalse(EntryLinkPolicy.validate("https://zcode.example.test/web-remote/?remoteControlToken=t").valid)
    }

    @Test
    fun `rejects case-mismatched path`() {
        assertFalse(EntryLinkPolicy.validate("https://zcode.example.test/Web-Remote?remoteControlToken=t").valid)
    }

    @Test
    fun `rejects percent-encoded path`() {
        assertFalse(EntryLinkPolicy.validate("https://zcode.example.test/%77eb-remote?remoteControlToken=t").valid)
    }

    // -- query parameter rules ------------------------------------------------------

    @Test
    fun `rejects root path with wrong credential parameter`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test/?remoteControlToken=t")
        assertFalse(result.valid)
        assertEquals(EntryLinkPolicy.ERROR_CREDENTIAL_MISSING, result.error)
    }

    @Test
    fun `rejects web-remote path with wrong credential parameter`() {
        assertFalse(EntryLinkPolicy.validate("https://zcode.example.test/web-remote?token=t").valid)
    }

    @Test
    fun `accepts bare origin as the pairing entry`() {
        // The server's URL-token direct connect can be switched off; the bare
        // origin then leads to the pairing login page, which is sign-in, not an
        // error, so it must be accepted without a credential.
        val result = EntryLinkPolicy.validate("https://zcode.example.test/")
        assertTrue(result.valid)
        assertEquals("/", result.path)
    }

    @Test
    fun `accepts pairing page as an entry`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test/api/pairing/page")
        assertTrue(result.valid)
        assertEquals(EntryLinkPolicy.PAIRING_PATH, result.path)
    }

    @Test
    fun `rejects pairing page with a stray query`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test/api/pairing/page?token=abc")
        assertFalse(result.valid)
    }

    @Test
    fun `rejects empty credential on a token link`() {
        assertFalse(EntryLinkPolicy.validate("https://zcode.example.test/?token=").valid)
    }

    @Test
    fun `rejects duplicated credential parameter`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test/?token=a&token=b")
        assertFalse(result.valid)
        assertEquals(EntryLinkPolicy.ERROR_EXTRA_PARAMETERS, result.error)
    }

    @Test
    fun `rejects extra parameters alongside credential`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test/?token=a&utm_source=mail")
        assertFalse(result.valid)
        assertEquals(EntryLinkPolicy.ERROR_EXTRA_PARAMETERS, result.error)
    }

    @Test
    fun `rejects extra parameters on web-remote`() {
        assertFalse(EntryLinkPolicy.validate("https://zcode.example.test/web-remote?remoteControlToken=a&extra=1").valid)
    }

    @Test
    fun `accepts percent-encoded credential value`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test/?token=a%2Bb%3Dc")
        assertTrue(result.valid)
        assertEquals("/", result.path)
    }

    @Test
    fun `rejects query parameter with empty name`() {
        assertFalse(EntryLinkPolicy.validate("https://zcode.example.test/?=value").valid)
    }

    // -- origin decisions ---------------------------------------------------------------

    @Test
    fun `same origin matches`() {
        assertTrue(
            EntryLinkPolicy.isSameOrigin(
                "https://zcode.example.test",
                "https://zcode.example.test/page",
            ),
        )
    }

    @Test
    fun `same origin matches ignoring default port`() {
        assertTrue(
            EntryLinkPolicy.isSameOrigin(
                "https://zcode.example.test",
                "https://zcode.example.test:443",
            ),
        )
    }

    @Test
    fun `similar host is a different origin`() {
        // evil-zcode.example.test vs zcode.example.test
        assertFalse(
            EntryLinkPolicy.isSameOrigin(
                "https://zcode.example.test",
                "https://evil-zcode.example.test",
            ),
        )
    }

    @Test
    fun `suffix trick host is a different origin`() {
        assertFalse(
            EntryLinkPolicy.isSameOrigin(
                "https://zcode.example.test",
                "https://zcode.example.test.evil.example",
            ),
        )
    }

    @Test
    fun `different scheme is a different origin`() {
        assertFalse(
            EntryLinkPolicy.isSameOrigin(
                "https://zcode.example.test",
                "http://zcode.example.test",
            ),
        )
    }

    @Test
    fun `different port is a different origin`() {
        assertFalse(
            EntryLinkPolicy.isSameOrigin(
                "https://zcode.example.test",
                "https://zcode.example.test:8443",
            ),
        )
    }

    @Test
    fun `case-insensitive host comparison`() {
        assertTrue(
            EntryLinkPolicy.isSameOrigin(
                "https://ZCODE.EXAMPLE.TEST",
                "https://zcode.example.test",
            ),
        )
    }

    @Test
    fun `null origins never match`() {
        assertFalse(EntryLinkPolicy.isSameOrigin(null, "https://zcode.example.test"))
        assertFalse(EntryLinkPolicy.isSameOrigin("https://zcode.example.test", null))
        assertFalse(EntryLinkPolicy.isSameOrigin(null, null))
    }

    // -- credential detection in external URLs ------------------------------------------

    @Test
    fun `flags token in external url`() {
        assertTrue(EntryLinkPolicy.hasCredentialInQuery("https://other.example/?token=leak"))
    }

    @Test
    fun `flags remoteControlToken in external url`() {
        assertTrue(EntryLinkPolicy.hasCredentialInQuery("https://other.example/web-remote?remoteControlToken=leak"))
    }

    @Test
    fun `clean external url has no credential`() {
        assertFalse(EntryLinkPolicy.hasCredentialInQuery("https://other.example/page"))
    }

    @Test
    fun `unparsable url is treated as credential-bearing`() {
        assertTrue(EntryLinkPolicy.hasCredentialInQuery("::::"))
    }

    // -- host validation edge cases ---------------------------------------------------

    @Test
    fun `accepts single trailing dot host`() {
        val result = EntryLinkPolicy.validate("https://zcode.example.test./?token=t")
        assertTrue(result.valid)
    }

    @Test
    fun `rejects host with double trailing dot`() {
        assertFalse(EntryLinkPolicy.validate("https://zcode.example.test../?token=t").valid)
    }

    @Test
    fun `rejects host with underscore`() {
        assertFalse(EntryLinkPolicy.validate("https://bad_host.example/?token=t").valid)
    }

    @Test
    fun `rejects host with embedded at-sign`() {
        assertFalse(EntryLinkPolicy.validate("https://bad@host.example/?token=t").valid)
    }

    @Test
    fun `rejects host with embedded slash`() {
        assertFalse(EntryLinkPolicy.validate("https://bad/host/?token=t").valid)
    }

    @Test
    fun `rejects host with whitespace`() {
        assertFalse(EntryLinkPolicy.validate("https://bad host/?token=t").valid)
    }

    @Test
    fun `rejects empty label host`() {
        assertFalse(EntryLinkPolicy.validate("https://bad..example/?token=t").valid)
    }

    // -- download text -----------------------------------------------------------------

    @Test
    fun `download message states unsupported and contains no url`() {
        val message = EntryLinkPolicy.DOWNLOAD_UNSUPPORTED
        assertTrue(message.contains("不支持下载"))
        assertFalse(message.contains("http"))
    }

    // -- error text discipline ----------------------------------------------------------

    @Test
    fun `error messages never echo the input`() {
        val inputs = listOf(
            "http://zcode.example.test/?token=SECRET1",
            "https://user:pass@zcode.example.test/?token=SECRET2",
            "https://zcode.example.test:70000/?token=SECRET3",
            "https://zcode.example.test/admin?token=SECRET4",
            "https://zcode.example.test/?token=a&token=b",
            "https://zcode.example.test/?token=a&x=1",
            "not a url at all",
        )
        inputs.forEach { input ->
            val result = EntryLinkPolicy.validate(input)
            if (!result.valid) {
                assertFalse(errorMentionsInput(result, input))
            }
        }
    }

    private fun errorMentionsInput(result: EntryLinkPolicy.Result, input: String): Boolean {
        val error = result.error ?: return false
        // Only identifying fragments (hosts, credential values, user info) count as
        // an echo. The scheme words "http"/"https" legitimately appear in guidance
        // text like "只支持 HTTPS 链接" and are not part of the secret.
        val schemeWords = setOf("http", "https")
        return input.split('?', '@', ':', '/', '&', '=', ' ')
            .filter { it.length >= 3 }
            .filterNot { it.lowercase() in schemeWords }
            .any { fragment -> error.contains(fragment, ignoreCase = true) }
    }
}
