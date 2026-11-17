package io.github.xhwxt.zcodemobile

import java.io.ByteArrayOutputStream
import java.net.URI
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Pure-JVM policy for WebView download requests.
 *
 * The WebView cannot render a download, and the system browser holds no
 * pairing session — a session-protected download URL handed to the browser
 * dead-ends in its 401 page. Decisions:
 *
 *  - HTTPS URL that parses cleanly, carries no embedded user-info and no
 *    credential query parameter → [Action.DOWNLOAD_VIA_MANAGER]: the system
 *    DownloadManager fetches it. Same-origin targets additionally get the
 *    WebView session cookie attached ([Decision.attachCookies]); foreign
 *    origins never do, and no download is handed to the browser.
 *  - Everything else (plain HTTP, blob:/data:, unparsable or hostless URLs,
 *    user-info, credential-bearing query) → [Action.UNSUPPORTED]. Fail-closed.
 *
 * [Action.HAND_OFF_BROWSER] is a decision slot with no current producer:
 * downloads are always resolved inside the shell.
 *
 * File names resolve from `Content-Disposition` (extended filename* first,
 * then plain filename), then the URL path's last segment, then a UTC
 * timestamp fallback, and are sanitized (no separators, control characters,
 * leading/trailing dots, or absurd length) before use.
 *
 * Nothing here logs. Callers must not log the inputs either: download URLs
 * and cookies are credential-adjacent.
 *
 * This class must not reference Android framework classes so it can be unit
 * tested on the JVM.
 */
object DownloadPolicy {

    /** Toast copy when the DownloadManager itself refuses a request. */
    const val DOWNLOAD_START_FAILED: String = "下载未能开始，请重试。"

    enum class Action { DOWNLOAD_VIA_MANAGER, HAND_OFF_BROWSER, UNSUPPORTED }

    data class Decision(
        val action: Action,
        val fileName: String,
        val mimeType: String?,
        val attachCookies: Boolean,
    )

    /**
     * Decides how a download request is handled. [pageOrigin] is the origin
     * currently loaded in the WebView (`scheme://host[:port]`), [hasCookies]
     * reports whether the WebView jar holds a cookie for [url], and
     * [nowMillis] backs the timestamp fallback name.
     */
    fun decide(
        url: String?,
        contentDisposition: String?,
        mimeType: String?,
        pageOrigin: String?,
        hasCookies: Boolean,
        nowMillis: Long,
    ): Decision {
        val unsupported = Decision(Action.UNSUPPORTED, "", null, attachCookies = false)
        if (url.isNullOrBlank()) return unsupported
        val uri = try {
            URI(url)
        } catch (e: Exception) {
            return unsupported
        }
        if (uri.scheme?.lowercase(Locale.US) != "https") return unsupported
        // Embedded user-info is a credential shape: never fetch such a URL.
        if (uri.rawUserInfo != null) return unsupported
        if (uri.host.isNullOrEmpty()) return unsupported
        // A credential-bearing URL must never leave the app, DownloadManager
        // requests included (EntryLinkPolicy semantics, fail-closed).
        if (EntryLinkPolicy.hasCredentialInQuery(url)) return unsupported
        return Decision(
            action = Action.DOWNLOAD_VIA_MANAGER,
            fileName = resolveFileName(contentDisposition, url, nowMillis),
            mimeType = sanitizeMimeType(mimeType),
            // Cookies ride only to the app's own origin, and only when the
            // WebView jar actually holds a session for this URL.
            attachCookies = EntryLinkPolicy.isSameOrigin(url, pageOrigin) && hasCookies,
        )
    }

    // --- file-name resolution -------------------------------------------------

    /** Maximum file-name length handed to the DownloadManager. */
    private const val MAX_FILE_NAME_LENGTH: Int = 100

    /**
     * Resolves the download file name: `Content-Disposition` wins (extended
     * filename* over plain filename), then the URL path's last segment, then
     * a UTC timestamp fallback. Never returns an empty name.
     */
    fun resolveFileName(contentDisposition: String?, url: String?, nowMillis: Long): String {
        if (!contentDisposition.isNullOrBlank()) {
            val fromDisposition = sanitizeFileName(fileNameFromDisposition(contentDisposition))
            if (!fromDisposition.isNullOrEmpty()) return fromDisposition
        }
        if (!url.isNullOrBlank()) {
            val fromUrl = sanitizeFileName(fileNameFromUrlPath(url))
            if (!fromUrl.isNullOrEmpty()) return fromUrl
        }
        return fallbackFileName(nowMillis)
    }

    /** Extended filename* (RFC 5987) first, then plain filename. */
    private fun fileNameFromDisposition(disposition: String): String? {
        val extended = dispositionValue(disposition, "filename*")
        if (extended != null) {
            val parts = extended.split('\'')
            // RFC 5987 shape: charset'language'percent-encoded-value.
            if (parts.size == 3) {
                // UTF-8 and its byte-compatible ASCII/Latin-1 relatives are
                // decodable with the UTF-8 path (browsers do the same); an
                // unknown charset falls back to the plain filename.
                val charset = parts[0].lowercase(Locale.US)
                if (charset in acceptedExtendedCharsets) {
                    val encoded = parts[2]
                    if (encoded.isNotEmpty()) {
                        val decoded = percentDecode(encoded)
                        // A replacement glyph means the bytes were not valid
                        // UTF-8 (e.g. real Latin-1 text): prefer the fallback.
                        if (decoded != null && !decoded.contains('\uFFFD')) return decoded
                    }
                }
            }
        }
        return dispositionValue(disposition, "filename")
    }

    private val acceptedExtendedCharsets =
        setOf("utf-8", "utf8", "us-ascii", "ascii", "iso-8859-1", "latin1")

    /** Last raw path segment of the URL, percent-decoded when possible. */
    private fun fileNameFromUrlPath(url: String): String? {
        val uri = try {
            URI(url)
        } catch (e: Exception) {
            return null
        }
        val path = uri.rawPath ?: return null
        if (path.isEmpty() || path.endsWith("/")) return null
        val last = path.substringAfterLast('/')
        if (last.isEmpty()) return null
        return percentDecode(last) ?: last
    }

    /**
     * Percent-decodes as UTF-8. Returns null on malformed escapes or embedded
     * non-ASCII characters so the caller can fall back to the raw value.
     */
    private fun percentDecode(value: String): String? {
        if (!value.contains('%')) return value
        val bytes = ByteArrayOutputStream()
        var i = 0
        while (i < value.length) {
            val c = value[i]
            when {
                c == '%' -> {
                    if (i + 2 >= value.length) return null
                    val hex = value.substring(i + 1, i + 3)
                    val code = try {
                        hex.toInt(16)
                    } catch (e: NumberFormatException) {
                        return null
                    }
                    bytes.write(code)
                    i += 3
                }
                c.code <= 255 -> {
                    // ASCII plus raw high bytes (server quirk): the UTF-8
                    // decode below resolves valid sequences.
                    bytes.write(c.code)
                    i += 1
                }
                else -> return null
            }
        }
        return try {
            bytes.toString("UTF-8")
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Extracts the value of a Content-Disposition parameter. Handles both
     * quoted-string values (with backslash escapes) and bare token values
     * (read to the next `;`). Returns null when the parameter is absent or
     * has no value.
     */
    private fun dispositionValue(disposition: String, name: String): String? {
        val start = findParamStart(disposition, name) ?: return null
        var i = start + name.length
        while (i < disposition.length && disposition[i].isWhitespace()) i += 1
        if (i >= disposition.length || disposition[i] != '=') return null
        i += 1
        while (i < disposition.length && disposition[i].isWhitespace()) i += 1
        if (i >= disposition.length) return null
        if (disposition[i] == '"') {
            val value = StringBuilder()
            i += 1
            while (i < disposition.length) {
                val c = disposition[i]
                when {
                    // Quoted-pair: a backslash escapes only a quote or another
                    // backslash (RFC 2183). Any other backslash is literal —
                    // Windows-path names arrive with raw separators, not
                    // escapes.
                    c == '\\' && i + 1 < disposition.length &&
                        (disposition[i + 1] == '"' || disposition[i + 1] == '\\') -> {
                        value.append(disposition[i + 1])
                        i += 2
                    }
                    c == '"' -> return value.toString()
                    else -> {
                        value.append(c)
                        i += 1
                    }
                }
            }
            return value.toString() // unterminated quote: use what we have
        }
        var end = i
        while (end < disposition.length && disposition[end] != ';') end += 1
        return disposition.substring(i, end).trim()
    }

    /**
     * Finds the start index of a parameter name in a Content-Disposition
     * header: bounded by start-of-string, `;` or whitespace, and followed
     * (after optional spaces) by `=`. The plain `filename` search skips the
     * extended `filename*` parameter.
     */
    private fun findParamStart(disposition: String, name: String): Int? {
        var i = 0
        while (i <= disposition.length - name.length) {
            if (disposition.regionMatches(i, name, 0, name.length, ignoreCase = true)) {
                val atBoundary = i == 0 ||
                    disposition[i - 1] == ';' ||
                    disposition[i - 1].isWhitespace()
                if (atBoundary) {
                    val after = i + name.length
                    val isExtendedShadow = name == "filename" &&
                        after < disposition.length &&
                        disposition[after] == '*'
                    if (!isExtendedShadow) {
                        var j = after
                        while (j < disposition.length && disposition[j].isWhitespace()) j += 1
                        if (j < disposition.length && disposition[j] == '=') return i
                    }
                }
            }
            i += 1
        }
        return null
    }

    /**
     * Reduces a raw file name to a single safe path segment: separators
     * become underscores, control characters are dropped, wrapping quotes are
     * removed, leading/trailing dots and spaces are trimmed (no traversal or
     * hidden-file shape), and the result is length-capped keeping any short
     * extension. Returns null when nothing usable remains.
     */
    private fun sanitizeFileName(raw: String?): String? {
        if (raw == null) return null
        var name = raw.trim()
        if (name.length >= 2 && name.first() == '"' && name.last() == '"') {
            name = name.substring(1, name.length - 1)
        }
        name = name.replace('/', '_').replace('\\', '_')
        name = name.filter { !it.isISOControl() }
        name = name.trim().trimStart('.').trimEnd('.', ' ')
        if (name.isEmpty()) return null
        return limitLength(name)
    }

    /** Caps the name at [MAX_FILE_NAME_LENGTH], keeping a short extension. */
    private fun limitLength(name: String): String {
        if (name.length <= MAX_FILE_NAME_LENGTH) return name
        val dot = name.lastIndexOf('.')
        val extensionLength = name.length - dot
        return if (dot > 0 && extensionLength <= 10) {
            name.take(MAX_FILE_NAME_LENGTH - extensionLength) + name.substring(dot)
        } else {
            name.take(MAX_FILE_NAME_LENGTH)
        }
    }

    /** UTC timestamp name; zone-fixed so the fallback shape is deterministic. */
    private fun fallbackFileName(nowMillis: Long): String {
        val format = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        return "download-" + format.format(Date(nowMillis))
    }

    // --- mime-type hint ---------------------------------------------------------

    private val mimeTypePattern =
        Regex("^[a-zA-Z0-9][a-zA-Z0-9!#$&^.+_-]*/[a-zA-Z0-9][a-zA-Z0-9!#$&^.+_-]*$")

    /**
     * Keeps a well-formed `type/subtype` hint (lowercased) for the
     * DownloadManager, or null when the hint is absent or malformed — the
     * manager then guesses from the file extension.
     */
    fun sanitizeMimeType(raw: String?): String? {
        val value = raw?.trim() ?: return null
        if (value.isEmpty() || value.length > 100) return null
        return if (mimeTypePattern.matches(value)) value.lowercase(Locale.US) else null
    }
}
