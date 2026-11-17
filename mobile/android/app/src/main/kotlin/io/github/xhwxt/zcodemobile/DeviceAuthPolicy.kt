package io.github.xhwxt.zcodemobile

/**
 * Pure-JVM contract for the per-device credential protocol
 * (spec: `mobile/handoff/zcode-device-credential-spec.md` §6).
 *
 * Everything the client needs to agree with the server about lives here — paths,
 * request bodies, response parsing, failure classification, cookie assembly — so
 * the whole protocol is unit-testable on the JVM without a device, and a field
 * rename on the server side touches exactly one file.
 *
 * No Android imports on purpose.
 */
object DeviceAuthPolicy {

    const val REDEEM_PATH: String = "/api/pairing/redeem"
    const val RENEW_PATH: String = "/api/auth/renew"
    const val PROBE_PATH: String = "/api/auth/probe"

    /** Device label cap (mirrors dsh-mobile's bridge policy). */
    const val LABEL_MAX_CHARS: Int = 64

    /**
     * Default cookie names. The server may name them differently in the
     * response; the shell injects whatever it is told (and falls back to these).
     */
    const val DEFAULT_SESSION_COOKIE: String = "zcode_device_session"
    const val DEFAULT_CSRF_COOKIE: String = "zcode_device_csrf"

    /**
     * Renewal cookie the server plants for silent session re-issuance. It never
     * reaches the WebView jar on its own: the shell talks to the pairing/renew
     * endpoints over HttpURLConnection, whose Set-Cookie headers the WebView
     * does not record — so the shell mirrors it explicitly (see [cookieHeaders]).
     */
    const val RENEW_COOKIE: String = "zcode_device_renew"

    /** Full non-sliding device lifetime the server grants on redeem. */
    private const val FULL_DEVICE_LIFETIME_MS: Long = 90L * 24 * 60 * 60 * 1000

    /** Slack for clock skew / request latency before a full device reads temporary. */
    private const val TEMPORARY_SLACK_MS: Long = 60L * 60 * 1000

    /** A device credential: long-lived, per device, stored in the Keystore. */
    data class Credential(
        val deviceId: String,
        val deviceToken: String,
        val expiresAt: Long,
    )

    /**
     * A short-lived web session derived from a credential. Never persisted.
     *
     * [deviceToken]/[deviceExpiresAt] describe the long-lived device behind the
     * session (deviceToken is the credential itself, never persisted here): the
     * shell mirrors them into the WebView's renewal cookie, see [cookieHeaders].
     * Renew responses carry no device fields, so the renew path fills them from
     * the existing credential.
     */
    data class Session(
        val token: String,
        val expiresAt: Long,
        val csrf: String,
        val sessionCookieName: String,
        val csrfCookieName: String,
        val deviceToken: String = "",
        val deviceExpiresAt: Long = 0L,
    )

    data class Pairing(
        val credential: Credential,
        val session: Session,
        val failure: Failure = Failure.NONE,
    ) {
        val ok: Boolean get() = failure == Failure.NONE
    }

    enum class Failure {
        NONE,

        /** The one-time pairing code was wrong, expired or already used. */
        INVALID_CODE,

        /** Credential unknown or revoked: the device must pair again. */
        UNAUTHORIZED,

        /** 2xx but the body did not match the contract. */
        BAD_RESPONSE,

        /** 5xx or an unexpected status. */
        SERVER_ERROR,

        /** The request never completed (no network, timeout, TLS). */
        NETWORK_ERROR,
    }

    fun redeemBody(code: String, label: String): String =
        org.json.JSONObject()
            .put("code", code)
            .put("label", sanitizeLabel(label))
            .toString()

    fun renewBody(deviceToken: String): String =
        org.json.JSONObject().put("deviceToken", deviceToken).toString()

    fun probeBody(deviceToken: String): String =
        org.json.JSONObject().put("deviceToken", deviceToken).toString()

    /** Single-line, trimmed, length-capped device label. */
    fun sanitizeLabel(raw: String?): String =
        NotificationTextPolicy.sanitize(raw, LABEL_MAX_CHARS)

    /** Maps a transport status onto the protocol failure space. */
    fun failureForStatus(status: Int): Failure = when {
        status in 200..299 -> Failure.NONE
        status == 403 -> Failure.INVALID_CODE
        status == 401 -> Failure.UNAUTHORIZED
        status >= 500 -> Failure.SERVER_ERROR
        else -> Failure.SERVER_ERROR
    }

    fun isExpired(expiresAt: Long, now: Long): Boolean = expiresAt <= now

    /**
     * True when the device has less than a full (non-sliding) 90-day lifetime
     * left, i.e. it was created as a temporary device. The hour of slack absorbs
     * clock skew and request latency, so a full-lifetime device never reads as
     * temporary.
     */
    fun isTemporary(deviceExpiresAt: Long, now: Long): Boolean {
        val remaining = deviceExpiresAt - now
        return remaining < FULL_DEVICE_LIFETIME_MS - TEMPORARY_SLACK_MS
    }

    /**
     * Parses a redeem/renew response.
     *
     * [existingCredential] is supplied for renew, where the server echoes no
     * credential; a redeem response must carry one. Renew responses also lack
     * the device fields of the session, so those are filled from the existing
     * credential (the device lifetime is unchanged by a renew).
     */
    fun parsePairing(json: String, existingCredential: Credential? = null): Pairing {
        val root = try {
            org.json.JSONObject(json)
        } catch (e: Exception) {
            return Pairing(
                credential = existingCredential ?: Credential("", "", 0L),
                session = emptySession(),
                failure = Failure.BAD_RESPONSE,
            )
        }

        val sessionToken = root.optString("sessionToken", "")
        if (sessionToken.isEmpty()) {
            return Pairing(
                credential = existingCredential ?: Credential("", "", 0L),
                session = emptySession(),
                failure = Failure.BAD_RESPONSE,
            )
        }

        val credential = existingCredential ?: Credential(
            deviceId = root.optString("deviceId", ""),
            deviceToken = root.optString("deviceToken", ""),
            expiresAt = parseExpiry(root.opt("deviceExpiresAt")) ?: 0L,
        )
        if (credential.deviceToken.isEmpty()) {
            return Pairing(
                credential = credential,
                session = emptySession(),
                failure = Failure.BAD_RESPONSE,
            )
        }

        val session = Session(
            token = sessionToken,
            expiresAt = parseExpiry(root.opt("sessionExpiresAt")) ?: 0L,
            csrf = root.optString("csrfToken", ""),
            sessionCookieName = root.optString("sessionCookieName", DEFAULT_SESSION_COOKIE)
                .ifEmpty { DEFAULT_SESSION_COOKIE },
            csrfCookieName = root.optString("csrfCookieName", DEFAULT_CSRF_COOKIE)
                .ifEmpty { DEFAULT_CSRF_COOKIE },
            deviceToken = credential.deviceToken,
            deviceExpiresAt = credential.expiresAt,
        )
        return Pairing(credential = credential, session = session)
    }

    /** A session shape used for every failure return; nothing is injected from it. */
    private fun emptySession() = Session(
        token = "",
        expiresAt = 0L,
        csrf = "",
        sessionCookieName = DEFAULT_SESSION_COOKIE,
        csrfCookieName = DEFAULT_CSRF_COOKIE,
    )

    /** Parses a probe response; only the instance id is of interest. */
    fun parseProbe(json: String): Pair<String?, Failure> = try {
        val root = org.json.JSONObject(json)
        val reachable = root.optBoolean("reachable", false)
        if (reachable) root.optString("instanceId", "").takeIf { it.isNotEmpty() } to Failure.NONE
        else null to Failure.UNAUTHORIZED
    } catch (e: Exception) {
        null to Failure.BAD_RESPONSE
    }

    /**
     * Extracts the renewal-cookie token from a WebView Cookie header string.
     *
     * Used by the keep-alive probe as its third fallback: when neither the
     * page-verified cache nor the shell's Keystore holds a device token, the
     * page may still authenticate through the renewal cookie the shell planted
     * (or the page's own pairing planted) in the WebView cookie jar. The server
     * accepts that cookie on `/api/auth/renew` as credential source, so a renew
     * exchanged with it yields the device token the probe needs.
     *
     * Pure string work: [android.webkit.CookieManager].getCookie returns one
     * `name=value` header joined with "; ". Name comparison is exact
     * (case-sensitive); blank values are rejected; cookie attributes
     * (`; HttpOnly` etc.) only ever follow the value, never precede it, so a
     * plain split on the first '=' per pair is safe.
     */
    fun renewCookieTokenFromHeader(cookieHeader: String?): String? {
        if (cookieHeader.isNullOrBlank()) return null
        for (pair in cookieHeader.split(';')) {
            val item = pair.trim()
            if (!item.startsWith("$RENEW_COOKIE=")) continue
            val value = item.substring(RENEW_COOKIE.length + 1).trim()
            return value.takeIf { it.isNotEmpty() }
        }
        return null
    }

    /**
     * Expiry values are accepted as epoch millis or as an ISO-8601 string,
     * because the existing pairing endpoint already emits ISO strings.
     */
    fun parseExpiry(raw: Any?): Long? = when (raw) {
        null -> null
        is Number -> raw.toLong()
        is String -> parseIso8601(raw)
        else -> null
    }

    private fun parseIso8601(value: String): Long? = try {
        java.time.Instant.parse(value).toEpochMilli()
    } catch (e: Exception) {
        value.toLongOrNull()
    }

    /**
     * Cookie headers the shell installs into the WebView after a redeem or
     * renew. `HttpOnly` on the session cookie; the CSRF cookie stays readable
     * by the page (no `HttpOnly`) but the server must not *require* it yet — the
     * ZCode page does not send a CSRF header today.
     *
     * The third entry mirrors the server's renewal cookie
     * ([RENEW_COOKIE], value = the device token) into the WebView's jar: the
     * shell reaches the pairing/renew endpoints over HttpURLConnection, whose
     * Set-Cookie headers the WebView never records, and without this cookie in
     * the jar the page's own "session invalid → silent re-issue" self-healing
     * has nothing to work with. Max-Age is the device's remaining lifetime
     * (seconds, floored); when it is not positive the entry is omitted — the
     * server heals only from a live value, so an expired device must not look
     * renewed. The renewal cookie is HttpOnly: the page never reads it.
     */
    fun cookieHeaders(session: Session): List<String> {
        val base = listOf(
            "${session.sessionCookieName}=${session.token}; Path=/; Secure; HttpOnly; SameSite=Strict",
            "${session.csrfCookieName}=${session.csrf}; Path=/; Secure; SameSite=Strict",
        )
        if (session.deviceToken.isEmpty()) return base
        val remainingSeconds = (session.deviceExpiresAt - System.currentTimeMillis()) / 1000L
        if (remainingSeconds <= 0L) return base
        return base + listOf(
            "$RENEW_COOKIE=${session.deviceToken}; Path=/; Secure; HttpOnly; " +
                "SameSite=Strict; Max-Age=$remainingSeconds",
        )
    }
}
