package io.github.xhwxt.zcodemobile

/**
 * Sanitises the text a page sends for a task notification.
 *
 * The page is the source of this text (it comes from task titles/summaries and
 * is not trusted to be single-line or short), so limits mirror dsh-mobile's
 * bridge: collapse line breaks, drop control characters, trim, and cap length.
 * Pure JVM so it can be unit tested without an emulator.
 */
object NotificationTextPolicy {

    /** Same caps as dsh-mobile's NativeBridgePolicy. */
    const val TITLE_MAX_CHARS: Int = 80
    const val BODY_MAX_CHARS: Int = 200

    /** Line separators: CR/LF plus the two Unicode line/paragraph separators. */
    private val LINE_BREAKS = Regex("[\\r\\n\\u2028\\u2029]+")

    fun sanitize(value: String?, maxChars: Int): String {
        if (value == null) return ""
        val singleLine = value.replace(LINE_BREAKS, " ")
        val printable = singleLine.filter { !it.isISOControl() }
        return takeCodePoints(printable.trim(), maxChars)
    }

    /**
     * Caps by Unicode code point. `String.take` counts UTF-16 units and would cut
     * a surrogate pair in half, leaving a lone surrogate that renders as a
     * replacement glyph in the notification.
     */
    private fun takeCodePoints(value: String, maxCodePoints: Int): String {
        if (value.isEmpty()) return value
        if (value.codePointCount(0, value.length) <= maxCodePoints) return value
        return value.substring(0, value.offsetByCodePoints(0, maxCodePoints))
    }

    fun title(value: String?): String = sanitize(value, TITLE_MAX_CHARS)

    fun body(value: String?): String = sanitize(value, BODY_MAX_CHARS)

    /** Service-side English body for a tool waiting on the user. */
    const val INTERACTION_PATTERN: String = "requires user interaction"

    /**
     * Shell-side safety net for the one English body the server's permission
     * service still emits when a tool waits on the user (`… requires user
     * interaction`). The page now prefers the real question text, so normal
     * notifications arrive in Chinese; this single-pattern mapping catches the
     * path where only the service reason is available. Anything else passes
     * through unchanged — no other English guessing.
     */
    fun localizeBody(value: String?, replacement: String): String {
        val raw = value ?: return ""
        return if (raw.contains(INTERACTION_PATTERN)) replacement else raw
    }

    /** Nothing worth showing: an empty notification must never be posted. */
    fun isEmpty(title: String, body: String): Boolean = title.isEmpty() && body.isEmpty()
}
