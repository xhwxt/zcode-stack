package io.github.xhwxt.zcodemobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Multi-device connection store. Each device is a named ZCode entry link,
 * encrypted at rest with one Android Keystore AES-GCM key (per-device random
 * IV). The plaintext file `devices.json` holds only non-secret metadata
 * (name, origin, page kind, last-used timestamp); the secret link of every
 * device lives in the single encrypted `connections.enc` payload.
 *
 * Failure policy: Keystore or crypto failure throws [StoreException]; the
 * shell never falls back to plaintext.
 */
class DeviceStore(private val context: Context) {

    class StoreException(message: String, cause: Throwable? = null) : Exception(message, cause)

    data class DeviceMeta(
        val id: String,
        val name: String,
        val origin: String,
        val kind: String,
        val lastUsedAt: Long,
    )

    private val metaFile: File get() = File(context.filesDir, META_FILE)
    private val secretFile: File get() = File(context.filesDir, SECRET_FILE)

    /** Returns all devices (metadata only), newest-used first. */
    @Synchronized
    fun list(): List<DeviceMeta> {
        if (!metaFile.exists()) return emptyList()
        return try {
            val arr = JSONArray(metaFile.readText())
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                DeviceMeta(
                    id = o.getString("id"),
                    name = o.getString("name"),
                    origin = o.getString("origin"),
                    kind = o.getString("kind"),
                    lastUsedAt = o.getLong("lastUsedAt"),
                )
            }
        } catch (e: Exception) {
            throw StoreException("Device metadata unreadable", e)
        }
    }

    /** Decrypts and returns the entry link of [id]. */
    @Synchronized
    fun linkOf(id: String): String? {
        val secrets = readSecrets()
        return secrets.optString(id).takeIf { it.isNotBlank() }
    }

    /** Adds or replaces a device; returns its stable id. */
    @Synchronized
    fun save(name: String, link: String, origin: String, kind: String, existingId: String? = null): String {
        val metas = try {
            list().toMutableList()
        } catch (e: StoreException) {
            throw e
        }
        val id = existingId ?: "dev-" + System.currentTimeMillis().toString(36) + "-" +
            (0 until 4).map { "0123456789abcdef"[(0..15).random()] }.joinToString("")
        metas.removeAll { it.id == id }
        metas.add(DeviceMeta(id, name, origin, kind, System.currentTimeMillis()))
        writeMeta(metas)

        val secrets = readSecrets()
        secrets.put(id, link)
        writeSecrets(secrets)
        return id
    }

    /** Marks a device as most recently used. */
    @Synchronized
    fun touch(id: String) {
        val metas = list().toMutableList()
        val i = metas.indexOfFirst { it.id == id }
        if (i >= 0) {
            metas[i] = metas[i].copy(lastUsedAt = System.currentTimeMillis())
            writeMeta(metas)
        }
    }

    /** Deletes one device entirely. */
    @Synchronized
    fun delete(id: String) {
        val metas = list().toMutableList()
        metas.removeAll { it.id == id }
        writeMeta(metas)
        val secrets = readSecrets()
        secrets.remove(id)
        writeSecrets(secrets)
    }

    /** Deletes everything (清除本机连接数据). */
    @Synchronized
    fun clearAll() {
        if (metaFile.exists() && !metaFile.delete()) {
            throw StoreException("Could not delete device metadata")
        }
        if (secretFile.exists() && !secretFile.delete()) {
            throw StoreException("Could not delete device secrets")
        }
    }

    // --- secret payload ------------------------------------------------------

    private fun readSecrets(): JSONObject {
        if (!secretFile.exists()) return JSONObject()
        val bytes = secretFile.readBytes()
        if (bytes.size <= GCM_IV_LENGTH) {
            throw StoreException("Secret payload truncated")
        }
        return try {
            val iv = bytes.copyOfRange(0, GCM_IV_LENGTH)
            val ct = bytes.copyOfRange(GCM_IV_LENGTH, bytes.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(GCM_TAG_BITS, iv))
            JSONObject(String(cipher.doFinal(ct), Charsets.UTF_8))
        } catch (e: Exception) {
            throw StoreException("Device secrets unreadable", e)
        }
    }

    private fun writeSecrets(obj: JSONObject) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        require(iv.size == GCM_IV_LENGTH) { "Unexpected GCM IV length" }
        val out = iv + cipher.doFinal(obj.toString().toByteArray(Charsets.UTF_8))
        val tmp = File(context.filesDir, SECRET_FILE + ".tmp")
        tmp.writeBytes(out)
        if (!tmp.renameTo(secretFile)) {
            tmp.delete()
            throw StoreException("Could not persist device secrets")
        }
    }

    private fun writeMeta(metas: List<DeviceMeta>) {
        val arr = JSONArray()
        metas.sortedByDescending { it.lastUsedAt }.forEach { m ->
            arr.put(
                JSONObject()
                    .put("id", m.id)
                    .put("name", m.name)
                    .put("origin", m.origin)
                    .put("kind", m.kind)
                    .put("lastUsedAt", m.lastUsedAt),
            )
        }
        val tmp = File(context.filesDir, META_FILE + ".tmp")
        tmp.writeText(arr.toString())
        if (!tmp.renameTo(metaFile)) {
            tmp.delete()
            throw StoreException("Could not persist device metadata")
        }
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(KEY_SIZE_BITS)
                .build(),
        )
        return gen.generateKey()
    }

    private companion object {
        const val META_FILE = "devices.json"
        const val SECRET_FILE = "connections.enc"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "zcode_connection_key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_SIZE_BITS = 256
        const val GCM_IV_LENGTH = 12
        const val GCM_TAG_BITS = 128
    }
}
