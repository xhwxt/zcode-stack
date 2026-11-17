package io.github.xhwxt.zcodemobile

import android.content.Intent
import android.net.Uri
import android.webkit.WebChromeClient

/**
 * Helpers around the ACTION_OPEN_DOCUMENT picker used for web file uploads.
 * Separate from the Activity so picker behavior stays small and reviewable.
 */
object WebFiles {

    // MIME types offered to the document picker; the catch-all star-slash-star value accepts everything.
    const val ACCEPT_TYPE: String = "*/*"

    /** True when the web page asked for multiple files. */
    fun allowsMultiple(mode: Int): Boolean =
        mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE

    /** Extracts the picked document URIs from a picker result intent. */
    fun pickedUris(data: Intent?): Array<Uri>? {
        if (data == null) return null
        val clip = data.clipData
        return if (clip != null && clip.itemCount > 0) {
            Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
        } else {
            data.data?.let { arrayOf(it) }
        }
    }
}
