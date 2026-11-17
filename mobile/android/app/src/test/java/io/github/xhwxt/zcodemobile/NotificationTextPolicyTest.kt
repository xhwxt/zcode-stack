package io.github.xhwxt.zcodemobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationTextPolicyTest {

    @Test
    fun `collapses line breaks into a single line`() {
        assertEquals("a b c", NotificationTextPolicy.title("a\nb\r\nc"))
    }

    @Test
    fun `drops control characters`() {
        assertEquals("ab", NotificationTextPolicy.title("a\u0000\u0007b"))
    }

    @Test
    fun `trims surrounding whitespace`() {
        assertEquals("任务完成", NotificationTextPolicy.title("   任务完成   "))
    }

    @Test
    fun `caps the title at the bridge limit`() {
        val long = "x".repeat(200)
        assertEquals(NotificationTextPolicy.TITLE_MAX_CHARS, NotificationTextPolicy.title(long).length)
    }

    @Test
    fun `caps the body at the bridge limit`() {
        val long = "y".repeat(500)
        assertEquals(NotificationTextPolicy.BODY_MAX_CHARS, NotificationTextPolicy.body(long).length)
    }

    @Test
    fun `null input becomes empty`() {
        assertEquals("", NotificationTextPolicy.title(null))
        assertEquals("", NotificationTextPolicy.body(null))
    }

    @Test
    fun `empty after sanitising means nothing to show`() {
        assertTrue(NotificationTextPolicy.isEmpty("", ""))
        assertTrue(NotificationTextPolicy.isEmpty(NotificationTextPolicy.title("\n\n"), ""))
        assertFalse(NotificationTextPolicy.isEmpty("完成", ""))
        assertFalse(NotificationTextPolicy.isEmpty("", "需要你确认"))
    }

    @Test
    fun `truncation counts code points and never splits a surrogate pair`() {
        // 79 ASCII + one emoji = 80 code points (81 UTF-16 units): kept whole.
        val exactly80 = "a".repeat(79) + "\uD83D\uDE00"
        val kept = NotificationTextPolicy.title(exactly80)
        assertEquals(exactly80, kept)
        assertEquals(81, kept.length)

        // 80 ASCII + emoji is over the cap: the emoji is dropped, not halved.
        val overCap = "a".repeat(80) + "\uD83D\uDE00"
        val clamped = NotificationTextPolicy.title(overCap)
        assertEquals("a".repeat(80), clamped)
        assertEquals(80, clamped.length)
        // No lone surrogate anywhere in the result.
        assertFalse(clamped.any { it.isHighSurrogate() || it.isLowSurrogate() })
    }

    @Test
    fun `unicode survives sanitising`() {
        assertEquals("任务「生成报告」完成 ✅", NotificationTextPolicy.body("任务「生成报告」完成 ✅"))
    }

    @Test
    fun `english interaction reason is replaced with the chinese fallback`() {
        val replacement = "有新的问题需要你处理"
        // The exact server-side shape: `Tool ${toolName} requires user interaction`.
        assertEquals(
            replacement,
            NotificationTextPolicy.localizeBody("Tool AskUserQuestion requires user interaction", replacement),
        )
        // Substring match: any sentence carrying the pattern is caught.
        assertEquals(
            replacement,
            NotificationTextPolicy.localizeBody("xxx requires user interaction xxx", replacement),
        )
    }

    @Test
    fun `other english and chinese bodies pass through untouched`() {
        // No guessing beyond the one known pattern.
        assertEquals(
            "Tool Bash requires approval",
            NotificationTextPolicy.localizeBody("Tool Bash requires approval", "有新的问题需要你处理"),
        )
        assertEquals(
            "随便什么中文",
            NotificationTextPolicy.localizeBody("随便什么中文", "有新的问题需要你处理"),
        )
        assertEquals("", NotificationTextPolicy.localizeBody(null, "有新的问题需要你处理"))
    }
}
