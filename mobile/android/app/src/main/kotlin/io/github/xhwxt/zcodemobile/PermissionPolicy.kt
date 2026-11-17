package io.github.xhwxt.zcodemobile

/**
 * Pure-JVM gating for the shell's battery-optimization exemption prompt
 * (no Android imports, mirroring [KeepalivePolicy] / [DownloadPolicy] so the
 * decision table stays unit-testable; the caller wires PowerManager and intents).
 *
 * Why the exemption matters: the keep-alive foreground service only survives
 * aggressive vendor ROMs (vivo 等) when the app is exempt from battery
 * optimization. There is no public API to flip it silently — the shell can
 * only raise the system dialog (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`)
 * or guide the user into the vendor's own settings.
 *
 * Prompt discipline (parity with the POST_NOTIFICATIONS gate in MainActivity):
 *  - asked at most [MAX_PROMPTS] times ever;
 *  - the user's explicit "不再提醒" stops every future prompt;
 *  - afterwards the only re-entry is the devices screen' permission card.
 */
object PermissionPolicy {

    /**
     * How many times the system dialog may be raised in total. Matches the
     * platform's own behaviour for runtime permissions: after two denials the
     * dialog would no longer show anyway, so asking a third time only
     * dead-ends.
     */
    const val MAX_PROMPTS: Int = 2

    /** Shown once per prompt when the user asks why. */
    const val BATTERY_PROMPT_EXPLANATION: String =
        "为了在后台也能收到任务完成提醒，ZCode 需要请求系统「忽略电池优化」。" +
            "同意后不会被系统强制休眠，通知才能及时送达。"

    /**
     * Vendor ROMs (vivo 等) hide their real switches (自启动 / 后台高耗电) behind
     * proprietary settings with no public API. The shell can only open the
     * app-info page; this line names what the user must switch by hand there.
     */
    const val SETTINGS_HINT: String =
        "部分手机（如 vivo）还需要在应用信息里手动允许「自启动」和「后台高耗电」，" +
            "否则后台连接仍可能被系统断开。"

    /** True when the system dialog may be raised for these persisted inputs. */
    fun shouldPrompt(promptCount: Int, dismissed: Boolean): Boolean {
        if (dismissed) return false
        return promptCount < MAX_PROMPTS
    }

    /** The count to persist after a prompt was actually raised. */
    fun nextPromptCount(promptCount: Int): Int = promptCount + 1
}
