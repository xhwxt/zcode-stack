package io.github.xhwxt.zcodemobile

import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView

/**
 * Renders the saved ZCode servers as designed cards: name, "page kind · host",
 * a status line with a coloured dot, a ⋮ action button and a chevron hint.
 * The visual language follows the dsh-mobile device list (card row, coloured
 * status dot, trailing action + chevron, per-row accessibility description).
 *
 * [deviceExpiresAt] carries each device's credential lifetime (absent when the
 * credential is missing or unreadable) so rows of temporary devices are marked
 * with their remaining lifetime; full-lifetime devices stay unmarked.
 *
 * All colours come from [ShellPalette] and are applied in code: the shell's
 * palette changes with the live page theme, and themed XML drawables would be
 * cached with the previous palette (which previously left dark cards on a light
 * screen). [updatePalette] therefore repaints rows in place.
 */
class DeviceListAdapter(
    private val context: Context,
    private val devices: List<DeviceStore.DeviceMeta>,
    private var palette: ShellPalette,
    private var activeId: String?,
    private val deviceExpiresAt: Map<String, Long>,
    private val onOpen: (DeviceStore.DeviceMeta) -> Unit,
    private val onActions: (DeviceStore.DeviceMeta) -> Unit,
) : BaseAdapter() {

    /** Swaps the palette and repaints every visible row. */
    fun updatePalette(next: ShellPalette) {
        palette = next
        notifyDataSetChanged()
    }

    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
        val view = convertView ?: LayoutInflater.from(context)
            .inflate(R.layout.item_device, parent, false)
        val device = devices[position]
        val p = palette

        val name = view.findViewById<TextView>(R.id.device_name)
        val detail = view.findViewById<TextView>(R.id.device_detail)
        val status = view.findViewById<TextView>(R.id.device_status)
        val dot = view.findViewById<View>(R.id.device_status_dot)
        val more = view.findViewById<ImageButton>(R.id.device_more)
        val chevron = view.findViewById<ImageView>(R.id.device_chevron)
        val badge = view.findViewById<TextView>(R.id.device_temp_badge)

        val isCurrent = device.id == activeId
        val kind = if (device.kind == "remote") {
            context.getString(R.string.device_kind_remote)
        } else {
            context.getString(R.string.device_kind_direct)
        }
        val statusLabel = if (isCurrent) {
            context.getString(R.string.device_status_current)
        } else {
            context.getString(R.string.device_status_saved)
        }
        val statusText = context.getString(
            R.string.device_status_summary,
            statusLabel,
            relativeTime(context, device.lastUsedAt),
        )

        // Card surface + border, with the row itself carrying the ripple.
        view.background = ShellUi.card(context, p)
        name.text = device.name
        name.setTextColor(p.foreground)
        detail.text = context.getString(R.string.device_detail_line, kind, device.origin)
        detail.setTextColor(p.secondary)

        // Green dot marks the server currently open in the shell; the rest stay
        // neutral so the list reads at a glance.
        val statusColor = if (isCurrent) p.success else p.secondary
        status.text = statusText
        status.setTextColor(statusColor)
        dot.background = ShellUi.dot(context, statusColor)

        // Temporary-device marker: the credential lives shorter than a full
        // (non-sliding) 90-day lifetime. Under an hour left the row just says
        // "temporary" — the hour figure would change every minute for nothing.
        val badgeText = deviceExpiresAt[device.id]
            ?.takeIf { DeviceAuthPolicy.isTemporary(it, System.currentTimeMillis()) }
            ?.let { expiresAt ->
                val remaining = expiresAt - System.currentTimeMillis()
                if (remaining < 3_600_000L) {
                    context.getString(R.string.device_temp_short)
                } else {
                    context.getString(R.string.device_temp_hours, remaining / 3_600_000L)
                }
            }
        if (badgeText != null) {
            badge.text = badgeText
            badge.setTextColor(p.error)
            badge.visibility = View.VISIBLE
        } else {
            badge.visibility = View.GONE
        }

        more.setColorFilter(p.secondary)
        chevron.setColorFilter(p.secondary)

        more.setOnClickListener { onActions(device) }
        // Row-level handlers (not ListView item clicks): the row is clickable for
        // its ripple, so a clickable child would swallow item-click callbacks.
        // Same approach as the dsh-mobile device list.
        view.setOnClickListener { onOpen(device) }
        view.setOnLongClickListener {
            it.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
            onActions(device)
            true
        }
        view.contentDescription = context.getString(
            R.string.device_row_accessibility,
            device.name,
            kind,
            device.origin,
            statusText,
        )
        return view
    }

    override fun getCount(): Int = devices.size

    override fun getItem(position: Int): Any = devices[position]

    override fun getItemId(position: Int): Long = position.toLong()

    private fun relativeTime(ctx: Context, timestamp: Long): String {
        val elapsed = (System.currentTimeMillis() - timestamp).coerceAtLeast(0L)
        return when {
            elapsed < 60_000L -> ctx.getString(R.string.device_time_now)
            elapsed < 3_600_000L ->
                ctx.getString(R.string.device_time_minutes, (elapsed / 60_000L).coerceAtLeast(1L))
            elapsed < 86_400_000L ->
                ctx.getString(R.string.device_time_hours, (elapsed / 3_600_000L).coerceAtLeast(1L))
            elapsed < 7 * 86_400_000L ->
                ctx.getString(R.string.device_time_days, (elapsed / 86_400_000L).coerceAtLeast(1L))
            else -> java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault())
                .format(java.util.Date(timestamp))
        }
    }
}
