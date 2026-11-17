package io.github.xhwxt.zcodemobile

import android.app.Dialog
import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * The shell's own dialogs: a themed rounded card built from [ShellPalette] and
 * [ShellUi], replacing the system AlertDialog whose chrome read as foreign on
 * both the dark and the light page (the rest of the shell is painted in code
 * for exactly that reason — see ShellPalette's class comment).
 *
 * Structure: optional title, optional message, a content view the caller may
 * supply (input rows, settings rows), then buttons in the load-state layout's
 * hierarchy — primary action filled/emphasised, secondary quiet. Buttons are
 * optional; a dialog without buttons manages its own dismissal. The primary
 * button is tagged (see [Dialog.primaryButton]) so callers can enable/disable
 * it around async work.
 */
private const val TAG_PRIMARY_BUTTON = "zcode_shell_dialog_primary"

/** Primary-button lookup for callers doing async submit flows. */
val Dialog.primaryButton: Button?
    get() = window?.decorView?.findViewWithTag(TAG_PRIMARY_BUTTON)

object ShellDialogs {

    /** Primary button: tonal surface like load_state's primary. */
    fun primaryButton(context: Context, p: ShellPalette): Button =
        Button(context).apply {
            background = ShellUi.primaryButton(context, p)
            setTextColor(p.foreground)
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            stateListAnimator = null
            minHeight = dp(context, 48)
            setPadding(dp(context, 16), dp(context, 10), dp(context, 16), dp(context, 10))
        }

    /** Secondary button: quiet surface like load_state's secondary. */
    fun secondaryButton(context: Context, p: ShellPalette): Button =
        Button(context).apply {
            background = ShellUi.secondaryButton(context, p)
            setTextColor(p.secondary)
            textSize = 14f
            stateListAnimator = null
            minHeight = dp(context, 44)
            setPadding(dp(context, 16), dp(context, 10), dp(context, 16), dp(context, 10))
        }

    /**
     * Builds and shows the dialog. [content] is inserted between the message
     * and the buttons; [onPrimary]/[onSecondary] receive the dialog so the
     * caller decides whether to dismiss.
     */
    fun show(
        context: Context,
        palette: ShellPalette,
        title: String? = null,
        message: String? = null,
        contentView: View? = null,
        primaryText: String? = null,
        onPrimary: ((Dialog) -> Unit)? = null,
        secondaryText: String? = null,
        onSecondary: ((Dialog) -> Unit)? = null,
        cancelable: Boolean = true,
        onCancel: (() -> Unit)? = null,
    ): Dialog {
        val p = palette
        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = ShellUi.rounded(context, p.surface, p.border, radiusDp = 16f)
            setPadding(dp(context, 22), dp(context, 20), dp(context, 22), dp(context, 18))
        }

        if (!title.isNullOrEmpty()) {
            root.addView(
                TextView(context).apply {
                    text = title
                    setTextColor(p.foreground)
                    textSize = 18f
                    typeface = Typeface.DEFAULT_BOLD
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
        }

        if (!message.isNullOrEmpty()) {
            root.addView(
                TextView(context).apply {
                    text = message
                    setTextColor(p.secondary)
                    textSize = 14f
                    setLineSpacing(0f, 1.4f)
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = dp(context, if (title.isNullOrEmpty()) 0 else 10) },
            )
        }

        if (contentView != null) {
            root.addView(
                contentView,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply {
                    topMargin = dp(context, if (title.isNullOrEmpty() && message.isNullOrEmpty()) 0 else 14)
                },
            )
        }

        if (primaryText != null) {
            root.addView(
                primaryButton(context, p).apply {
                    text = primaryText
                    tag = TAG_PRIMARY_BUTTON
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = dp(context, 20) },
            )
        }
        if (secondaryText != null) {
            root.addView(
                secondaryButton(context, p).apply { text = secondaryText },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = dp(context, 10) },
            )
        }

        val dialog = Dialog(context)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.setContentView(ScrollView(context).apply {
            isVerticalScrollBarEnabled = false
            addView(root)
        })
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            // Inset card: 24dp side margins via decor padding (WRAP_CONTENT
            // height keeps the card snug; wide margins as layout params would
            // stretch MATCH_PARENT rows).
            decorView.setPadding(dp(context, 24), 0, dp(context, 24), 0)
            setLayout(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }
        dialog.setCancelable(cancelable)
        dialog.setOnCancelListener { onCancel?.invoke() }

        // Wire buttons after insertion (they capture the dialog).
        if (primaryText != null) {
            (root.findViewWithTag<View>(TAG_PRIMARY_BUTTON) as? Button)
                ?.setOnClickListener { onPrimary?.invoke(dialog) }
        }
        if (secondaryText != null) {
            (root.getChildAt(root.childCount - 1) as? Button)
                ?.setOnClickListener { onSecondary?.invoke(dialog) }
        }
        dialog.show()
        return dialog
    }

    /** Simple options sheet (the device action menu): a vertical list of rows. */
    fun showOptions(
        context: Context,
        palette: ShellPalette,
        title: String,
        options: List<String>,
        onPick: (index: Int, Dialog) -> Unit,
        cancelable: Boolean = true,
    ): Dialog {
        val p = palette
        val list = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
        }
        options.forEachIndexed { index, label ->
            list.addView(
                TextView(context).apply {
                    text = label
                    setTextColor(p.foreground)
                    textSize = 15f
                    setPadding(dp(context, 14), dp(context, 13), dp(context, 14), dp(context, 13))
                    background = optionBackground(context, p)
                    isClickable = true
                    isFocusable = true
                    setOnClickListener { }
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = if (index == 0) 0 else dp(context, 4) },
            )
        }
        val dialog = show(
            context = context,
            palette = palette,
            title = title,
            contentView = list,
            cancelable = cancelable,
        )
        // Wire the rows now that the dialog exists.
        options.forEachIndexed { index, _ ->
            (list.getChildAt(index) as? TextView)?.setOnClickListener {
                onPick(index, dialog)
            }
        }
        return dialog
    }

    private fun optionBackground(context: Context, p: ShellPalette): Drawable =
        RippleDrawable(
            android.content.res.ColorStateList.valueOf(p.border),
            ShellUi.rounded(context, p.background, p.border, radiusDp = 10f),
            null,
        )

    private fun dp(context: Context, value: Int): Int =
        (value * context.resources.displayMetrics.density).toInt()
}
