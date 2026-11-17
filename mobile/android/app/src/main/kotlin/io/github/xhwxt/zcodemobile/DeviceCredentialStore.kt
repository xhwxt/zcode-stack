package io.github.xhwxt.zcodemobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Stores one device's long-lived credential, encrypted with a non-exportable
 * Android Keystore key — the property that makes a stolen file copy useless
 * (mirrors dsh-mobile's `DeviceCredentialStore`).
 *
 * One store per device (`slot` = device id), each with its own Keystore alias, so
 * revoking or deleting one device never touches another's material. The
 * short-lived session token is deliberately **not** persisted: it is re-derived
 * by `DeviceAuthClient.renew` on every launch.
 *
 * Any Keystore failure surfaces as [StoreException]; there is no plaintext
 * fallback.
 */
class DeviceCredentialStore(context: Context, private val slot: String = "default") {

    private val preferences = context.getSharedPreferences(PREFS_NAME + "_" + slot, Context.MODE_PRIVATE)
    private val alias: String = ALIAS_PREFIX + slot

    class StoreException(message: String) : Exception(message)

    data class Credential(
        val deviceId: String,
        val deviceToken: String,
        val expiresAt: Long,
    )

    fun load(): Credential? {
        val encoded = preferences.getString(KEY_PAYLOAD, null) ?: return null
        val raw = try {
            Base64.decode(encoded, Base64.NO_WRAP)
        } catch (e: Exception) {
            throw StoreException("credential payload is not decodable")
        }
        if (raw.size <= IV_BYTES) throw StoreException("credential payload is truncated")
        val iv = raw.copyOfRange(0, IV_BYTES)
        val cipherText = raw.copyOfRange(IV_BYTES, raw.size)
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, existingKey(), GCMParameterSpec(TAG_BITS, iv))
            val json = JSONObject(String(cipher.doFinal(cipherText), Charsets.UTF_8))
            Credential(
                deviceId = json.optString("deviceId", ""),
                deviceToken = json.optString("deviceToken", ""),
                expiresAt = json.optLong("expiresAt", 0L),
            )
        } catch (e: Exception) {
            throw StoreException("credential could not be decrypted")
        }
    }

    fun save(credential: Credential) {
        val json = JSONObject()
            .put("deviceId", credential.deviceId)
            .put("deviceToken", credential.deviceToken)
            .put("expiresAt", credential.expiresAt)
            .toString()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val payload = cipher.iv + cipher.doFinal(json.toByteArray(Charsets.UTF_8))
        val committed = preferences.edit()
            .putString(KEY_PAYLOAD, Base64.encodeToString(payload, Base64.NO_WRAP))
            .commit()
        if (!committed) throw StoreException("credential could not be persisted")
    }

    /** Drops the stored credential (device revoked, deleted, or re-paired). */
    fun clear() {
        preferences.edit().remove(KEY_PAYLOAD).commit()
        runCatching {
            KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }.deleteEntry(alias)
        }
    }

    private fun key(): SecretKey = existingKey() ?: generateKey()

    private fun generateKey(): SecretKey =
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }

    private fun existingKey(): SecretKey? = runCatching {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        keyStore.getKey(alias, null) as? SecretKey
    }.getOrNull()

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val ALIAS_PREFIX = "zcode_device_v1_"
        private const val PREFS_NAME = "zcode_device_credential"
        private const val KEY_PAYLOAD = "credential"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
    }
}
