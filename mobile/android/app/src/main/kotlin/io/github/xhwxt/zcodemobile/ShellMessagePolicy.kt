package io.github.xhwxt.zcodemobile

/**
 * Pure-JVM parsing for the page → shell message channel (ThemeChannel).
 *
 * The messages are plain prefixed strings ("theme:…", "notify:…"); the shell's
 * dispatcher lives in the Activity, but the parsing rules are extracted here so
 * they can be unit tested. Unknown messages return [ShellMessage.Ignore] — the
 * page may be older or newer than the shell, and anything unrecognized must be
 * silently dropped, never crash or notify.
 *
 * Task counters ("task-started" / "task-finished", both parameterless exact
 * matches) increment/decrement the keep-alive row's running figure. They are
 * *incremental* events, unlike the idempotent theme/state reports, so the page
 * must send each exactly once (single transport, no retry) — see ThemeChannel.
 */
object ShellMessagePolicy {

    /** Parsed shell message. */
    sealed class ShellMessage {
        /** Page theme report: "theme:dark:rgb(...)". */
        data class Theme(val dark: Boolean, val rgb: String) : ShellMessage()

        /** Open the device list. */
        object Devices : ShellMessage()

        /** Task notification payload: "notify:{json}". */
        data class Notify(val json: String) : ShellMessage()

        /** The pending interaction(s) were handled: clear the notification. */
        object NotifyClear : ShellMessage()

        /** The user has seen the finished tasks in the app: reset the count. */
        object TasksConsumed : ShellMessage()

        /** The page confirmed a task began running: increment the running count. */
        object TaskStarted : ShellMessage()

        /**
         * The page confirmed a task reached a terminal state: decrement the
         * running count (floored at zero) and mark one finished task unread.
         */
        object TaskFinished : ShellMessage()

        /** Page bootstrap failure / recovery. */
        object StateFailed : ShellMessage()
        object StateOk : ShellMessage()

        /** Anything unrecognized (including blank input). */
        object Ignore : ShellMessage()
    }

    const val PREFIX_THEME = "theme:"
    const val PREFIX_NOTIFY = "notify:"
    const val PREFIX_NOTIFY_CLEAR = "notify-clear"
    const val MSG_TASKS_CONSUMED = "tasks-consumed"
    const val MSG_TASK_STARTED = "task-started"
    const val MSG_TASK_FINISHED = "task-finished"
    const val MSG_DEVICES = "devices"
    const val MSG_STATE_FAILED = "state:failed"
    const val MSG_STATE_OK = "state:ok"

    fun parse(text: String?): ShellMessage {
        if (text.isNullOrBlank()) return ShellMessage.Ignore
        return when {
            text.startsWith(PREFIX_NOTIFY_CLEAR) -> ShellMessage.NotifyClear
            text == MSG_TASKS_CONSUMED -> ShellMessage.TasksConsumed
            text == MSG_TASK_STARTED -> ShellMessage.TaskStarted
            text == MSG_TASK_FINISHED -> ShellMessage.TaskFinished
            text.startsWith(PREFIX_NOTIFY) -> ShellMessage.Notify(text.removePrefix(PREFIX_NOTIFY))
            text.startsWith(PREFIX_THEME) -> {
                val rest = text.removePrefix(PREFIX_THEME)
                val dark = rest.startsWith("dark")
                ShellMessage.Theme(dark = dark, rgb = rest.substringAfter(':', ""))
            }

            text == MSG_DEVICES -> ShellMessage.Devices
            text == MSG_STATE_FAILED -> ShellMessage.StateFailed
            text == MSG_STATE_OK -> ShellMessage.StateOk
            else -> ShellMessage.Ignore
        }
    }
}
