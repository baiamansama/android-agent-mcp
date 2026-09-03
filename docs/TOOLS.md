# Tool reference

37 tools. Generated from the server's own schemas, so the descriptions here are the ones your MCP
client actually receives.

`device` is accepted by every tool except `mobile_list_available_devices` and is **optional**: when
exactly one device is connected it is resolved automatically. Pass it when more than one is.

Tools marked **agent** need the on-device agent; without it they return an actionable error naming
the command to start it. Everything else works on either transport. See
[ARCHITECTURE.md](ARCHITECTURE.md) for what the agent changes.

---

## Reading the screen
Everything here is cheap and safe to repeat. Prefer the element list to a screenshot: it answers "what is on screen" faster, costs far fewer tokens, and its `#tags` feed the element tools directly.

### `mobile_list_elements_on_screen`
The screen as a compact semantic tree: one element per line — `#test-tag "text" (label) Type @x,y wxh clickable scrollable hidden`. Prefer this over screenshots; it is faster and cheaper, and the #tags feed mobile_tap_on_element directly. `hidden` marks nodes present but not visible to the user (agent transport only) — never plan a tap on one. The header reports `transport` (agent = live in-process tree; adb = XML dump without visibility) and `foreground` — if foreground is not the app you expect, the tree belongs to something else. diff:true returns only lines added (+) and removed (-) since the previous list call, which is much cheaper after a small change. Do not cache this result.

| Parameter | Type | |
|---|---|---|
| `filter` | `all` \| `interactive` | interactive returns only clickable/focused elements and named fields — the actionable subset. Default all. |
| `verbose` | `boolean` | Return the legacy JSON element objects instead of compact lines. Costs roughly 3x the tokens. |
| `diff` | `boolean` | Return only the change against the previous list call: `+` added lines, `-` removed lines. Falls back to the full tree when there is no baseline. |

### `mobile_find_elements`
Find elements by test tag, tag prefix, or lenient text match, without tapping. Returns the matches most-specific first. Use idPrefix to enumerate a family such as shell.dock. — useful for discovering what a screen exposes.

| Parameter | Type | |
|---|---|---|
| `id` | `string` | Exact test tag / resource-id |
| `idPrefix` | `string` | Test tag prefix, e.g. shell.dock. |
| `text` | `string` | Visible text or accessibility label. Matched leniently. |

### `mobile_list_windows` · **agent**
List every application and IME window, topmost first, with the package that owns each and which one is in the foreground. Use this when a dump looks like it belongs to the wrong app, when a dialog or bottom sheet may be covering the screen, or before asserting that the app under test is actually in front. Requires the in-process agent.

### `mobile_take_screenshot`
Screenshot, downscaled and compressed on the device for token economy. This is the fallback, not the default: mobile_list_elements_on_screen answers "what is on screen" faster and cheaper, and its #tags feed the element tools directly. Reach for pixels only when layout, imagery or rendering itself is the question. Do not cache this result.

| Parameter | Type | |
|---|---|---|
| `maxWidth` | `number` | Longest acceptable image width in pixels. Default: device width divided by display scale, floored at 480 for legibility. |
| `quality` | `number` | JPEG quality. Default 75. |

### `mobile_save_screenshot`
Save a full-resolution screenshot of the mobile device to a file

| Parameter | Type | |
|---|---|---|
| `saveTo` *(required)* | `string` | The path to save the screenshot to. Filename must end with .png, .jpg, or .jpeg |

### `mobile_get_screen_size`
Screen geometry in pixels and in dp, with the androidx window size class the window falls in. The dp width is what adaptive layouts branch on — pixels alone cannot tell a 1280dp tablet from a 900dp one, and both report as "a tablet". Coordinates for every other tool in this server are in pixels.

Width classes are `compact` (<600dp), `medium` (600–839), `expanded` (840–1199), `large` (1200–1599) and `extraLarge` (≥1600); height classes are `compact` (<480dp), `medium` (480–899) and `expanded` (≥900). The breakpoints are `androidx.window.core.layout.WindowSizeClass`'s, so the class reported here is the class the app under test branched on.

---

## Acting by identity
The preferred way to act. A selector is a test tag (`id`), a tag prefix (`idPrefix`), or `text` matched after folding bidi isolates, Arabic diacritics, hamza/alef forms, Uzbek apostrophe variants, case and whitespace. A text selector never resolves to the soft keyboard's own keys.

### `mobile_tap_on_element`
Tap (or long-press) an element by its Compose test tag or by its visible text. Prefer this over tapping coordinates: a tag survives relayout, scrolling and translation, whereas coordinates do not. Text matching ignores Arabic diacritics, bidi isolates and Uzbek apostrophe variants, and never resolves to the soft keyboard's own keys.

| Parameter | Type | |
|---|---|---|
| `id` | `string` | Exact test tag / resource-id, e.g. shell.dock.library |
| `idPrefix` | `string` | Test tag prefix — taps the best (visible-first) member of a family, e.g. dictionary.search.result. for the first search result |
| `text` | `string` | Visible text or accessibility label. Matched leniently. |
| `longPress` | `boolean` | Long-press instead of tapping — context menus, drag-mode entry, word selection. |

### `mobile_set_text` · **agent**
Replace a named field's contents. Unicode-safe: handles Arabic, Cyrillic and Uzbek U+02BB with no keyboard installed, which adb text entry cannot do. Empty string clears the field. To append at the cursor instead, use mobile_type_keys. Requires the in-process agent; mobile_agent_status reports whether it is running.

| Parameter | Type | |
|---|---|---|
| `id` | `string` | Test tag / resource-id of the field |
| `text` | `string` | Visible text or label identifying the field |
| `value` *(required)* | `string` | Text to write. Empty string clears the field. |

### `mobile_scroll_into_view`
Scroll a named element into view through its nearest scrollable container, then return it. Use this instead of repeated swipe-and-screenshot loops: it stops as soon as the element is visible and reports when the container has run out of content. Requires the in-process agent.

| Parameter | Type | |
|---|---|---|
| `id` | `string` | Exact test tag / resource-id |
| `idPrefix` | `string` | Test tag prefix, e.g. shell.dock. |
| `text` | `string` | Visible text or accessibility label. Matched leniently. |
| `maxScrolls` | `number` | Give up after this many scrolls. Default 12. |

### `mobile_type_keys`
Type text into the focused field, appending at the cursor — Unicode-safe (Arabic, Cyrillic, Uzbek ʻ) through the in-process agent; ASCII-only over bare adb. To replace a field's contents, use mobile_set_text instead.

| Parameter | Type | |
|---|---|---|
| `text` *(required)* | `string` | The text to type |
| `submit` *(required)* | `boolean` | Whether to submit the text. If true, the text will be submitted as if the user pressed the enter key. |

---

## Acting by coordinate
For when there is nothing to name — a canvas, a map, a game surface — or when you are reproducing an exact gesture. Coordinates are device pixels, the same space element bounds are reported in.

### `mobile_click_on_screen_at_coordinates`
Click on the screen at given x,y coordinates. If clicking on an element, use the list_elements_on_screen tool to find the coordinates.

| Parameter | Type | |
|---|---|---|
| `x` *(required)* | `number` | The x coordinate to click on the screen, in pixels |
| `y` *(required)* | `number` | The y coordinate to click on the screen, in pixels |

### `mobile_double_tap_on_screen` · **agent**
Double-tap on the screen at given x,y coordinates. Through the in-process agent both taps are injected inside the platform's double-tap window; over adb the two taps land too far apart and may register as two singles.

| Parameter | Type | |
|---|---|---|
| `x` *(required)* | `number` | The x coordinate to double-tap, in pixels |
| `y` *(required)* | `number` | The y coordinate to double-tap, in pixels |

### `mobile_long_press_on_screen_at_coordinates`
Long press on the screen at given x,y coordinates. If long pressing on an element, use the list_elements_on_screen tool to find the coordinates.

| Parameter | Type | |
|---|---|---|
| `x` *(required)* | `number` | The x coordinate to long press on the screen, in pixels |
| `y` *(required)* | `number` | The y coordinate to long press on the screen, in pixels |
| `duration` | `number` | Duration of the long press in milliseconds. Defaults to 500ms. |

### `mobile_swipe_on_screen`
Swipe on the screen. Direction is FINGER direction: swiping up scrolls the content down.

| Parameter | Type | |
|---|---|---|
| `direction` *(required)* | `up` \| `down` \| `left` \| `right` | The direction the finger moves |
| `x` | `number` | The x coordinate to start the swipe from, in pixels. If not provided, uses center of screen |
| `y` | `number` | The y coordinate to start the swipe from, in pixels. If not provided, uses center of screen |
| `distance` | `number` | The distance to swipe in pixels. Defaults to 30% of the screen dimension |

### `mobile_gesture` · **agent**
Drive one finger through a timed path in device pixels: drags, curves, reorder-by-drag. holdMs long-presses before the first move, which is how drag-and-drop starts. Injected as a real MotionEvent stream via the in-process agent; without the agent only a plain 2-point line is possible. NOTE: a path starting within ~50px of a screen edge triggers the system edge gesture (back/home/notification shade) — start further in to drag content.

| Parameter | Type | |
|---|---|---|
| `points` *(required)* | `array` | The path, first point = touch down, last point = lift |
| `holdMs` | `number` | Hold at the first point before moving — 600+ enters drag mode in most lists |

### `mobile_pinch` · **agent**
Two-finger pinch about a centre point — zoom maps, images, readers. Requires the in-process agent (adb cannot inject a second finger). Spreads are finger-to-finger distances in pixels: endSpread > startSpread zooms in.

| Parameter | Type | |
|---|---|---|
| `mode` | `open` \| `close` | Convenience preset: open = zoom in (200→800px), close = zoom out (800→200px), centred on screen unless overridden |
| `centerX` | `number` | Centre X in device pixels. Default: screen centre. |
| `centerY` | `number` | Centre Y in device pixels. Default: screen centre. |
| `startSpread` | `number` | Finger distance at start, pixels |
| `endSpread` | `number` | Finger distance at end, pixels |
| `durationMs` | `number` | Default 400 |
| `angleDeg` | `number` | Finger axis; 0 = horizontal. Default 0. |

### `mobile_press_button`
Press a button on device

| Parameter | Type | |
|---|---|---|
| `button` *(required)* | `string` | The button to press: BACK, HOME, APP_SWITCH, POWER, WAKEUP, MENU, VOLUME_UP, VOLUME_DOWN, ENTER, TAB, DELETE, ESCAPE, PAGE_UP, PAGE_DOWN, MEDIA_PLAY_PAUSE, MEDIA_NEXT, MEDIA_PREVIOUS, DPAD_* — or any raw Android KEYCODE_* name for the rest of the keymap |

### `mobile_open_url`
Open a URL in browser on device

| Parameter | Type | |
|---|---|---|
| `url` *(required)* | `string` | The URL to open |

---

## Waiting and asserting
Assertions poll until true or deadline, so an assert *is* a wait — that is what absorbs debounces, animations and transitions. Reach for these instead of sleeping.

### `mobile_wait_for_stable`
Block until the screen stops changing. Use after a tap, launch or navigation instead of sleeping. A sample costs ~120ms through the in-process agent and ~2s over the adb fallback; either way one call here beats repeated polling. Returns stable:false on timeout rather than failing, since some surfaces animate forever.

| Parameter | Type | |
|---|---|---|
| `timeoutMs` | `number` | Give up after this long. Default 20000. |
| `settleSamples` | `number` | Consecutive identical dumps required. Default 2. |

### `mobile_assert`
Assert something about the screen, waiting up to timeoutMs for it to come true — an assertion is a wait, so debounces, list population and transitions are absorbed instead of raced. Prefer this over listing elements and eyeballing them: it states the expectation, reports what was actually found, and turns a three-call inspect-and-compare loop into one call. Checks are ANDed; omitted checks are not evaluated.

| Parameter | Type | |
|---|---|---|
| `id` | `string` | Exact test tag / resource-id |
| `idPrefix` | `string` | Test tag prefix, e.g. shell.dock. |
| `text` | `string` | Visible text or accessibility label. Matched leniently. |
| `exists` | `boolean` | Whether the selector should match anything at all. Defaults to true. |
| `visible` | `boolean` | Whether a match must be actually visible to the user (isVisibleToUser via the agent), not merely present in the tree. Reported as unknown over the adb transport. |
| `textEquals` | `string` | Exact expected text on the best match, compared leniently (diacritics and bidi marks folded). |
| `minCount` | `number` | Minimum number of matches. |
| `foregroundPackage` | `string` | Package that must own the foreground window. Guards against asserting on the wrong app. |
| `timeoutMs` | `number` | How long to keep re-checking before declaring failure. Default 4000. 0 = single immediate check. |

### `mobile_run_steps`
Run a whole journey in one call, settling between steps: launch, tap, long-press, set Unicode text, scroll to an element, assert, press buttons, swipe. Stops at the first failing step with per-step timings, so one call replaces five round trips and the log says exactly where and why it stopped. Set snapshot:true to receive the final screen's compact element tree in the same result — saving the follow-up list call.

| Parameter | Type | |
|---|---|---|
| `steps` *(required)* | `array` | Steps, executed in order |
| `settle` | `boolean` | Wait for the UI to settle between steps. Default true. |
| `snapshot` | `boolean` | Append the final screen's compact element tree to the result. Default false. |

---

## Apps and devices

### `mobile_list_available_devices`
List connected Android devices and emulators. This fork is Android-only. Rarely needed: every other tool resolves the device automatically when exactly one is connected.

### `mobile_list_apps`
List all the installed apps on the device

### `mobile_launch_app`
Launch an app on mobile device. Use this to open a specific app. You can find the package name of the app by calling list_apps_on_device.

| Parameter | Type | |
|---|---|---|
| `packageName` *(required)* | `string` | The package name of the app to launch |
| `locale` | `string` | Comma-separated BCP 47 locale tags to launch the app with (e.g., fr-FR,en-GB) |

### `mobile_terminate_app`
Stop and terminate an app on mobile device

| Parameter | Type | |
|---|---|---|
| `packageName` *(required)* | `string` | The package name of the app to terminate |

### `mobile_install_app`
Install an app on mobile device

| Parameter | Type | |
|---|---|---|
| `path` *(required)* | `string` | The path to the .apk file to install |

### `mobile_uninstall_app`
Uninstall an app from mobile device

| Parameter | Type | |
|---|---|---|
| `bundle_id` *(required)* | `string` | Package name of the app to be uninstalled |

### `mobile_app_state`
Inspect or reset one app's environment. action info: version, running state and pid — verify what you are actually testing. clear: erase the app's data and stop it, the reset-to-first-launch primitive (signs the user out; irreversible). locale: read or set the app's own locale without touching device language (API 33+) — pass locales to set (e.g. "ar" or "ru-RU,en"; empty string resets), omit to read; the app recreates its activities immediately. permissions: list, grant or revoke runtime permissions via permissionAction + permissions (short names are expanded, CAMERA -> android.permission.CAMERA; revoking a permission in use kills the process, exactly as the OS does).

| Parameter | Type | |
|---|---|---|
| `packageName` *(required)* | `string` | The app package |
| `action` *(required)* | `info` \| `clear` \| `locale` \| `permissions` | What to do |
| `locales` | `string` | For action locale: comma-separated BCP 47 tags to set. Empty string resets. Omit to read. |
| `permissionAction` | `list` \| `grant` \| `revoke` | For action permissions. Default list. |
| `permissions` | `array` | For grant/revoke: permission names, short or fully qualified |

---

## Environment
The matrix a visible change has to survive, settable in one call each.

### `mobile_device_state`
Read or change the device-state matrix in one call: display (font scale, dark mode, animations, density), window size class, connectivity (airplane mode, wifi, mobile data) and orientation. Call with no arguments to read everything, including the window's dp geometry and its androidx size class. Name any subset to change it; the full post-change snapshot is returned. This is the matrix a visible change must survive — font scale for Dynamic Type, night mode for dark theme, animations off for deterministic screenshots, `size` for the adaptive width bands, airplane mode for the offline release gates. Values persist on the device, so reset what you change, and always restore connectivity when an offline check is done.

| Parameter | Type | |
|---|---|---|
| `fontScale` | `number` | System font scale, e.g. 0.85, 1.0, 1.3, 2.0. A common release gate is that text stays readable at the largest scales. |
| `nightMode` | `yes` \| `no` \| `auto` | Dark theme. |
| `animations` | `boolean` | false zeroes window, transition and animator scales together — use before screenshot comparison. true sets all three to 1.0, which is a normalization, not a restore: read the state first if the device had non-default scales. |
| `density` | `union` | Screen density in dpi, or "reset" to restore the physical value. Changing this re-creates activities. |
| `airplaneMode` | `boolean` | Enter or leave airplane mode. |
| `wifi` | `boolean` | Turn wifi on/off. |
| `mobileData` | `boolean` | Turn mobile data on/off. |
| `orientation` | `portrait` \| `landscape` | Rotate the display (verified: the call blocks until the display actually turns). |
| `size` | `string` | Resize the window to a size class, so one device can be driven through every adaptive band: "compact", "medium", "expanded", "large", "extraLarge", an explicit "<width>x<height>" in dp, or "reset" to restore the physical size. A named band changes width only and holds height, so the width class is the single variable that moved. Verified: the display is re-read afterwards and the call fails rather than reporting a band it did not reach. |

`size` exists because one tablet can stand in for the whole range. A named band holds height
deliberately: the Material reflow bugs this is for live at a width band crossed *at a given height*
(`SupportingPaneScaffold` reflows its supporting pane under the main one at width 600–840dp and
height ≥900dp), and a resize that moved both would step straight over them.

Two measured details it handles for you. `wm size` does not resize the current window — it redefines
the display's **natural** frame, and the live window is that frame turned by `user_rotation`; writing
a size therefore silently changes what an already-written rotation means. On the Pixel Tablet AVD
(2026-09-03), a 1400×1600 override with `user_rotation 1` gave landscape, and after `wm size reset`
the same unchanged `1` gave portrait. So the rotation is pinned while the size is written and the
result is read back from the window manager rather than assumed; `reset` then restores the
orientation it found, because a reset should undo the size and nothing else.

### `mobile_emulator`
Emulator-only controls a stock physical device cannot offer, via the emulator console: network shaping (bandwidth profile and latency — the slow-network half of the offline release gates), battery level and AC simulation, and fold/unfold or posture for foldable AVDs. Name any subset; each command's console reply is reported. Restore shaping to full/none when the check is done. Fails on a physical device.

| Parameter | Type | |
|---|---|---|
| `networkSpeed` | `string` | Bandwidth profile: full, gsm, edge, 3g, lte, hsdpa, umts, or min:max in kbps (e.g. 128:256) |
| `networkDelay` | `string` | Latency profile: none, gprs, edge, umts, or min:max in ms (e.g. 300:400) |
| `batteryLevel` | `number` | Simulated battery percentage |
| `ac` | `boolean` | Simulated charger connected |
| `fold` | `boolean` | true folds, false unfolds (foldable AVDs only) |
| `posture` | `number` | Posture id for foldable AVDs (see `adb emu posture` docs) |
| `status` | `boolean` | Include `network status` output in the result |

---

## Diagnostics

### `mobile_logcat`
Read logcat, scoped to stay quotable: by app (pid-filtered), priority, tag, and line cap; includes the crash buffer by default. mark:true stamps the current device time and returns immediately — a later call with sinceMark:true returns only what happened after the stamp, which is the right way to capture 'the log of this one action'.

| Parameter | Type | |
|---|---|---|
| `packageName` | `string` | Only lines from this app's process. The app must be running (pid filter). |
| `priority` | `V` \| `D` \| `I` \| `W` \| `E` \| `F` | Minimum priority. Default I. |
| `tag` | `string` | Only this log tag (exact), silencing everything else |
| `lines` | `number` | Tail cap. Default 200. |
| `mark` | `boolean` | Stamp now as the mark for sinceMark and return without reading |
| `sinceMark` | `boolean` | Only lines after the last mark for this device |

### `mobile_list_crashes`
List crash, ANR, native-crash and WTF entries from the device's DropBox, most recent last. Each entry is `<date> <time> <tag>`; pass the tag (optionally with the timestamp) to mobile_get_crash. Fast: reads the index, not the reports.

| Parameter | Type | |
|---|---|---|
| `limit` | `number` | Most recent N entries. Default 20. |

### `mobile_get_crash`
Get the content of a crash/ANR report by its DropBox tag, e.g. data_app_crash or data_app_anr — optionally preceded by the `YYYY-mm-dd HH:MM:SS` timestamp from mobile_list_crashes to select one specific entry. Output is tail-capped; the stack trace lives at the end, which is the part that survives.

| Parameter | Type | |
|---|---|---|
| `id` *(required)* | `string` | DropBox tag, optionally prefixed with the entry's date and time |
| `maxBytes` | `number` | Keep at most this many bytes from the end. Default 16384. |

### `mobile_start_screen_recording`
Start recording the screen of a mobile device. The recording runs in the background until stopped with mobile_stop_screen_recording. Returns the path where the recording will be saved.

| Parameter | Type | |
|---|---|---|
| `output` | `string` | The file path to save the recording to. Filename must end with .mp4. If not provided, a temporary path will be used. |
| `timeLimit` | `number` | Maximum recording duration in seconds. The recording will stop automatically after this time. |

### `mobile_stop_screen_recording`
Stop an active screen recording, finalize it on the device, and pull the .mp4 to the host. Returns the file path, size, and approximate duration.

### `mobile_watch`
Open or close a live mirror window of the device on this Mac via scrcpy, so a human can watch the automation as it happens — the Android counterpart of the iOS simulator panel. Mainly for physical devices; an emulator usually already shows its own window. Requires scrcpy (brew install scrcpy). The window closes when this server exits.

| Parameter | Type | |
|---|---|---|
| `action` *(required)* | `start` \| `stop` \| `status` | start opens the mirror window, stop closes it, status reports |

### `mobile_agent_status`
Report which transport is in use, and — when the agent is absent — exactly why and how to fix it. The on-device agent reads the live accessibility tree (~10-20x faster), acts on nodes instead of coordinates so nothing can be mis-tapped through the keyboard, reports real per-node visibility, and supports Unicode text entry. Without it everything still works over adb, minus those four things.
