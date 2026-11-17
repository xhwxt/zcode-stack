package io.github.xhwxt.zcodemobile

import java.net.HttpURLConnection
import java.net.URL

/**
 * Blocking HTTP client for the per-device credential protocol.
 *
 * Deliberately free of Android imports: it talks plain `HttpURLConnection` and
 * `org.json`, so a unit test can point it at a local fake server and exercise
 * success, `403`, `401` and transport failure without a device. Callers must run
 * it off the main thread.
 */
class DeviceAuthClient(
    private val connectTimeoutMs: Int = 5_000,
    private val readTimeoutMs: Int = 8_000,
) {

    data class Response(val status: Int, val body: String)

    /** One-time pairing code → device credential + first short session. */
    fun redeem(origin: String, code: String, label: String): DeviceAuthPolicy.Pairing =
        toPairing(
            post(
                "$origin${DeviceAuthPolicy.REDEEM_PATH}",
                DeviceAuthPolicy.redeemBody(code, label),
            ),
            existingCredential = null,
        )

    /** Long-lived credential → fresh short session (credential lifetime unchanged). */
    fun renew(origin: String, credential: DeviceAuthPolicy.Credential): DeviceAuthPolicy.Pairing =
        toPairing(
            post(
                "$origin${DeviceAuthPolicy.RENEW_PATH}",
                DeviceAuthPolicy.renewBody(credential.deviceToken),
            ),
            existingCredential = credential,
        )

    /** Reachability / credential-validity check. */
    fun probe(
        origin: String,
        credential: DeviceAuthPolicy.Credential,
    ): Pair<String?, DeviceAuthPolicy.Failure> {
        val response = post(
            "$origin${DeviceAuthPolicy.PROBE_PATH}",
            DeviceAuthPolicy.probeBody(credential.deviceToken),
        ) ?: return null to DeviceAuthPolicy.Failure.NETWORK_ERROR
        val failure = DeviceAuthPolicy.failureForStatus(response.status)
        if (failure != DeviceAuthPolicy.Failure.NONE) return null to failure
        return DeviceAuthPolicy.parseProbe(response.body)
    }

    private fun toPairing(
        response: Response?,
        existingCredential: DeviceAuthPolicy.Credential?,
    ): DeviceAuthPolicy.Pairing {
        val fallbackCredential = existingCredential
            ?: DeviceAuthPolicy.Credential(deviceId = "", deviceToken = "", expiresAt = 0L)
        if (response == null) {
            return DeviceAuthPolicy.Pairing(
                credential = fallbackCredential,
                session = emptySession(),
                failure = DeviceAuthPolicy.Failure.NETWORK_ERROR,
            )
        }
        val failure = DeviceAuthPolicy.failureForStatus(response.status)
        if (failure != DeviceAuthPolicy.Failure.NONE) {
            return DeviceAuthPolicy.Pairing(
                credential = fallbackCredential,
                session = emptySession(),
                failure = failure,
            )
        }
        return DeviceAuthPolicy.parsePairing(response.body, existingCredential)
    }

    private fun emptySession() = DeviceAuthPolicy.Session(
        token = "",
        expiresAt = 0L,
        csrf = "",
        sessionCookieName = DeviceAuthPolicy.DEFAULT_SESSION_COOKIE,
        csrfCookieName = DeviceAuthPolicy.DEFAULT_CSRF_COOKIE,
    )

    /** Returns null when the request never completed (offline, timeout, TLS). */
    private fun post(url: String, json: String): Response? = try {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.connectTimeout = connectTimeoutMs
        connection.readTimeout = readTimeoutMs
        connection.doOutput = true
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.setRequestProperty("Content-Type", "application/json")
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("Cache-Control", "no-cache")
        connection.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
        connection.disconnect()
        Response(status, body)
    } catch (e: Exception) {
        null
    }
}
