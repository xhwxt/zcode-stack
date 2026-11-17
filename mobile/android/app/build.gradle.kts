plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.xhwxt.zcodemobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.xhwxt.zcodemobile"
        minSdk = 29
        targetSdk = 36
        versionCode = 29
        versionName = "0.1.7"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        debug {
            // Debug APK stays unminified by default; no debug-only surprise size.
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = false
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")

    testImplementation("junit:junit:4.13.2")
    // Unit tests run against the Android stub jar, whose org.json throws
    // "not mocked"; the protocol layer parses JSON, so tests need the real one.
    testImplementation("org.json:json:20240303")
}
