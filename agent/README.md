# The on-device driver

A Gradle project that builds two small APKs:

| APK | What it is |
|---|---|
| `driver-debug.apk` (852KB) | An **inert** app: no activity, no service, no receiver, nothing exported or launchable. One placeholder class, because `am instrument` refuses a target with no dex. |
| `driver-debug-androidTest.apk` (968KB) | The instrumentation that actually contains `DeviceAgent`. |

Together they give the host a fast, in-process view of the device. See
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for why this is a separate app rather than
something you add to your own, and [../docs/AGENT_PROTOCOL.md](../docs/AGENT_PROTOCOL.md) for the
wire format.

## Build and install

From the repository root — this handles both APKs, the uninstall of any previous debug-signed
install, and the sanity check that the instrumentation registered:

```bash
npm run agent:install
```

Options: `--device <id>` to pick a device, `--rebuild` to force a Gradle build, `--start` to leave
the agent running (the MCP server starts it on demand, so this is optional).

By hand:

```bash
./gradlew :driver:assembleDebug :driver:assembleDebugAndroidTest
adb install -r -g driver/build/outputs/apk/debug/driver-debug.apk
adb install -r -g driver/build/outputs/apk/androidTest/debug/driver-debug-androidTest.apk
```

Requires **JDK 17+** and the Android SDK. If your default `java` is older, Android Studio ships a
suitable one:

```bash
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew ...
```

## Run it by hand

```bash
adb shell am instrument -w \
  -e class dev.androidagent.driver.agent.DeviceAgent \
  dev.androidagent.driver.test/androidx.test.runner.AndroidJUnitRunner &
adb forward tcp:8299 tcp:8299

printf '{"op":"ping"}\n' | nc 127.0.0.1 8299
```

`am instrument` blocks while serving, hence the `&`. The agent prints
`ANDROID_AGENT_READY port=8299 protocol=6` once the socket is bound.

## Toolchain notes

Two things that will cost you an hour if you hit them cold:

- **AGP 9 applies the Kotlin plugin itself.** Adding `org.jetbrains.kotlin.android` alongside it is
  a hard error, not a redundancy.
- **`androidx.test.ext:junit` does not pull in `androidx.test:runner`.** Without an explicit
  dependency the instrumentation dies at startup with
  `ClassNotFoundException: androidx.test.runner.AndroidJUnitRunner`.

Versions are pinned in `gradle/libs.versions.toml`.

## Renaming it

Nothing in the host hardcodes these package names. If you rename the driver, tell the server:

```bash
ANDROID_AGENT_TEST_PACKAGE=com.yourorg.driver.test
ANDROID_AGENT_CLASS=com.yourorg.driver.agent.DeviceAgent
```

Set `ANDROID_AGENT_MODE=standalone` as well, since the default inference assumes anything that is
not the bundled driver is an agent embedded in an app under test — and the embedded mode is more
cautious about when it may start.
