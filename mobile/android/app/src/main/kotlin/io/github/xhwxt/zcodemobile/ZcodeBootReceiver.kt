package io.github.xhwxt.zcodemobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences

/**
 * Re-arms the keep-alive foreground service after a reboot. The user's choice
 * is remembered: a disabled keep-alive stays off (the notification action
 * flips [ZcodeKeepaliveService.PREF_KEEPALIVE_ENABLED]); the default is on,
 * matching the user's explicit ask for task notifications.
 */
class ZcodeBootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val preferences: SharedPreferences =
            context.getSharedPreferences(ZcodeKeepaliveService.PREFS_NAME, Context.MODE_PRIVATE)
        ZcodeKeepaliveService.ensureStarted(context, preferences)
    }
}
