package io.github.xhwxt.zcodemobile

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable

/**
 * The shell's own palette, derived from the live ZCode page theme (zai-dark by
 * default, independent of the OS day/night setting).
 *
 * Colors are plain resources rather than theme attributes: the shell previously
 * switched themes at runtime with `setTheme()`, but Android caches themed
 * drawables per resource id, so cards/buttons kept the *previous* palette while
 * text colors switched — producing a half-light, half-dark screen. All shell
 * chrome is now painted in code from this palette, which is also what lets a
 * theme change repaint the current screen instantly without recreating the
 * Activity (and therefore without losing the WebView).
 */
data class ShellPalette(
    val background: Int,
    val surface: Int,
    val foreground: Int,
    val secondary: Int,
    val border: Int,
    val accent: Int,
    val onAccent: Int,
    val error: Int,
    val success: Int,
) {
    companion object {
        fun of(context: Context, isDark: Boolean): ShellPalette =
            if (isDark) dark(context) else light(context)

        fun light(context: Context): ShellPalette = ShellPalette(
            background = context.getColor(R.color.shell_light_background),
            surface = context.getColor(R.color.shell_light_surface),
            foreground = context.getColor(R.color.shell_light_foreground),
            secondary = context.getColor(R.color.shell_light_secondary),
            border = context.getColor(R.color.shell_light_border),
            accent = context.getColor(R.color.shell_light_accent),
            onAccent = context.getColor(R.color.shell_light_on_accent),
            error = context.getColor(R.color.shell_light_error),
            success = context.getColor(R.color.shell_light_success),
        )

        fun dark(context: Context): ShellPalette = ShellPalette(
            background = context.getColor(R.color.shell_dark_background),
            surface = context.getColor(R.color.shell_dark_surface),
            foreground = context.getColor(R.color.shell_dark_foreground),
            secondary = context.getColor(R.color.shell_dark_secondary),
            border = context.getColor(R.color.shell_dark_border),
            accent = context.getColor(R.color.shell_dark_accent),
            onAccent = context.getColor(R.color.shell_dark_on_accent),
            error = context.getColor(R.color.shell_dark_error),
            success = context.getColor(R.color.shell_dark_success),
        )

        /**
         * Light-background test by luminance, using the same threshold as the
         * dsh-mobile status-bar glyph rule. The page's own class name is only a
         * fallback: the rendered background is the authoritative signal, which
         * keeps the shell correct in the page's "system/auto" theme mode too.
         */
        fun isLight(color: Int): Boolean {
            val r = (color shr 16) and 0xFF
            val g = (color shr 8) and 0xFF
            val b = color and 0xFF
            return r * 299 + g * 587 + b * 114 >= 186_000
        }
    }
}

/** Builds the shell's flat chrome shapes in code (never themed XML drawables). */
object ShellUi {

    private fun dp(context: Context, value: Float): Float =
        value * context.resources.displayMetrics.density

    private fun strokeWidth(context: Context): Int =
        dp(context, 1f).toInt().coerceAtLeast(1)

    /** Rounded surface with an optional 1dp border. */
    fun rounded(context: Context, fill: Int, stroke: Int? = null, radiusDp: Float = 14f): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(context, radiusDp)
            setColor(fill)
            if (stroke != null) setStroke(strokeWidth(context), stroke)
        }

    /** Pressable card: ripple over a rounded surface. */
    fun card(context: Context, palette: ShellPalette): Drawable =
        RippleDrawable(
            ColorStateList.valueOf(palette.border),
            rounded(context, palette.surface, palette.border),
            null,
        )

    fun rippleOver(context: Context, mask: Int, content: Drawable): Drawable =
        RippleDrawable(ColorStateList.valueOf(mask), content, null)

    /** 8dp status dot filled with [color]. */
    fun dot(context: Context, color: Int): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setSize(dp(context, 8f).toInt(), dp(context, 8f).toInt())
            setColor(color)
        }

    fun input(context: Context, palette: ShellPalette): Drawable =
        rounded(context, palette.surface, palette.border, radiusDp = 12f)

    /**
     * Primary action: a themed tonal surface rather than the page's pure
     * black/white brand fill. Using the page's `--color-primary` verbatim made a
     * full-width button read as an inverted block (white on the dark shell,
     * near-black on the light one); emphasis comes from the border, the
     * foreground text colour and bold type instead.
     */
    fun primaryButton(context: Context, palette: ShellPalette): Drawable =
        rippleOver(context, palette.border, rounded(context, palette.surface, palette.border, radiusDp = 12f))

    fun secondaryButton(context: Context, palette: ShellPalette): Drawable =
        rippleOver(
            context,
            palette.border,
            rounded(context, palette.background, palette.border, radiusDp = 12f),
        )
}
