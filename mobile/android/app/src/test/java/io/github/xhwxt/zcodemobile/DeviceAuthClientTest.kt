package io.github.xhwxt.zcodemobile

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections

/**
 * Exercises the device-credential client against a real local HTTP endpoint, so
 * the protocol (paths, bodies, status handling, parsing) is verified on the JVM
 * independently of the server implementation.
 *
 * The fake server is a bare [ServerSocket]: Android unit tests compile against
 * the Android boot classpath, where `com.sun.net.httpserver` is not available.
 */
class DeviceAuthClientTest {

    private var fake: FakeHttpServer? = null

    private fun start(routes: Map<String, Pair<Int, String>>): String {
        val server = FakeHttpServer(routes)
        fake = server
        return "http://127.0.0.1:${server.port}"
    }

    @After
    fun stop() {
        fake?.close()
    }

    private val successBody = """
        {"ok":true,"deviceId":"dev-1","deviceToken":"dt-secret",
         "deviceExpiresAt":"2026-12-31T00:00:00Z","sessionToken":"st-1",
         "sessionExpiresAt":1893456000000,"csrfToken":"csrf-1"}
    """.trimIndent()

    @Test
    fun `redeem posts code and label and parses credential plus session`() {
        val origin = start(mapOf(DeviceAuthPolicy.REDEEM_PATH to (200 to successBody)))
        val pairing = DeviceAuthClient().redeem(origin, "CODE-1", "  我的手机  ")

        assertTrue(pairing.failure.toString(), pairing.ok)
        assertEquals("dev-1", pairing.credential.deviceId)
        assertEquals("dt-secret", pairing.credential.deviceToken)
        assertEquals("st-1", pairing.session.token)
        assertEquals("csrf-1", pairing.session.csrf)
        assertEquals(DeviceAuthPolicy.DEFAULT_SESSION_COOKIE, pairing.session.sessionCookieName)
        // ISO-8601 expiry is accepted alongside epoch millis.
        assertEquals(
            java.time.Instant.parse("2026-12-31T00:00:00Z").toEpochMilli(),
            pairing.credential.expiresAt,
        )
        // Label is trimmed before it leaves the device; UTF-8 survives the wire.
        val request = fake!!.requests.single()
        assertEquals(DeviceAuthPolicy.REDEEM_PATH, request.path)
        assertTrue(request.body, request.body.contains("\"label\":\"我的手机\""))
        assertTrue(request.body, request.body.contains("\"code\":\"CODE-1\""))
        assertEquals("POST", request.method)
    }

    @Test
    fun `redeem with a bad code is INVALID_CODE`() {
        val origin = start(mapOf(DeviceAuthPolicy.REDEEM_PATH to (403 to "{\"error\":\"配对码无效或已过期\"}")))
        val pairing = DeviceAuthClient().redeem(origin, "WRONG", "phone")
        assertEquals(DeviceAuthPolicy.Failure.INVALID_CODE, pairing.failure)
        assertFalse(pairing.ok)
    }

    @Test
    fun `renew keeps the stored credential and takes the new session`() {
        val origin = start(mapOf(DeviceAuthPolicy.RENEW_PATH to (200 to successBody)))
        val stored = DeviceAuthPolicy.Credential("dev-1", "dt-secret", 123L)
        val pairing = DeviceAuthClient().renew(origin, stored)

        assertTrue(pairing.failure.toString(), pairing.ok)
        assertEquals(stored, pairing.credential)
        assertEquals("st-1", pairing.session.token)
        val request = fake!!.requests.single()
        assertEquals(DeviceAuthPolicy.RENEW_PATH, request.path)
        assertTrue(request.body, request.body.contains("\"deviceToken\":\"dt-secret\""))
    }

    @Test
    fun `renew on a revoked device is UNAUTHORIZED`() {
        val origin = start(mapOf(DeviceAuthPolicy.RENEW_PATH to (401 to "{\"error\":\"authentication_failed\"}")))
        val pairing = DeviceAuthClient().renew(origin, DeviceAuthPolicy.Credential("dev-1", "gone", 1L))
        assertEquals(DeviceAuthPolicy.Failure.UNAUTHORIZED, pairing.failure)
    }

    @Test
    fun `malformed 200 body is BAD_RESPONSE not a crash`() {
        val origin = start(mapOf(DeviceAuthPolicy.REDEEM_PATH to (200 to "not json at all")))
        val pairing = DeviceAuthClient().redeem(origin, "CODE", "phone")
        assertEquals(DeviceAuthPolicy.Failure.BAD_RESPONSE, pairing.failure)
    }

    @Test
    fun `missing session token in a 200 body is BAD_RESPONSE`() {
        val origin = start(
            mapOf(DeviceAuthPolicy.REDEEM_PATH to (200 to "{\"deviceId\":\"d\",\"deviceToken\":\"t\"}")),
        )
        val pairing = DeviceAuthClient().redeem(origin, "CODE", "phone")
        assertEquals(DeviceAuthPolicy.Failure.BAD_RESPONSE, pairing.failure)
    }

    @Test
    fun `server error status is SERVER_ERROR`() {
        val origin = start(mapOf(DeviceAuthPolicy.REDEEM_PATH to (500 to "{}")))
        val pairing = DeviceAuthClient().redeem(origin, "CODE", "phone")
        assertEquals(DeviceAuthPolicy.Failure.SERVER_ERROR, pairing.failure)
    }

    @Test
    fun `unreachable origin is NETWORK_ERROR`() {
        // Port 1 is never listening: the request cannot complete.
        val pairing = DeviceAuthClient(connectTimeoutMs = 400, readTimeoutMs = 400)
            .redeem("http://127.0.0.1:1", "CODE", "phone")
        assertEquals(DeviceAuthPolicy.Failure.NETWORK_ERROR, pairing.failure)
    }

    @Test
    fun `probe returns instance id for an accepted credential`() {
        val origin = start(
            mapOf(DeviceAuthPolicy.PROBE_PATH to (200 to "{\"reachable\":true,\"instanceId\":\"inst-9\"}")),
        )
        val (instanceId, failure) = DeviceAuthClient()
            .probe(origin, DeviceAuthPolicy.Credential("dev-1", "dt", 1L))
        assertEquals(DeviceAuthPolicy.Failure.NONE, failure)
        assertEquals("inst-9", instanceId)
        val request = fake!!.requests.single()
        assertEquals(DeviceAuthPolicy.PROBE_PATH, request.path)
        assertTrue(request.body, request.body.contains("\"deviceToken\":\"dt\""))
    }

    @Test
    fun `probe on a revoked credential is UNAUTHORIZED`() {
        val origin = start(mapOf(DeviceAuthPolicy.PROBE_PATH to (401 to "{}")))
        val (instanceId, failure) = DeviceAuthClient()
            .probe(origin, DeviceAuthPolicy.Credential("dev-1", "gone", 1L))
        assertNull(instanceId)
        assertEquals(DeviceAuthPolicy.Failure.UNAUTHORIZED, failure)
    }

    /** Minimal HTTP/1.1 responder: one request per connection, `Connection: close`. */
    private class FakeHttpServer(routes: Map<String, Pair<Int, String>>) : AutoCloseable {

        data class Request(val method: String, val path: String, val body: String)

        private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        private val routes: Map<String, Pair<Int, String>> = routes.toMap()
        val requests: MutableList<Request> = Collections.synchronizedList(mutableListOf<Request>())

        val port: Int get() = server.localPort

        private val thread = Thread {
            while (!server.isClosed) {
                try {
                    server.accept().use { handle(it) }
                } catch (e: Exception) {
                    if (server.isClosed) return@Thread
                }
            }
        }.apply {
            isDaemon = true
            start()
        }

        private fun handle(socket: Socket) {
            val input: InputStream = socket.getInputStream()
            val collected = ByteArrayOutputStream()
            val chunk = ByteArray(4096)
            var headerEnd = -1
            while (headerEnd < 0) {
                val read = input.read(chunk)
                if (read < 0) break
                collected.write(chunk, 0, read)
                headerEnd = indexOfHeaderEnd(collected.toByteArray())
            }
            if (headerEnd < 0) return
            val header = String(collected.toByteArray(), 0, headerEnd, Charsets.ISO_8859_1)
            val contentLength = Regex("(?i)content-length:\\s*(\\d+)")
                .find(header)?.groupValues?.get(1)?.toInt() ?: 0
            val bodyStart = headerEnd + 4
            while (collected.size() - bodyStart < contentLength) {
                val read = input.read(chunk)
                if (read < 0) break
                collected.write(chunk, 0, read)
            }
            val all = collected.toByteArray()
            val bodyEnd = minOf(bodyStart + contentLength, all.size)
            val body = String(all.copyOfRange(bodyStart, bodyEnd), Charsets.UTF_8)

            val requestLine = header.lineSequence().firstOrNull().orEmpty().split(' ')
            val method = requestLine.getOrElse(0) { "" }
            val path = requestLine.getOrElse(1) { "/" }.substringBefore('?')
            requests.add(Request(method, path, body))

            val (status, payload) = routes[path] ?: (404 to "{\"error\":\"not_found\"}")
            val bytes = payload.toByteArray(Charsets.UTF_8)
            val head = "HTTP/1.1 $status OK\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: ${bytes.size}\r\n" +
                "Connection: close\r\n\r\n"
            socket.getOutputStream().apply {
                write(head.toByteArray(Charsets.ISO_8859_1))
                write(bytes)
                flush()
            }
        }

        private fun indexOfHeaderEnd(bytes: ByteArray): Int {
            for (i in 0..bytes.size - 4) {
                if (bytes[i] == '\r'.code.toByte() && bytes[i + 1] == '\n'.code.toByte() &&
                    bytes[i + 2] == '\r'.code.toByte() && bytes[i + 3] == '\n'.code.toByte()
                ) {
                    return i
                }
            }
            return -1
        }

        override fun close() {
            server.close()
        }
    }
}
