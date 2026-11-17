package io.github.xhwxt.zcodemobile

import android.graphics.Insets
import android.os.Build
import android.view.View
import android.view.WindowInsets

/**
 * Ported from the dsh-mobile shell's WindowInsets.kt (Apache-2.0), reduced to
 * this app's minSdk 29: the WebView is offset below the status bar/cutout by
 * [resolveTopSafeInset] and above the keyboard by [resolveWebViewImeInset];
 * the remaining insets are forwarded to the Web page (its own safe-area CSS
 * handles any rest).
 */

/** Native top safe area: status bar or display cutout, whichever is taller. */
internal fun resolveTopSafeInset(insets: WindowInsets): Int {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        return maxOf(
            insets.getInsets(WindowInsets.Type.statusBars()).top,
            insets.getInsets(WindowInsets.Type.displayCutout()).top,
        )
    }
    @Suppress("DEPRECATION")
    return maxOf(insets.systemWindowInsetTop, insets.displayCutout?.safeInsetTop ?: 0)
}

/** Keyboard overlap that must shrink the WebView viewport. */
internal fun resolveWebViewImeInset(insets: WindowInsets): Int {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        // Keyboard closed → ime inset 0; keyboard open → clear the keyboard.
        return insets.getInsets(WindowInsets.Type.ime()).bottom
    }
    @Suppress("DEPRECATION")
    return insets.systemWindowInsetBottom
}

/**Insets forwarded to the Web content after the shell took its top offset. */
internal fun insetsForWebContent(insets: WindowInsets, top: Int): WindowInsets {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val belowTop = if (top > 0) insets.inset(0, top, 0, 0) else insets
        return WindowInsets.Builder(belowTop)
            .setInsets(WindowInsets.Type.ime(), Insets.NONE)
            .setVisible(WindowInsets.Type.ime(), false)
            .build()
    }
    @Suppress("DEPRECATION")
    return insets.replaceSystemWindowInsets(
        insets.systemWindowInsetLeft,
        insets.systemWindowInsetTop,
        insets.systemWindowInsetRight,
        insets.systemWindowInsetBottom,
    )
}
