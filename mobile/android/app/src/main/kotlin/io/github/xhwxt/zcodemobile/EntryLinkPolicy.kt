package io.github.xhwxt.zcodemobile

/**
 * Pure-JVM policy for validating a pasted ZCode entry link.
 *
 * Accepted forms (HTTPS only):
 *  - `https://<host>[:<port>]/?token=<non-empty>` (path `/`, legacy URL token)
 *  - `https://<host>[:<port>]/web-remote?remoteControlToken=<non-empty>` (path `/web-remote`)
 *  - `https://<host>[:<port>]/` and `/api/pairing/page` with **no query at all**:
 *    the server's pairing login (one-time code → 90-day cookie) authenticates
 *    inside the page, so there is no credential to carry in the URL. The
 *    server's URL-token direct-connect switch can be off, which makes the bare
 *    origin the only entry that works.
 *
 * No other path, scheme, extra query parameter, duplicated credential parameter,
 * user-info component, or out-of-range port is accepted. Error messages are static:
 * they never echo the supplied input or any credential.
 *
 * This class must not reference Android framework classes so it can be unit
 * tested on the JVM.
 */
object EntryLinkPolicy {

    /** The credential query-parameter name required for each accepted path. */
    const val TOKEN_PARAM: String = "token"
    const val REMOTE_CONTROL_TOKEN_PARAM: String = "remoteControlToken"

    /** Path of the primary entry page. */
    const val ROOT_PATH: String = "/"
    /** Path of the web-remote entry page. */
    const val WEB_REMOTE_PATH: String = "/web-remote"
    /** Path of the server's pairing/login page (redirect target when unauthenticated). */
    const val PAIRING_PATH: String = "/api/pairing/page"

    // Static, input-free error strings. Never append user input to these.
    const val ERROR_LINK_REQUIRED: String = "链接不能为空，请粘贴完整的 ZCode 连接链接。"
    const val ERROR_LINK_INVALID: String = "链接格式不正确，请检查后重新粘贴。"
    const val ERROR_NOT_HTTPS: String = "只支持 HTTPS 链接，请使用以 https:// 开头的连接链接。"
    const val ERROR_UNSUPPORTED_PAGE: String = "该链接指向的页面类型不受支持，请使用应用下发的 ZCode 连接链接。"
    const val ERROR_CREDENTIAL_MISSING: String = "链接缺少有效的连接凭据，请使用应用下发的完整 ZCode 连接链接。"
    const val ERROR_EXTRA_PARAMETERS: String = "链接包含多余的参数，请使用应用下发的完整 ZCode 连接链接。"

    private val acceptedCredentialParam: Map<String, String> = mapOf(
        ROOT_PATH to TOKEN_PARAM,
        WEB_REMOTE_PATH to REMOTE_CONTROL_TOKEN_PARAM,
    )

    /**
     * Paths that are valid entries with no query string: the pairing flow signs
     * in inside the page instead of through a URL credential.
     */
    private val credentiallessPaths: Set<String> = setOf(ROOT_PATH, PAIRING_PATH)

    /**
     * Result of validating an entry link. On success, [url] is the original
     * string exactly as supplied (query and fragment preserved, no rewriting).
     */
    data class Result(
        val valid: Boolean,
        val url: String? = null,
        val scheme: String? = null,
        val host: String? = null,
        val port: Int? = null,
        val path: String? = null,
        val error: String? = null,
    ) {
        val isError: Boolean get() = !valid
    }

    /**
     * Normalizes the path for matching: percent-decoded path segments are NOT
     * accepted; the path must be literally `/` or `/web-remote` (case-sensitive,
     * no trailing slash beyond the documented forms).
     */
    fun validate(input: String?): Result {
        if (input.isNullOrBlank()) {
            return Result(valid = false, error = ERROR_LINK_REQUIRED)
        }

        val uri = try {
            java.net.URI(input)
        } catch (e: Exception) {
            return Result(valid = false, error = ERROR_LINK_INVALID)
        }

        val scheme = uri.scheme?.lowercase()
        if (scheme.isNullOrEmpty()) {
            return Result(valid = false, error = ERROR_LINK_INVALID)
        }
        if (scheme != "https") {
            return Result(valid = false, error = ERROR_NOT_HTTPS)
        }

        // Reject user-info outright: credentials must only ride in the query.
        if (!uri.rawUserInfo.isNullOrEmpty()) {
            return Result(valid = false, error = ERROR_LINK_INVALID)
        }

        val host = uri.host
        if (host.isNullOrEmpty() || !isHostAcceptable(host)) {
            return Result(valid = false, error = ERROR_LINK_INVALID)
        }

        val rawPort = uri.port // -1 means absent; URI throws for unparsable ports
        if (rawPort != -1 && (rawPort < 1 || rawPort > 65535)) {
            return Result(valid = false, error = ERROR_LINK_INVALID)
        }

        val rawPath = uri.rawPath
        val path = when {
            rawPath == null || rawPath.isEmpty() -> ROOT_PATH
            rawPath == ROOT_PATH || rawPath == WEB_REMOTE_PATH || rawPath == PAIRING_PATH -> rawPath
            else -> return Result(valid = false, error = ERROR_UNSUPPORTED_PAGE)
        }

        // Duplicate or empty raw query parameter names are rejected outright.
        val rawQuery = uri.rawQuery
        if (rawQuery != null && hasDuplicateOrEmptyParamName(rawQuery)) {
            return Result(valid = false, error = ERROR_EXTRA_PARAMETERS)
        }

        val params = parseQuery(uri.rawQuery)
        if (params == null) {
            return Result(valid = false, error = ERROR_LINK_INVALID)
        }

        // Pairing/login entry: no query at all means "open the page and sign in
        // with a pairing code there".
        if (params.isEmpty() && path in credentiallessPaths) {
            return Result(
                valid = true,
                url = input,
                scheme = scheme,
                host = host,
                port = if (rawPort == -1) null else rawPort,
                path = path,
                error = null,
            )
        }

        val credentialParam = acceptedCredentialParam[path]
            ?: return Result(valid = false, error = ERROR_UNSUPPORTED_PAGE)

        val credentialValues = params.filterKeys { it == credentialParam }
        val credentialValue = credentialValues[credentialParam]

        if (credentialValue.isNullOrEmpty()) {
            return Result(valid = false, error = ERROR_CREDENTIAL_MISSING)
        }

        val otherKeys = params.keys.filter { it != credentialParam }
        if (otherKeys.isNotEmpty()) {
            return Result(valid = false, error = ERROR_EXTRA_PARAMETERS)
        }

        return Result(
            valid = true,
            url = input,
            scheme = scheme,
            host = host,
            port = if (rawPort == -1) null else rawPort,
            path = path,
            error = null,
        )
    }

    /**
     * Decides whether the two origin strings may share WebView navigation.
     * Origins must match on scheme, host (case-insensitive) and effective port
     * (default ports normalized per scheme).
     */
    fun isSameOrigin(originA: String?, originB: String?): Boolean {
        if (originA.isNullOrBlank() || originB.isNullOrBlank()) return false
        val a = parseOrigin(originA) ?: return false
        val b = parseOrigin(originB) ?: return false
        return a == b
    }

    /**
     * True when the target URL carries a credential-bearing query parameter
     * (`token` or `remoteControlToken`). Such URLs must never leave the app.
     */
    fun hasCredentialInQuery(targetUrl: String?): Boolean {
        if (targetUrl.isNullOrBlank()) return false
        val uri = try {
            java.net.URI(targetUrl)
        } catch (e: Exception) {
            return true // cannot prove safety: treat as credential-bearing
        }
        val params = parseQuery(uri.rawQuery) ?: return true
        return params.containsKey(TOKEN_PARAM) || params.containsKey(REMOTE_CONTROL_TOKEN_PARAM)
    }

    /** Human-facing message used when a download is requested. */
    const val DOWNLOAD_UNSUPPORTED: String = "不支持下载。"

    private data class OriginParts(
        val scheme: String,
        val host: String,
        val port: Int,
    )

    private fun parseOrigin(origin: String): OriginParts? {
        val uri = try {
            java.net.URI(origin)
        } catch (e: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        if (!isHostAcceptable(host)) return null
        val port = when {
            uri.port != -1 -> uri.port
            scheme == "https" -> 443
            scheme == "http" -> 80
            else -> return null
        }
        if (port < 1 || port > 65535) return null
        return OriginParts(scheme, host, port)
    }

    /**
     * Host is acceptable when it is a plausible DNS name or IPv4/IPv6 literal,
     * with no control characters, whitespace, embedded separators, or trailing
     * dot abuse beyond a single final root dot.
     */
    private fun isHostAcceptable(host: String): Boolean {
        if (host.isEmpty() || host.length > 253) return false
        if (host.any { it.isWhitespace() || it.isISOControl() }) return false
        if (host.contains('/') || host.contains('\\') || host.contains('@')) return false
        if (host.contains(' ')) return false

        // Strip exactly one trailing root dot ("example.com." == "example.com").
        val trimmed = if (host.endsWith(".")) host.dropLast(1) else host
        if (trimmed.isEmpty()) return false

        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            // IPv6 literal: content between brackets must not be empty.
            val inner = trimmed.substring(1, trimmed.length - 1)
            return inner.isNotEmpty() && inner.none { it.isWhitespace() }
        }

        if (trimmed.any { it == ':' }) return false // bare IPv6 without brackets: reject

        // Each label: 1..63 chars of letter/digit/hyphen, not starting/ending with hyphen.
        val labels = trimmed.split('.')
        if (labels.any { it.isEmpty() || it.length > 63 }) return false
        return labels.all { label ->
            label.all { it.isLetterOrDigit() || it == '-' } &&
                !label.startsWith("-") && !label.endsWith("-")
        }
    }

    /**
     * Parses a raw query string into parameter-name → value map. Returns null
     * when the query is unparsable. The last occurrence of a duplicated name
     * wins for value lookup, but duplicates are separately rejected by
     * [validate] before this matters.
     */
    private fun parseQuery(rawQuery: String?): Map<String, String>? {
        if (rawQuery.isNullOrEmpty()) return emptyMap()
        return try {
            rawQuery.split('&')
                .filter { it.isNotEmpty() }
                .associate { pair ->
                    val idx = pair.indexOf('=')
                    if (idx >= 0) {
                        val name = java.net.URLDecoder.decode(pair.substring(0, idx), "UTF-8")
                        val value = java.net.URLDecoder.decode(pair.substring(idx + 1), "UTF-8")
                        name to value
                    } else {
                        java.net.URLDecoder.decode(pair, "UTF-8") to ""
                    }
                }
        } catch (e: Exception) {
            null
        }
    }

    /** True when a raw query contains a duplicated parameter name or an empty name. */
    private fun hasDuplicateOrEmptyParamName(rawQuery: String): Boolean {
        val names = rawQuery.split('&')
            .filter { it.isNotEmpty() }
            .map { pair ->
                val idx = pair.indexOf('=')
                val rawName = if (idx >= 0) pair.substring(0, idx) else pair
                if (rawName.isEmpty()) return true
                try {
                    java.net.URLDecoder.decode(rawName, "UTF-8")
                } catch (e: Exception) {
                    return true
                }
            }
        return names.size != names.toSet().size
    }
}
