// ZCode Android shell — root build.
// AGP / Kotlin versions are declared here via the plugins DSL so every module
// resolves the same plugin versions.
plugins {
    id("com.android.application") version "8.10.1" apply false
    id("org.jetbrains.kotlin.android") version "2.1.0" apply false
}
