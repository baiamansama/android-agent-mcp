plugins {
	// AGP 9 applies the Kotlin plugin itself; adding org.jetbrains.kotlin.android is an error.
	alias(libs.plugins.android.application)
}

android {
	namespace = "dev.androidagent.driver"
	compileSdk = libs.versions.compileSdk.get().toInt()

	defaultConfig {
		applicationId = "dev.androidagent.driver"
		minSdk = libs.versions.minSdk.get().toInt()
		targetSdk = libs.versions.targetSdk.get().toInt()
		versionCode = 1
		versionName = "0.1.0"

		// The driver's instrumentation targets its OWN package. That is the whole point: starting
		// the agent restarts this empty stub's process rather than the app under test, so the app
		// keeps its state across an agent (re)start. UiAutomation still sees every window on the
		// device, so the agent drives any app regardless of what it targets.
		testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
	}

	buildTypes {
		// Only debug is built. The artifact is developer tooling installed by hand over adb, and a
		// debug-signed APK installs anywhere without a release keystore.
		debug {
			isMinifyEnabled = false
		}
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}
}

kotlin {
	compilerOptions {
		jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
	}
}

dependencies {
	androidTestImplementation(libs.junit)
	androidTestImplementation(libs.androidx.junit)
	androidTestImplementation(libs.androidx.test.runner)
	androidTestImplementation(libs.uiautomator)
}
