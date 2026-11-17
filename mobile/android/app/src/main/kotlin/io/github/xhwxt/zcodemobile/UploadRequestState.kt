package io.github.xhwxt.zcodemobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.ValueCallback

/**
 * Tracks one in-flight WebChromeClient.onShowFileChooser request so the
 * Activity can decide, in onActivityResult, whether the picked documents still
 * belong to a live request from the same page over the same connection.
 *
 * A request is invalidated whenever the connection changes, the Activity is
 * destroyed, or the backing WebView is recreated.
 */
class UploadRequestState {

    data class Pending(
        val id: Long,
        val callback: ValueCallback<Array<Uri>>,
        val connectionId: Long,
        val filePathCallbackHash: Int,
    )

    private var counter: Long = 0
    private var pending: Pending? = null

    /**
     * Registers a new file-chooser request. Returns the request id to store for
     * later correlation, or null when another request is still pending
     * (in that case the caller must fail the new request immediately).
     */
    @Synchronized
    fun begin(callback: ValueCallback<Array<Uri>>, connectionId: Long): Long? {
        if (pending != null) return null
        counter += 1
        pending = Pending(
            id = counter,
            callback = callback,
            connectionId = connectionId,
            filePathCallbackHash = System.identityHashCode(callback),
        )
        return counter
    }

    /** Singleton request-code used with ACTION_OPEN_DOCUMENT for file choosing. */
    companion object {
        const val REQUEST_CODE: Int = 4001
    }

    /**
     * Resolves the pending request against an incoming activity result.
     * Returns true when a live request was completed (its callback already
     * received the picked URIs, or null on cancel). Returns false when the
     * request id, the activity, or the connection no longer matches — the
     * stale callback is then dropped without being completed.
     */
    @Synchronized
    fun resolve(
        requestCode: Int,
        resultCode: Int,
        data: Intent?,
        activity: Activity?,
        currentConnectionId: Long,
    ): Boolean {
        val current = pending ?: return false
        pending = null
        if (requestCode != REQUEST_CODE) return false
        if (activity == null || activity.isFinishing || activity.isDestroyed) return false
        if (current.connectionId != currentConnectionId) return false
        val uris: Array<Uri>? = if (resultCode == Activity.RESULT_OK) {
            WebFiles.pickedUris(data)
        } else {
            null
        }
        current.callback.onReceiveValue(uris)
        return true
    }

    /** Drops any pending request, failing its callback so the page is not left hanging. */
    @Synchronized
    fun invalidate() {
        pending?.callback?.onReceiveValue(null)
        pending = null
    }

    /** True while a request is in flight. */
    @Synchronized
    fun hasPending(): Boolean = pending != null
}
