package io.github.xhwxt.zcodemobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PermissionPolicyTest {

    @Test
    fun `first run prompts`() {
        assertTrue(PermissionPolicy.shouldPrompt(promptCount = 0, dismissed = false))
    }

    @Test
    fun `dismissed stops every future prompt`() {
        assertFalse(PermissionPolicy.shouldPrompt(promptCount = 0, dismissed = true))
        assertFalse(PermissionPolicy.shouldPrompt(promptCount = 1, dismissed = true))
    }

    @Test
    fun `prompt count saturates at the platform limit`() {
        assertTrue(PermissionPolicy.shouldPrompt(promptCount = 1, dismissed = false))
        assertFalse(PermissionPolicy.shouldPrompt(promptCount = 2, dismissed = false))
        assertFalse(PermissionPolicy.shouldPrompt(promptCount = 3, dismissed = false))
    }

    @Test
    fun `next prompt count increments`() {
        assertEquals(1, PermissionPolicy.nextPromptCount(0))
        assertEquals(2, PermissionPolicy.nextPromptCount(1))
    }

    @Test
    fun `explanations are non-empty`() {
        assertTrue(PermissionPolicy.BATTERY_PROMPT_EXPLANATION.isNotEmpty())
        assertTrue(PermissionPolicy.SETTINGS_HINT.isNotEmpty())
    }
}
