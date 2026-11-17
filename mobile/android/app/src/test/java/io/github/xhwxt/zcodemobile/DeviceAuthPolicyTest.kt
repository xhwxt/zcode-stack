package io.github.xhwxt.zcodemobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceAuthPolicyTest {

    @Test
    fun `failure space maps transport statuses`() {
        assertEquals(DeviceAuthPolicy.Failure.NONE, DeviceAuthPolicy.failureForStatus(200))
        assertEquals(DeviceAuthPolicy.Failure.NONE, DeviceAuthPolicy.failureForStatus(204))
        assertEquals(DeviceAuthPolicy.Failure.INVALID_CODE, DeviceAuthPolicy.failureForStatus(403))
        assertEquals(DeviceAuthPolicy.Failure.UNAUTHORIZED, DeviceAuthPolicy.failureForStatus(401))
        assertEquals(DeviceAuthPolicy.Failure.SERVER_ERROR, DeviceAuthPolicy.failureForStatus(500))
        assertEquals(DeviceAuthPolicy.Failure.SERVER_ERROR, DeviceAuthPolicy.failureForStatus(418))
    }

    @Test
    fun `label is single line and capped`() {
        assertEquals("手机 A", DeviceAuthPolicy.sanitizeLabel("  手机\nA  "))
        assertEquals(DeviceAuthPolicy.LABEL_MAX_CHARS, DeviceAuthPolicy.sanitizeLabel("x".repeat(200)).length)
        assertEquals("", DeviceAuthPolicy.sanitizeLabel(null))
    }

    @Test
    fun `both expiry encodings are accepted`() {
        // Real epoch millis for these ISO-8601 inputs.
        assertEquals(1_893_369_600_000L, DeviceAuthPolicy.parseExpiry("2029-12-31T00:00:00Z"))
        assertEquals(4_102_444_800_000L, DeviceAuthPolicy.parseExpiry("2100-01-01T00:00:00Z"))
        assertEquals(1_700_000_000_000L, DeviceAuthPolicy.parseExpiry(1_700_000_000_000L))
        assertEquals(null, DeviceAuthPolicy.parseExpiry("nonsense"))
    }

    @Test
    fun `expiry decision is boundary inclusive`() {
        assertFalse(DeviceAuthPolicy.isExpired(2_000L, 1_000L))
        assertTrue(DeviceAuthPolicy.isExpired(1_000L, 1_000L))
        assertTrue(DeviceAuthPolicy.isExpired(1_000L, 2_000L))
    }

    @Test
    fun `cookie headers carry session and csrf with the agreed attributes`() {
        val session = DeviceAuthPolicy.Session(
            token = "st",
            expiresAt = 1L,
            csrf = "csrf",
            sessionCookieName = "zcode_device_session",
            csrfCookieName = "zcode_device_csrf",
            deviceToken = "dt",
            deviceExpiresAt = System.currentTimeMillis() + 60_000L,
        )
        val cookies = DeviceAuthPolicy.cookieHeaders(session)
        assertEquals(3, cookies.size)
        assertTrue(cookies[0], cookies[0].startsWith("zcode_device_session=st;"))
        assertTrue(cookies[0], cookies[0].contains("HttpOnly"))
        assertTrue(cookies[0], cookies[0].contains("Secure"))
        assertTrue(cookies[0], cookies[0].contains("SameSite=Strict"))
        // CSRF stays readable by the page.
        assertFalse(cookies[1], cookies[1].contains("HttpOnly"))
    }

    @Test
    fun `renew cookie is the third header with device lifetime as max-age`() {
        val now = System.currentTimeMillis()
        val session = DeviceAuthPolicy.Session(
            token = "st", expiresAt = 1L, csrf = "csrf",
            sessionCookieName = "zcode_device_session", csrfCookieName = "zcode_device_csrf",
            deviceToken = "dt", deviceExpiresAt = now + 90 * 60_000L, // 90 minutes
        )
        val cookies = DeviceAuthPolicy.cookieHeaders(session)
        assertEquals(3, cookies.size)
        val renew = cookies[2]
        assertTrue(renew, renew.startsWith("${DeviceAuthPolicy.RENEW_COOKIE}=dt;"))
        assertTrue(renew, renew.contains("Path=/"))
        assertTrue(renew, renew.contains("Secure"))
        assertTrue(renew, renew.contains("HttpOnly"))
        assertTrue(renew, renew.contains("SameSite=Strict"))
        // 90 minutes left → 5400 seconds.
        assertTrue(renew, renew.contains("Max-Age=5400"))
    }

    @Test
    fun `renew cookie is dropped when the device has no time left`() {
        val now = System.currentTimeMillis()
        fun session(expiresAt: Long) = DeviceAuthPolicy.Session(
            token = "st", expiresAt = 1L, csrf = "csrf",
            sessionCookieName = "zcode_device_session", csrfCookieName = "zcode_device_csrf",
            deviceToken = "dt", deviceExpiresAt = expiresAt,
        )
        // Exactly now: zero remaining → dropped.
        assertEquals(2, DeviceAuthPolicy.cookieHeaders(session(now)).size)
        // In the past: negative remaining → dropped.
        assertEquals(2, DeviceAuthPolicy.cookieHeaders(session(now - 1L)).size)
        // Well past the floor: cookie is kept. The margin must comfortably
        // exceed the millisecond drift between `now` here and the second
        // clock read inside cookieHeaders — a 1s margin was flaky at that
        // boundary (999 ms remaining floors to 0), so use 60s like the
        // neighbouring tests and assert on the floored second count.
        val expiry = now + 60_000L
        val cookies = DeviceAuthPolicy.cookieHeaders(session(expiry))
        assertEquals(3, cookies.size)
        val maxAge = Regex("Max-Age=(\\d+)").find(cookies[2])!!.groupValues[1].toLong()
        assertTrue("Max-Age=$maxAge must be 59..60", maxAge in 59..60)
    }

    @Test
    fun `renew cookie is skipped without a device token`() {
        val session = DeviceAuthPolicy.Session(
            token = "st", expiresAt = 1L, csrf = "csrf",
            sessionCookieName = "zcode_device_session", csrfCookieName = "zcode_device_csrf",
            deviceToken = "", deviceExpiresAt = System.currentTimeMillis() + 60_000L,
        )
        assertEquals(2, DeviceAuthPolicy.cookieHeaders(session).size)
    }

    @Test
    fun `redeem response fills session device fields`() {
        val now = System.currentTimeMillis()
        val json = """{"deviceId":"d1","deviceToken":"dt","deviceExpiresAt":${
            now + 24 * 3_600_000L
        },"sessionToken":"s1","sessionExpiresAt":${now + 3_600_000L},"csrfToken":"c1"}"""
        val pairing = DeviceAuthPolicy.parsePairing(json)
        assertTrue(pairing.ok)
        assertEquals("dt", pairing.credential.deviceToken)
        assertEquals("dt", pairing.session.deviceToken)
        assertEquals(now + 24 * 3_600_000L, pairing.session.deviceExpiresAt)
    }

    @Test
    fun `renew response inherits device fields from the existing credential`() {
        val json = """{"sessionToken":"s2","sessionExpiresAt":123}"""
        val existing = DeviceAuthPolicy.Credential(
            deviceId = "d1",
            deviceToken = "dt-old",
            expiresAt = 4_567L,
        )
        val pairing = DeviceAuthPolicy.parsePairing(json, existing)
        assertTrue(pairing.ok)
        assertEquals("dt-old", pairing.credential.deviceToken)
        assertEquals(4_567L, pairing.credential.expiresAt)
        assertEquals("dt-old", pairing.session.deviceToken)
        assertEquals(4_567L, pairing.session.deviceExpiresAt)
    }

    @Test
    fun `temporary marker has one hour of slack below the full lifetime`() {
        val now = System.currentTimeMillis()
        val hour = 3_600_000L
        val full = 90L * 24 * hour
        // Full lifetime minus a day: temporary.
        assertTrue(DeviceAuthPolicy.isTemporary(now + full - 24 * hour, now))
        // Full lifetime: not temporary.
        assertFalse(DeviceAuthPolicy.isTemporary(now + full, now))
        // Full lifetime minus the one-hour slack: still not temporary.
        assertFalse(DeviceAuthPolicy.isTemporary(now + full - hour, now))
        // Just under the slack boundary (first ms below full-minus-one-hour): temporary.
        assertTrue(DeviceAuthPolicy.isTemporary(now + full - hour - 1L, now))
        // Already expired: temporary.
        assertTrue(DeviceAuthPolicy.isTemporary(now, now))
        assertTrue(DeviceAuthPolicy.isTemporary(now - hour, now))
    }

    @Test
    fun `cookie names from the server win over the defaults`() {
        val json = """{"deviceId":"d","deviceToken":"t","sessionToken":"s",
            "sessionCookieName":"custom_s","csrfCookieName":"custom_c"}"""
        val pairing = DeviceAuthPolicy.parsePairing(json)
        assertTrue(pairing.ok)
        val cookies = DeviceAuthPolicy.cookieHeaders(pairing.session)
        assertTrue(cookies[0], cookies[0].startsWith("custom_s=s;"))
        assertTrue(cookies[1], cookies[1].startsWith("custom_c="))
    }

    // --- renew-cookie header extraction (probe credential fallback, 0.1.4) --

    @Test
    fun `renew cookie token is extracted from a full cookie header`() {
        val header = "zcode_device_session=st-1; zcode_device_csrf=csrf-1; " +
            "${DeviceAuthPolicy.RENEW_COOKIE}=dt-secret"
        assertEquals("dt-secret", DeviceAuthPolicy.renewCookieTokenFromHeader(header))
    }

    @Test
    fun `renew cookie is found among unrelated cookies and after attributes`() {
        // The jar can hold third-party cookies around it; values may even look
        // like attributes. Only the exact name matches.
        val header = "other=x;y=2; ${DeviceAuthPolicy.RENEW_COOKIE}=tok; HttpOnly; Path=/"
        assertEquals("tok", DeviceAuthPolicy.renewCookieTokenFromHeader(header))
    }

    @Test
    fun `renew cookie extraction rejects blank missing and wrong-name values`() {
        // No header at all / empty header.
        assertNull(DeviceAuthPolicy.renewCookieTokenFromHeader(null))
        assertNull(DeviceAuthPolicy.renewCookieTokenFromHeader(""))
        // Jar holds other cookies but not the renewal one.
        assertNull(
            DeviceAuthPolicy.renewCookieTokenFromHeader("zcode_device_session=st; csrf=c"),
        )
        // Cookie present but empty value: useless as a credential.
        assertNull(
            DeviceAuthPolicy.renewCookieTokenFromHeader("${DeviceAuthPolicy.RENEW_COOKIE}=; other=1"),
        )
        // Prefix lookalikes must not match the exact name.
        assertNull(
            DeviceAuthPolicy.renewCookieTokenFromHeader("${DeviceAuthPolicy.RENEW_COOKIE}_x=v"),
        )
        // Case-sensitive name: a lookalike case must not match.
        assertNull(
            DeviceAuthPolicy.renewCookieTokenFromHeader(
                DeviceAuthPolicy.RENEW_COOKIE.replaceFirstChar { it.uppercase() } + "=v",
            ),
        )
    }

    @Test
    fun `renew cookie extraction tolerates whitespace around pairs`() {
        // CookieManager.getCookie emits "name=value; name2=value2" — the only
        // whitespace in play is after ";" separators and around the value, both
        // trimmed. (Space *before* the "=" is not a format getCookie produces
        // and is deliberately not accepted: the exact-name match stays strict.)
        val header = "a=1 ;  ${DeviceAuthPolicy.RENEW_COOKIE}= spaced  ; b=2"
        assertEquals("spaced", DeviceAuthPolicy.renewCookieTokenFromHeader(header))
    }
}
