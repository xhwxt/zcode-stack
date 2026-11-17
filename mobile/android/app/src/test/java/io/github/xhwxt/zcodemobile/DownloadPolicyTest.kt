package io.github.xhwxt.zcodemobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure JVM tests for [DownloadPolicy]. No Android framework classes involved.
 *
 * Coverage: same-origin / cross-origin / non-HTTPS / unparsable / user-info /
 * credential-bearing decisions, cookie attachment, file-name resolution
 * (Content-Disposition extended and plain, URL path, timestamp fallback,
 * sanitization, length cap) and MIME-type hint sanitation.
 */
class DownloadPolicyTest {

    private val pageOrigin = "https://zcode.example.test"

    private fun decide(
        url: String?,
        disposition: String? = null,
        mimeType: String? = null,
        pageOrigin: String? = this.pageOrigin,
        hasCookies: Boolean = true,
        nowMillis: Long = 1_000_000_000_000L, // 2001-09-09 01:46:40 UTC
    ): DownloadPolicy.Decision =
        DownloadPolicy.decide(url, disposition, mimeType, pageOrigin, hasCookies, nowMillis)

    // -- decision: accept ---------------------------------------------------

    @Test
    fun `same-origin https download is accepted with cookies`() {
        val d = decide("https://zcode.example.test/app/zcode-mobile-0.1.4.apk")
        assertEquals(DownloadPolicy.Action.DOWNLOAD_VIA_MANAGER, d.action)
        assertTrue(d.attachCookies)
    }

    @Test
    fun `same-origin with explicit port matches page origin with port`() {
        val d = decide(
            "https://zcode.example.test:8443/file.bin",
            pageOrigin = "https://zcode.example.test:8443",
        )
        assertEquals(DownloadPolicy.Action.DOWNLOAD_VIA_MANAGER, d.action)
        assertTrue(d.attachCookies)
    }

    @Test
    fun `cross-origin https download is accepted without cookies`() {
        val d = decide("https://mirror.example.com/file.apk")
        assertEquals(DownloadPolicy.Action.DOWNLOAD_VIA_MANAGER, d.action)
        assertFalse(d.attachCookies)
    }

    @Test
    fun `same host different scheme is cross-origin`() {
        // Only https URLs reach this point, so scheme mismatch is unreachable
        // here; a different port still counts as cross-origin.
        val d = decide("https://zcode.example.test:8443/file.bin", pageOrigin = pageOrigin)
        assertEquals(DownloadPolicy.Action.DOWNLOAD_VIA_MANAGER, d.action)
        assertFalse(d.attachCookies)
    }

    @Test
    fun `no cookies in jar means no attachment even same-origin`() {
        val d = decide("https://zcode.example.test/file.bin", hasCookies = false)
        assertEquals(DownloadPolicy.Action.DOWNLOAD_VIA_MANAGER, d.action)
        assertFalse(d.attachCookies)
    }

    @Test
    fun `null page origin never attaches cookies`() {
        val d = decide("https://zcode.example.test/file.bin", pageOrigin = null)
        assertEquals(DownloadPolicy.Action.DOWNLOAD_VIA_MANAGER, d.action)
        assertFalse(d.attachCookies)
    }

    // -- decision: reject ----------------------------------------------------

    @Test
    fun `null url is unsupported`() {
        assertEquals(DownloadPolicy.Action.UNSUPPORTED, decide(null).action)
    }

    @Test
    fun `blank url is unsupported`() {
        assertEquals(DownloadPolicy.Action.UNSUPPORTED, decide("   ").action)
    }

    @Test
    fun `http url is unsupported`() {
        assertEquals(DownloadPolicy.Action.UNSUPPORTED, decide("http://zcode.example.test/file.apk").action)
    }

    @Test
    fun `javascript url is unsupported`() {
        assertEquals(DownloadPolicy.Action.UNSUPPORTED, decide("javascript:alert(1)").action)
    }

    @Test
    fun `blob url is unsupported`() {
        assertEquals(DownloadPolicy.Action.UNSUPPORTED, decide("blob:https://zcode.example.test/uuid").action)
    }

    @Test
    fun `data url is unsupported`() {
        assertEquals(DownloadPolicy.Action.UNSUPPORTED, decide("data:text/plain;base64,aGk=").action)
    }

    @Test
    fun `unparsable url is unsupported`() {
        assertEquals(DownloadPolicy.Action.UNSUPPORTED, decide("https://zcode.example.test:port/file").action)
    }

    @Test
    fun `hostless url is unsupported`() {
        assertEquals(DownloadPolicy.Action.UNSUPPORTED, decide("https:///file").action)
    }

    @Test
    fun `user-info url is unsupported`() {
        assertEquals(
            DownloadPolicy.Action.UNSUPPORTED,
            decide("https://user:pass@zcode.example.test/file").action,
        )
    }

    @Test
    fun `credential-bearing query url is unsupported`() {
        assertEquals(
            DownloadPolicy.Action.UNSUPPORTED,
            decide("https://zcode.example.test/file?token=SECRET").action,
        )
    }

    @Test
    fun `remote-control-token query url is unsupported`() {
        assertEquals(
            DownloadPolicy.Action.UNSUPPORTED,
            decide("https://zcode.example.test/web-remote?remoteControlToken=SECRET").action,
        )
    }

    @Test
    fun `decisions never echo the url`() {
        // The Decision carries no error string, but the file name resolved from
        // a rejected URL must not leak either (it stays empty).
        val d = decide("https://user:pass@zcode.example.test/SECRETNAME")
        assertEquals(DownloadPolicy.Action.UNSUPPORTED, d.action)
        assertEquals("", d.fileName)
        assertNull(d.mimeType)
        assertFalse(d.attachCookies)
    }

    // -- file name: content disposition ---------------------------------------

    @Test
    fun `plain quoted filename wins over url path`() {
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename=\"report.pdf\"",
        )
        assertEquals("report.pdf", d.fileName)
    }

    @Test
    fun `plain unquoted filename works`() {
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename=report.pdf",
        )
        assertEquals("report.pdf", d.fileName)
    }

    @Test
    fun `extended filename-star with utf-8 percent encoding wins`() {
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename=\"fallback.bin\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf",
        )
        assertEquals("报告.pdf", d.fileName)
    }

    @Test
    fun `extended filename-star plain ascii wins over plain filename`() {
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename=\"fallback.bin\"; filename*=ascii''real.txt",
        )
        assertEquals("real.txt", d.fileName)
    }

    @Test
    fun `extended filename-star unknown charset falls back to plain filename`() {
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename=\"ok.bin\"; filename*=gbk''%C4%E3.bin",
        )
        assertEquals("ok.bin", d.fileName)
    }

    @Test
    fun `extended filename-star malformed escape falls back to plain filename`() {
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename=\"ok.bin\"; filename*=UTF-8''%ZZ",
        )
        assertEquals("ok.bin", d.fileName)
    }

    @Test
    fun `filename parameter does not match inside filename-star`() {
        // The plain-name search must skip the extended parameter entirely.
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename*=UTF-8''real.txt",
        )
        assertEquals("real.txt", d.fileName)
    }

    @Test
    fun `filename with path separators is sanitized`() {
        // Quote-pair unescaping keeps the backslashes literal, then
        // sanitization replaces each with an underscore; the result no longer
        // starts with a dot, so no leading-dot strip applies.
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename=\"../../etc/passwd\"",
        )
        assertEquals("_.._etc_passwd", d.fileName)
    }

    @Test
    fun `filename with backslash separator is sanitized`() {
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename=\"C:\\temp\\evil.exe\"",
        )
        assertEquals("C:_temp_evil.exe", d.fileName)
    }

    @Test
    fun `escaped quote inside quoted filename is unescaped`() {
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename=\"a\\\"b.txt\"",
        )
        assertEquals("a\"b.txt", d.fileName)
    }

    @Test
    fun `filename that is only dots falls back to url path`() {
        val d = decide(
            "https://zcode.example.test/files/app.apk",
            disposition = "attachment; filename=\"...\"",
        )
        assertEquals("app.apk", d.fileName)
    }

    @Test
    fun `empty filename value falls back to url path`() {
        val d = decide(
            "https://zcode.example.test/files/app.apk",
            disposition = "attachment; filename=\"\"",
        )
        assertEquals("app.apk", d.fileName)
    }

    // -- file name: url path ---------------------------------------------------

    @Test
    fun `url path last segment is used without disposition`() {
        val d = decide("https://zcode.example.test/app/zcode-mobile-0.1.4.apk")
        assertEquals("zcode-mobile-0.1.4.apk", d.fileName)
    }

    @Test
    fun `percent-encoded url path segment is decoded`() {
        val d = decide("https://zcode.example.test/files/%E6%8A%A5%E5%91%8A.pdf")
        assertEquals("报告.pdf", d.fileName)
    }

    @Test
    fun `malformed percent escape makes the whole url unparsable`() {
        // java.net.URI rejects bad escapes at parse time, so the URL never
        // becomes a download at all (fail-closed), rather than keeping a raw
        // segment.
        assertEquals(DownloadPolicy.Action.UNSUPPORTED, decide("https://zcode.example.test/files/50%off.apk").action)
    }

    @Test
    fun `trailing slash url has no path name and falls back to timestamp`() {
        val d = decide("https://zcode.example.test/downloads/")
        assertEquals("download-20010909-014640", d.fileName)
    }

    @Test
    fun `url without path falls back to timestamp`() {
        val d = decide("https://zcode.example.test")
        assertEquals("download-20010909-014640", d.fileName)
    }

    // -- file name: sanitization and cap -----------------------------------------

    @Test
    fun `control characters are dropped from filename`() {
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename=\"bad\u0007name.txt\"",
        )
        assertEquals("badname.txt", d.fileName)
    }

    @Test
    fun `long filename is capped keeping short extension`() {
        val long = "a".repeat(120) + ".apk"
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename=\"$long\"",
        )
        assertEquals(100, d.fileName.length)
        assertTrue(d.fileName.endsWith(".apk"))
        assertTrue(d.fileName.startsWith("a"))
    }

    @Test
    fun `long filename without usable extension is capped plainly`() {
        val long = "a".repeat(120)
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename=\"$long\"",
        )
        assertEquals(100, d.fileName.length)
        assertTrue(d.fileName.all { it == 'a' })
    }

    @Test
    fun `leading dot is stripped from filename`() {
        val d = decide(
            "https://zcode.example.test/download?id=1",
            disposition = "attachment; filename=\".hidden\"",
        )
        assertEquals("hidden", d.fileName)
    }

    @Test
    fun `resolveFileName standalone timestamp fallback is deterministic`() {
        assertEquals(
            "download-20010909-014640",
            DownloadPolicy.resolveFileName(null, null, 1_000_000_000_000L),
        )
        assertEquals(
            "download-20010909-014640",
            DownloadPolicy.resolveFileName("", "", 1_000_000_000_000L),
        )
    }

    // -- mime-type hint --------------------------------------------------------

    @Test
    fun `well-formed mime type is lowercased and kept`() {
        val d = decide("https://zcode.example.test/app.apk", mimeType = "Application/vnd.android.package-archive")
        assertEquals("application/vnd.android.package-archive", d.mimeType)
    }

    @Test
    fun `mime type without slash is dropped`() {
        assertNull(decide("https://zcode.example.test/app.apk", mimeType = "octet-stream").mimeType)
    }

    @Test
    fun `mime type with parameters is dropped`() {
        assertNull(decide("https://zcode.example.test/file", mimeType = "text/plain; charset=utf-8").mimeType)
    }

    @Test
    fun `empty mime type is dropped`() {
        assertNull(decide("https://zcode.example.test/file", mimeType = "  ").mimeType)
    }

    @Test
    fun `null mime type stays null`() {
        assertNull(decide("https://zcode.example.test/file", mimeType = null).mimeType)
    }

    @Test
    fun `oversized mime type is dropped`() {
        assertNull(decide("https://zcode.example.test/file", mimeType = "a/".padEnd(101, 'b')).mimeType)
    }

    // -- start-failure copy ------------------------------------------------------

    @Test
    fun `start-failed message is static and carries no input`() {
        val message = DownloadPolicy.DOWNLOAD_START_FAILED
        assertTrue(message.contains("下载"))
        assertFalse(message.contains("http"))
        assertFalse(message.contains("Cookie"))
    }
}
