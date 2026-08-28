# Troubleshooting

Failure modes worth knowing, most common first. Several of these are *silent* — the tool keeps
working and simply gets slower or less accurate — which is why they are written down.

## `mobile_agent_status` says `transport: "adb"`

Everything still works; you have lost per-node visibility, gestures/pinch, precise double-tap, and
non-ASCII text entry, and reads are 10–20× slower. When the agent is absent the tool also returns
`installedInstrumentations` and a `startCommand`, which usually identifies the cause immediately.

**The driver was never installed.** `installedInstrumentations` will not list
`dev.androidagent.driver.test`. Fix:

```bash
npm run agent:install
```

**The driver is installed under a different package than the server expects.** Compare the
`agentPackage` field against the list. This happens when you renamed the driver, or set
`ANDROID_AGENT_TEST_PACKAGE` for an embedded agent that is not actually installed. Point the server
at what is really there:

```bash
ANDROID_AGENT_TEST_PACKAGE=com.example.app.test
```

**Protocol mismatch.** The host refuses an agent whose protocol number differs from its own, so a
driver APK built from a different commit is rejected rather than half-working. Rebuild:

```bash
npm run agent:install -- --rebuild
```

**Embedded mode, app already running.** In embedded mode `am instrument` restarts your app, so the
host refuses to auto-start the agent mid-session and stays on adb. It re-arms on the next
`mobile_launch_app`. This guard does not exist in standalone mode — which is the main reason to
prefer the bundled driver. See [ARCHITECTURE.md §2](ARCHITECTURE.md#2-why-the-driver-is-a-separate-app).

## `uiautomator dump was killed`

```
uiautomator dump was killed, which means something else holds this device's single
UiAutomation connection — normally the in-process agent.
```

Exactly what it says. The device has one `UiAutomation` and the agent has it. This only appears if
something forced the adb path while the agent was live. Either let the server use the agent, or
release it:

```bash
adb shell am force-stop dev.androidagent.driver.test
```

## `INSTRUMENTATION_FAILED` / `Instrumentation target has no code`

The driver app APK is missing or was installed without its dex. Install **both** APKs — the app and
the androidTest APK — which `npm run agent:install` does. Installing only the test APK produces
exactly this.

## `ClassNotFoundException: androidx.test.runner.AndroidJUnitRunner`

The instrumentation APK does not contain the runner. `androidx.test.ext:junit` does **not** pull
`androidx.test:runner` in transitively; it has to be declared. If you are building an embedded
agent, add it:

```kotlin
androidTestImplementation("androidx.test:runner:1.7.0")
```

## Text entry fails on a Compose field

Check `method` in the response and `clipboard` in `mobile_agent_status`.

A controlled Compose field accepts `ACTION_SET_TEXT`, reports the new value long enough to pass a
naive check, then reverts — the app's own state never changed and no `onValueChange` fired. The
agent detects this and escalates to clipboard-paste, which runs through the field's real editing
pipeline.

If `clipboard: false`, that escalation is unavailable: this device denies clipboard writes to a
process that is not focused, and the agent could not get around it via shell permission identity.
Options, in order of preference:

1. Use `mobile_type_keys` for ASCII, which can go through key events.
2. Run the agent in [embedded mode](ARCHITECTURE.md#embedded-mode), where it shares your app's own
   clipboard and the restriction does not apply.

## Taps report `method: "gesture"` instead of `"node"`

Not a problem — the tap worked. It means `ACTION_CLICK` was accepted but changed nothing, so the
agent fell back to injecting a real `MotionEvent`. This is routine on Compose surfaces, where every
clickable can publish a click action it does not honour. See
[ARCHITECTURE.md §4](ARCHITECTURE.md#4-verify-dont-trust).

If you have a control whose click genuinely changes nothing on screen, pass `gestureFallback:false`
at the protocol level to suppress the retry.

## A selector matches the keyboard, or matches nothing

**Nothing:** the error lists the tags actually on screen. Usually the screen is still loading, the
surface is untagged, or the app you expect is not in front — check `foreground` in the error.

**The keyboard:** should not happen; IME windows are excluded from selection by default. If a
selector still resolves oddly, use `mobile_list_windows` to see the whole stack — a dialog or
bottom sheet may own the topmost window.

**A `testTag` you know you set is missing:** the merged accessibility tree is the ceiling. A tag on
a bare layout container can be pruned before it reaches the tree. Tag interactive and scrollable
nodes instead, and verify against a real dump.

## A selected navigation tab reports `clickable: false`

Expected. `Role.Tab` plus selected state reports that way. Selection never filters on clickability
for this reason, so you can still tap it.

## Two devices connected, and the wrong one responds

The server refuses to guess: pass `device` explicitly, and `--device` to the installer. Host ports
for the agent forward are derived per device (`8299 + hash(deviceId) % 400`) precisely so a second
device cannot steal the first's forward — but the *driver* still has to be installed on each device
you intend to drive.

## Network shaping does nothing

`mobile_emulator` bandwidth and latency shaping go through the emulator console (`-netdelay` /
`-netspeed`). A stock physical device cannot do it. Battery simulation and fold/posture are
emulator-only for the same reason.

## Gradle fails to build the driver

Needs **JDK 17+** and the Android SDK. If `java -version` is older, point Gradle at a newer one —
Android Studio ships one:

```bash
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" npm run agent:build
```

AGP 9 applies the Kotlin plugin itself; adding `org.jetbrains.kotlin.android` alongside it is an
error, not a redundancy.

## Still stuck

Open an issue with the output of `mobile_agent_status`, your `adb devices -l`, and the device's API
level. Those three answer most of what anyone would ask first.
