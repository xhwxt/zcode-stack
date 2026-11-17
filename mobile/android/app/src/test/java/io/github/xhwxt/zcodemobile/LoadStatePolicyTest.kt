package io.github.xhwxt.zcodemobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LoadStatePolicyTest {

    @Test
    fun `loading shows the spinner only`() {
        val visual = LoadStatePolicy.visual(LoadStatePolicy.Kind.LOADING)
        assertFalse(visual.iconVisible)
        assertTrue(visual.spinnerVisible)
    }

    @Test
    fun `failed shows the icon only`() {
        val visual = LoadStatePolicy.visual(LoadStatePolicy.Kind.FAILED)
        assertTrue(visual.iconVisible)
        assertFalse(visual.spinnerVisible)
    }

    @Test
    fun `only a shown failure state is dismissible`() {
        assertFalse(LoadStatePolicy.dismissibleOnErrorDismiss(null))
        assertFalse(LoadStatePolicy.dismissibleOnErrorDismiss(LoadStatePolicy.Kind.LOADING))
        assertTrue(LoadStatePolicy.dismissibleOnErrorDismiss(LoadStatePolicy.Kind.FAILED))
    }
}
