package io.github.xhwxt.zcodemobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellMessagePolicyTest {

    @Test
    fun `theme messages parse dark and color`() {
        val msg = ShellMessagePolicy.parse("theme:dark:rgb(22, 22, 22)")
        assertTrue(msg is ShellMessagePolicy.ShellMessage.Theme)
        msg as ShellMessagePolicy.ShellMessage.Theme
        assertTrue(msg.dark)
        assertEquals("rgb(22, 22, 22)", msg.rgb)

        val light = ShellMessagePolicy.parse("theme:light:#fafafa")
        assertTrue(light is ShellMessagePolicy.ShellMessage.Theme)
        light as ShellMessagePolicy.ShellMessage.Theme
        assertTrue(!light.dark)
        assertEquals("#fafafa", light.rgb)
    }

    @Test
    fun `notify keeps the json payload`() {
        val msg = ShellMessagePolicy.parse("""notify:{"title":"t","body":"b"}""")
        assertEquals("""{"title":"t","body":"b"}""", (msg as ShellMessagePolicy.ShellMessage.Notify).json)
    }

    @Test
    fun `notify-clear clears the notification`() {
        assertEquals(
            ShellMessagePolicy.ShellMessage.NotifyClear,
            ShellMessagePolicy.parse("notify-clear"),
        )
    }

    @Test
    fun `tasks-consumed resets the unread-completed counter`() {
        assertEquals(
            ShellMessagePolicy.ShellMessage.TasksConsumed,
            ShellMessagePolicy.parse("tasks-consumed"),
        )
        // "notify-clear"-like prefixes must not swallow it, and vice versa.
        assertEquals(
            ShellMessagePolicy.ShellMessage.NotifyClear,
            ShellMessagePolicy.parse("notify-clear:extra"),
        )
    }

    @Test
    fun `state and devices messages parse`() {
        assertEquals(ShellMessagePolicy.ShellMessage.StateFailed, ShellMessagePolicy.parse("state:failed"))
        assertEquals(ShellMessagePolicy.ShellMessage.StateOk, ShellMessagePolicy.parse("state:ok"))
        assertEquals(ShellMessagePolicy.ShellMessage.Devices, ShellMessagePolicy.parse("devices"))
    }

    @Test
    fun `task counter messages parse as exact matches without payload`() {
        assertEquals(ShellMessagePolicy.ShellMessage.TaskStarted, ShellMessagePolicy.parse("task-started"))
        assertEquals(ShellMessagePolicy.ShellMessage.TaskFinished, ShellMessagePolicy.parse("task-finished"))
        // Near-misses must not be swallowed by prefix matching: these carry an
        // unexpected payload or suffix, so they fall through to Ignore.
        assertEquals(ShellMessagePolicy.ShellMessage.Ignore, ShellMessagePolicy.parse("task-started:x"))
        assertEquals(ShellMessagePolicy.ShellMessage.Ignore, ShellMessagePolicy.parse("task-started "))
        assertEquals(ShellMessagePolicy.ShellMessage.Ignore, ShellMessagePolicy.parse("task-finished:x"))
        assertEquals(ShellMessagePolicy.ShellMessage.Ignore, ShellMessagePolicy.parse("task-start"))
        // Neither task message may collide with the notify prefix family.
        assertEquals(ShellMessagePolicy.ShellMessage.Ignore, ShellMessagePolicy.parse("task"))
    }

    @Test
    fun `unknown and blank messages are silently ignored`() {
        assertEquals(ShellMessagePolicy.ShellMessage.Ignore, ShellMessagePolicy.parse("whatever"))
        assertEquals(ShellMessagePolicy.ShellMessage.Ignore, ShellMessagePolicy.parse(""))
        assertEquals(ShellMessagePolicy.ShellMessage.Ignore, ShellMessagePolicy.parse(null))
        assertEquals(ShellMessagePolicy.ShellMessage.Ignore, ShellMessagePolicy.parse("   "))
    }
}
