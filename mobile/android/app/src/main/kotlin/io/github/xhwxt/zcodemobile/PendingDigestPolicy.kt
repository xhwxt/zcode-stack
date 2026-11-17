package io.github.xhwxt.zcodemobile

/**
 * Pure-JVM reader for the probe response's optional `pendingDigest` field — a
 * single-line, already-redacted summary of the first pending interaction
 * (`{ "kind": "permission" | "userInput", "text": "…" }`).
 *
 * Contract (frozen server side): the field only appears while at least one
 * interaction is pending, and `text` is a single line of at most 120
 * characters. This object only *reads* it: [textFrom] returns the digest text
 * or null, and null always means "behave exactly as before" — the caller falls
 * back to the count-only notification, which is precisely the pre-digest
 * (older server) behavior. Absence, malformed JSON, a non-object value, a
 * missing/blank text all collapse to the same null, so no failure mode here
 * can fabricate or suppress a notification.
 *
 * `kind` is deliberately not consumed: the shell has no per-kind behavior, and
 * the text is the whole payload it needs. Reading a value it does not act on
 * would only add untested surface.
 */
object PendingDigestPolicy {

    /** Probe-response field carrying the digest object. */
    const val FIELD: String = "pendingDigest"

    /**
     * The digest text from a raw probe [body], or null when there is nothing
     * usable. Blank input, unparsable JSON, an absent field, a non-object
     * value, or an empty/whitespace `text` all yield null (old-behavior
     * fallback). The returned text is trimmed.
     */
    fun textFrom(body: String?): String? {
        if (body.isNullOrBlank()) return null
        val root = try {
            org.json.JSONObject(body)
        } catch (e: Exception) {
            return null
        }
        val digest = root.optJSONObject(FIELD) ?: return null
        val text = digest.optString("text", "").trim()
        return text.ifEmpty { null }
    }
}
