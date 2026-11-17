package io.github.xhwxt.zcodemobile

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Native task notifications, posted when the ZCode page reports that a task
 * finished while the app was in the background.
 *
 * Why the shell has to do this: the page already asks for a notification
 * (`packages/web/src/main.tsx` calls `new window.Notification(...)` when
 * `document.hasFocus()` is false), but Android WebView does not implement the
 * Web Notifications API, so `window.Notification` is undefined there and the
 * page silently gives up. [ThemeChannel] installs a page-side shim that routes
 * that call here — the same split dsh-mobile uses (document-start shim plus a
 * native `NotificationChannel`).
 *
 * Deliberate parity with dsh-mobile (NativeBridge.kt):
 *  - channel importance DEFAULT, so the notification has a sound/vibration;
 *  - tapping it opens the app (no per-session deep link);
 *  - an empty notification is never posted;
 *  - the permission is only ever requested from a visible screen, never from a
 *    background page.
 *
 * Body text passes through [NotificationTextPolicy.localizeBody] first: the
 * server still emits one English reason ("… requires user interaction") that
 * the page can forward verbatim; the shell replaces it with a generic Chinese
 * line rather than guessing at other English patterns.
 */
class TaskNotifier(private val activity: Activity) {

    /** True when the OS will actually show our notifications. */
    fun canNotify(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) return false
        // The app-level switch can be on while this one channel is switched off
        // in system settings; notify() would then succeed silently and the user
        // would never learn why nothing arrives.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            val channel = manager?.getNotificationChannel(CHANNEL_ID)
            if (channel != null && channel.importance == NotificationManager.IMPORTANCE_NONE) return false
        }
        return true
    }

    fun requestPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (canNotify()) return
        activity.requestPermissions(
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            REQUEST_CODE,
        )
    }

    /**
     * Page theme accent to tint the notification with (see [themeColor]). Null
     * until the page has reported; the notification then falls back to the
     * platform accent.
     */
    @Volatile
    var themeColor: Int? = null

    /**
     * Posts (or replaces) the task notification. Replacing rather than stacking
     * is intentional: the page does not hand us a task identifier, so several
     * finished tasks would otherwise pile up with identical text.
     */
    fun post(title: String, body: String): Boolean {
        if (!canNotify()) return false
        ensureChannel()
        val intent = Intent(activity, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val contentIntent = PendingIntent.getActivity(
            activity,
            NOTIFICATION_ID,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val shownTitle = title.ifEmpty { body }
        val localizedBody = NotificationTextPolicy.localizeBody(
            body,
            activity.getString(R.string.notification_interaction_fallback),
        )
        val shownBody = if (title.isEmpty() || localizedBody.isEmpty()) null else localizedBody
        val notification = baseBuilder(CHANNEL_ID)
            .setContentTitle(shownTitle)
            .setContentText(shownBody)
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        return try {
            NotificationManagerCompat.from(activity).notify(TAG, NOTIFICATION_ID, notification)
            true
        } catch (e: SecurityException) {
            // Permission revoked between the check and the post.
            false
        }
    }

    /**
     * Clears the task notification: the page reports that the pending
     * interaction was answered (via the `notify-clear` shell message), so the
     * stale "需要你的处理" entry must go even when the user never tapped it.
     */
    fun cancel() {
        NotificationManagerCompat.from(activity).cancel(TAG, NOTIFICATION_ID)
    }

    /**
     * The pending-interaction fallback notification's own slot. Deliberately
     * separate from [NOTIFICATION_ID]: the page channel owns that one while
     * the app is foreground, and this watchdog fires exactly when it cannot
     * (backgrounded WebView) — separate ids mean the two paths never replace
     * each other's row mid-flight.
     */
    fun pendingNotificationId(): Int = PENDING_NOTIFICATION_ID

    /**
     * Cancels the pending-interaction fallback: the probe reported the count
     * back at zero (the user answered on the server / another device), so a
     * still-standing "有 N 项等待你的回复" would be a stale lie.
     */
    fun cancelPending(context: Context) {
        NotificationManagerCompat.from(context).cancel(TAG, PENDING_NOTIFICATION_ID)
    }

    /** Shared builder: small icon + optional theme accent for colorized rows. */
    fun baseBuilder(channelId: String): NotificationCompat.Builder =
        NotificationCompat.Builder(activity, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .apply {
                themeColor?.let { setColor(it).setColorized(true) }
            }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        ensureChannelStatic(activity)
    }

    companion object {
        const val CHANNEL_ID: String = "zcode_task_completion"
        const val NOTIFICATION_ID: Int = 7301
        const val TAG: String = "zcode-task"
        const val REQUEST_CODE: Int = 4101

        /**
         * The pending-interaction fallback notification's own slot, separate
         * from [NOTIFICATION_ID]: the page channel owns that one while the app
         * is foreground, and the probe watchdog fires exactly when it cannot
         * (backgrounded WebView) — separate ids mean the two paths never
         * replace each other's row mid-flight.
         */
        const val PENDING_NOTIFICATION_ID: Int = 7303

        /**
         * Static poster for the probe thread's pending-interaction watchdog.
         *
         * Why static and not the Activity-bound instance: the watchdog exists
         * for the moment the app is *backgrounded* — the Activity may be
         * destroyed while the foreground service keeps probing, so the poster
         * holds the application context only. It reuses the task channel and
         * the same permission checks as the instance path; the accent color
         * stays whatever the page last reported elsewhere (a cold fallback
         * keeps the platform accent, acceptable for a minute-level path).
         *
         * Same slot per batch: repeated probes with an equal count re-post the
         * same id (Android replaces in place, no pile-up), and the diff layer
         * only calls this on a rising edge anyway.
         *
         * [digestText] is the optional probe digest of the first pending item
         * (single line, already redacted server-side). When present it becomes
         * the body — the actual thing waiting for the user — and the batch
         * count moves to the subtitle so no information is lost. When null
         * (older server / no digest) the row is exactly the count-only
         * fallback it has always been; the page's own foreground notification
         * uses the *other* slot with the real question text.
         */
        fun postPendingStatic(context: Context, current: Int, digestText: String? = null) {
            if (current <= 0) return
            if (!canNotifyStatic(context)) return
            ensureChannelStatic(context)
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val contentIntent = PendingIntent.getActivity(
                context,
                PENDING_NOTIFICATION_ID,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val title = context.getString(R.string.notification_pending_title)
            val countLine = context.getString(R.string.notification_pending_body, current)
            val digest = digestText?.takeIf { it.isNotBlank() }
            val body = digest ?: countLine
            val builder = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            if (digest != null) builder.setSubText(countLine)
            val notification = builder.build()
            try {
                NotificationManagerCompat.from(context).notify(TAG, PENDING_NOTIFICATION_ID, notification)
            } catch (e: SecurityException) {
                // Permission revoked between the check and the post.
            }
        }

        /** Instance-free permission/channel check mirroring [canNotify]. */
        private fun canNotifyStatic(context: Context): Boolean {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                return false
            }
            if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                val channel = manager?.getNotificationChannel(CHANNEL_ID)
                if (channel != null && channel.importance == NotificationManager.IMPORTANCE_NONE) return false
            }
            return true
        }

        /**
         * Instance-free channel creation mirroring [ensureChannel]: the static
         * poster may run with no Activity alive, so it must be able to create
         * the task channel itself (idempotent, no new channel id).
         */
        private fun ensureChannelStatic(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                ?: return
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.notification_channel_tasks),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = context.getString(R.string.notification_channel_tasks_description)
                },
            )
        }
    }
}
