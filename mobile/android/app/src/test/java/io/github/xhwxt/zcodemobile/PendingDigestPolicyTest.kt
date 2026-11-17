package io.github.xhwxt.zcodemobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PendingDigestPolicyTest {

    @Test
    fun `digest text is parsed from a permission digest`() {
        val body = """
            {"reachable":true,"pendingInteractions":1,
             "pendingDigest":{"kind":"permission","text":"是否允许执行 git push"}}
        """.trimIndent()
        assertEquals("是否允许执行 git push", PendingDigestPolicy.textFrom(body))
    }

    @Test
    fun `digest text is parsed from a user-input digest`() {
        val body = """{"pendingInteractions":2,"pendingDigest":{"kind":"userInput","text":"请选择要部署的环境"}}"""
        assertEquals("请选择要部署的环境", PendingDigestPolicy.textFrom(body))
    }

    @Test
    fun `text is trimmed`() {
        val body = """{"pendingDigest":{"kind":"userInput","text":"  hello  "}}"""
        assertEquals("hello", PendingDigestPolicy.textFrom(body))
    }

    // --- absence / malformed input must never change existing behavior --------

    @Test
    fun `absent field yields null so the caller keeps the count-only behavior`() {
        // Older server: no pendingDigest at all — null means "behave as before".
        assertNull(PendingDigestPolicy.textFrom("""{"reachable":true,"pendingInteractions":1}"""))
    }

    @Test
    fun `null and blank bodies yield null`() {
        assertNull(PendingDigestPolicy.textFrom(null))
        assertNull(PendingDigestPolicy.textFrom(""))
        assertNull(PendingDigestPolicy.textFrom("   "))
    }

    @Test
    fun `unparsable json yields null`() {
        assertNull(PendingDigestPolicy.textFrom("not json"))
        assertNull(PendingDigestPolicy.textFrom("{"))
    }

    @Test
    fun `non-object digest values yield null`() {
        assertNull(PendingDigestPolicy.textFrom("""{"pendingDigest":null}"""))
        assertNull(PendingDigestPolicy.textFrom("""{"pendingDigest":"oops"}"""))
        assertNull(PendingDigestPolicy.textFrom("""{"pendingDigest":42}"""))
    }

    @Test
    fun `digest without usable text yields null`() {
        assertNull(PendingDigestPolicy.textFrom("""{"pendingDigest":{}}"""))
        assertNull(PendingDigestPolicy.textFrom("""{"pendingDigest":{"kind":"permission"}}"""))
        assertNull(PendingDigestPolicy.textFrom("""{"pendingDigest":{"text":""}}"""))
        assertNull(PendingDigestPolicy.textFrom("""{"pendingDigest":{"text":"   "}}"""))
    }
}
