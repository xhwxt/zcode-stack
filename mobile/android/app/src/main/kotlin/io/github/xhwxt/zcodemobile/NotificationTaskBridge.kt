package io.github.xhwxt.zcodemobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * Builds the keep-alive service's status notification, separated from the
 * service class so the channel/notification wiring stays in one reviewable
 * place. Two lines: the app name, then a status summary (running/completed
 * counters or idle). Theme accent follows the page color when reported.
 */
object NotificationTaskBridge {

    fun ensureKeepaliveChannel(context: Context, prominence: KeepaliveStatusPolicy.Prominence) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return
        val channelId = ZcodeKeepaliveService.channelIdFor(prominence)
        if (manager.getNotificationChannel(channelId) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                channelId,
                context.getString(R.string.notification_keepalive_channel),
                KeepaliveStatusPolicy.importanceFor(prominence),
            ).apply {
                description = context.getString(R.string.notification_keepalive_channel_description)
                setShowBadge(false)
            },
        )
    }

    /**
     * The silent status-light row: open on tap, a "stop" action as the user's
     * off switch, summary line by [KeepaliveStatusPolicy]. Priority follows the
     * channel; MIN leaves no status-bar icon. When the "show completed" switch
     * is off the completed figure is dropped from the summary.
     */
    fun statusNotification(
        context: Context,
        openIntent: PendingIntent,
        stopIntent: PendingIntent,
        prominence: KeepaliveStatusPolicy.Prominence,
        summary: KeepaliveStatusPolicy.Summary,
        themeColor: Int? = null,
        showCompleted: Boolean = true,
    ): Notification {
        val effective = if (showCompleted) summary else summary.copy(completedUnread = 0)
        val line = KeepaliveStatusPolicy.summaryLine(effective)
        val body = when (line.textRes) {
            R.string.keepalive_status_running ->
                context.getString(R.string.keepalive_status_running, line.arg1, line.arg2)
            R.string.keepalive_status_completed ->
                context.getString(R.string.keepalive_status_completed, line.arg1)
            R.string.keepalive_status_disconnected ->
                context.getString(R.string.keepalive_status_disconnected)
            R.string.keepalive_status_no_credential ->
                context.getString(R.string.keepalive_status_no_credential)
            else -> context.getString(R.string.keepalive_status_idle)
        }
        val channelId = ZcodeKeepaliveService.channelIdFor(prominence)
        ensureKeepaliveChannel(context, prominence)
        return NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.notification_keepalive_running))
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openIntent)
            .addAction(0, context.getString(R.string.notification_keepalive_stop), stopIntent)
            .setOngoing(true)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .apply {
                themeColor?.let { setColor(it).setColorized(true) }
            }
            .build()
    }
}
