package io.github.xhwxt.zcodemobile

/**
 * Shared in-process cache of the credential token + origin the *page* flow is
 * actively using (written by [MainActivity] when a connect or a session renew
 * succeeds). The keep-alive service probes with this instead of independently
 * re-reading DeviceStore → Keystore on every tick.
 *
 * Why: the page's chat flow runs on credentials decrypted once at startup and
 * held in memory, so it keeps working when the system invalidates the
 * Keystore key under us (screen-lock change, key rotation, …). The service's
 * old per-tick decrypt chain had a single transient Keystore failure flip the
 * status row to "未配对或凭据失效" while chat was visibly working. The cache
 * removes that divergence: the probe uses exactly what the page uses.
 *
 * Security: the token lives only in process memory (never in prefs, never in
 * logs — see [resolveProbeTarget] logging rules in the service). Process death
 * clears it by construction; the first successful connect repopulates it.
 */
object ProbeTargetCache {

    data class Target(val deviceToken: String, val origin: String)

    @Volatile
    private var cached: Target? = null

    /** The last target the page flow verified, or null before the first connect. */
    fun get(): Target? = cached

    /**
     * Overwrites the cache with a freshly verified (token, origin) pair. Called
     * on connectToDevice (credential in hand) and on every successful renew /
     * pairing, so a re-paired or re-keyed device replaces a stale entry.
     */
    fun put(deviceToken: String, origin: String) {
        if (deviceToken.isEmpty() || origin.isEmpty()) return
        cached = Target(deviceToken, origin)
    }

    /** Drops the entry (device revoked / credential dropped). */
    fun clear() {
        cached = null
    }

    /**
     * Pure decision for the service's target resolution: the page-verified
     * cache wins; the fallback chain only runs when the cache is empty (cold
     * FGS start before the page has connected). Returns the cached target
     * verbatim — callers that fall back must supply their own resolution.
     */
    fun resolve(cached: Target?): Target? = cached
}
