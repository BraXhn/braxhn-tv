plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "net.braxhn.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "net.braxhn.tv"
        minSdk = 29          // Android Automotive i Polestar 4 kör Android 12+ (API 31+)
        targetSdk = 34
        versionCode = 5
        versionName = "0.6.0"
    }

    signingConfigs {
        // Valfri egen nyckel för release (GitHub Actions sätter dessa som hemligheter)
        create("release") {
            val ks = System.getenv("BRAXHN_KEYSTORE")
            if (ks != null && file(ks).exists()) {
                storeFile = file(ks)
                storePassword = System.getenv("BRAXHN_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("BRAXHN_KEY_ALIAS")
                keyPassword = System.getenv("BRAXHN_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            val rel = signingConfigs.getByName("release")
            signingConfig = if (rel.storeFile != null) rel else signingConfigs.getByName("debug")
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
    val media3 = "1.4.1"
    implementation(platform("androidx.compose:compose-bom:2024.09.02"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    implementation("androidx.media3:media3-session:$media3")
    implementation("io.coil-kt:coil-compose:2.7.0")
    // Google TV / Android TV: Fortsätt titta (Watch Next) – används bara på TV
    implementation("androidx.tvprovider:tvprovider:1.0.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-guava:1.8.1")
}
