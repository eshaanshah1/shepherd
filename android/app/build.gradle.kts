plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

/**
 * Firebase is applied ONLY when its config file is present.
 *
 * `google-services.json` carries a project's own push credentials, so it is not
 * in the repository — and with the plugin applied unconditionally its absence
 * fails the build outright, before a single line of Kotlin is compiled. That
 * makes push a hard dependency of *building the terminal*, which it is not: the
 * app's FCM path is already written to be dark without a key (see `FcmWake`),
 * and the host's is too.
 *
 * So a checkout without the file builds a working app with no push, and one with
 * the file gets push. The alternative — a placeholder json checked in — is worse:
 * it builds an app that believes it can register for push and fails somewhere
 * far from here.
 */
val hasFirebaseConfig = file("google-services.json").exists()
if (hasFirebaseConfig) {
    apply(plugin = "com.google.gms.google-services")
} else {
    logger.lifecycle("shepherd: no google-services.json — building without push (FCM stays dark)")
}

android {
    // android.util.Log is a THROWING stub in plain JVM unit tests, so adding a log line to any
    // covered code path would fail the test rather than the code. Defaults make the stubs inert —
    // logging must never be able to change an outcome.
    testOptions { unitTests.isReturnDefaultValues = true }

    namespace = "com.eshaan.shepherd"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.eshaan.shepherd"
        minSdk = 31
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(composeBom)
    androidTestImplementation(composeBom)
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("com.github.termux.termux-app:terminal-view:v0.118.0")   // pulls terminal-emulator transitively
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("androidx.appcompat:appcompat:1.7.0")   // ZXing CaptureActivity extends AppCompatActivity
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation(platform("com.google.firebase:firebase-bom:33.3.0"))
    implementation("com.google.firebase:firebase-messaging")
    // The REAL org.json, because android.jar's is a stub that returns defaults
    // under `isReturnDefaultValues` — so a round-trip test would silently
    // assert nothing at all rather than fail.
    testImplementation("org.json:json:20240303")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
}
