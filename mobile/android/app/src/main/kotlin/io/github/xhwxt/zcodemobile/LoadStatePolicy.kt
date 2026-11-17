package io.github.xhwxt.zcodemobile

/**
 * Pure-JVM contract for the shell's single load-state view (the merged
 * "connecting" overlay and error page). The Activity owns the view tree; this
 * file owns the decisions so they stay unit-testable without a device.
 *
 * One view, two states, one pair of buttons: the primary button is always the
 * device-list escape hatch and the secondary is always the retry action, in the
 * same slots — switching between loading and failed must not move anything
 * under the user's finger (the two former layouts disagreed on icon, type size
 * and button order, which read as a jarring scene change mid-load).
 */
object LoadStatePolicy {

    enum class Kind { LOADING, FAILED }

    /** Which of the two mutually exclusive indicators the state shows. */
    data class Visual(
        val iconVisible: Boolean,
        val spinnerVisible: Boolean,
    )

    fun visual(kind: Kind): Visual = when (kind) {
        Kind.LOADING -> Visual(iconVisible = false, spinnerVisible = true)
        Kind.FAILED -> Visual(iconVisible = true, spinnerVisible = false)
    }

    /**
     * Whether a `showErrorPage(show = false)` (page started loading again, the
     * page recovered) may clear the shared view. A *loading* view must survive:
     * those calls fire on every main-frame start, and clearing would blink the
     * overlay mid-load. Only a shown failure state is dismissed.
     */
    fun dismissibleOnErrorDismiss(kind: Kind?): Boolean = kind != null && kind != Kind.LOADING

    /**
     * The revoked-device screen is a FAILED rendering with different copy: the
     * icon + title/body layout is identical, the secondary button carries the
     * pairing action instead of a plain retry.
     */
    fun kindForError(): Kind = Kind.FAILED
}
