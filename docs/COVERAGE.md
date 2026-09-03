# Coverage matrix — android-agent-mcp vs the iOS simulator tooling

Date anchor: 2026-08-05. Refreshed 2026-08-29 at protocol 6 (standalone driver, on-device
screenshot scaling, visibility end-to-end, recording pull, device auto-resolution,
per-device serialization, `mobile_device_state` / `mobile_app_state`, `mobile_emulator`,
`mobile_watch`, tree diff mode).

The bar is the iOS Simulator tooling an LLM agent can realistically reach today: the
action-multiplexed `control` tool Claude Code ships with, plus the stronger XcodeBuildMCP
UI surface where it exceeds that bar. The comparison exists because iOS is where agent
device-control was solved first, so it is the honest yardstick for what Android tooling
should be able to do.

Apple ships and changes that tooling independently, so re-verify the iOS columns against
the current schemas before relying on them. The Android column is the one this repo
controls and keeps current.

Legend: ✅ have · ⬆ have, structurally stronger · ❌ gap · — not applicable on Android.

## Action coverage

| Capability | iOS `control` | XcodeBuildMCP | android-agent-mcp (2026-08-05) |
|---|---|---|---|
| Tap at coordinates | ✅ `tap` | ✅ `tap` | ✅ `mobile_click_on_screen_at_coordinates` |
| Tap by element identity | ❌ (coordinates only) | ✅ elementRef taps | ⬆ `mobile_tap_on_element` — test tag / lenient text, ACTION_CLICK on the node itself, verified change + gesture fallback, keyboard-occlusion recovery |
| Double tap | ❌ | ✅ | ⬆ `mobile_double_tap_on_screen` — agent-injected inside the platform's double-tap window (two adb taps land too far apart to register) |
| Long press | ❌ (via `touch_path` hold) | ✅ `long_press` | ✅ coords; ⬆ by element (`mobile_tap_on_element` `longPress`) |
| Swipe | ✅ `swipe` | ✅ `swipe` | ✅ directional (finger-direction) + from-coordinate |
| Arbitrary single-finger path / drag | ✅ `touch_path` | ✅ `touch`/`gesture` | ✅ `mobile_gesture` (agent MotionEvent injection, timed points, optional initial hold for drag-and-drop) |
| Two-finger pinch / rotate | ✅ `touch2_path` | ✅ `gesture` presets | ✅ `mobile_pinch` (agent two-pointer injection, open/close, scale/velocity control) |
| Type text | ✅ `text` (HID typing) | ✅ `type_text` | ⬆ `mobile_type_keys` (focused field, appends at cursor) + `mobile_set_text` (by field, replaces) — Unicode incl. Arabic/Cyrillic/UZ U+02BB via verified clipboard-paste, no keyboard needed; same semantics on both transports |
| Hardware keys | ✅ `button` (5 buttons) | ✅ `key_press` (HID codes) | ✅ `mobile_press_button` — curated set + any `KEYCODE_*` passthrough |
| Scroll to element | ❌ | ❌ (scroll_to absent on sim tools) | ⬆ `mobile_scroll_into_view` — platform ACTION_SCROLL_FORWARD until visible, reports scroll count, end-of-content detection |
| Deep links | ✅ `open_url` | ✅ `launch_app_sim` url | ✅ `mobile_open_url` (http/https guarded; env override for custom schemes) |
| App launch / terminate / install / uninstall | ✅ `launch` (installs .app) | ✅ | ✅ + launch waits for the window to actually be foreground and reports `foregroundConfirmed` |

## Observation

| Capability | iOS `control` | XcodeBuildMCP | android-agent-mcp |
|---|---|---|---|
| Screenshot | ✅ PNG | ✅ (downscale option) | ⬆ scaled + JPEG-encoded **on the device** (~263ms / ~40KB measured on the API 37 emulator); explicit `imageScale` note; legibility floor; host needs no image tooling on the agent path |
| Semantic UI tree | ❌ none | ✅ `snapshot_ui` | ⬆ `mobile_list_elements_on_screen` / `mobile_find_elements` — live in-process tree (12ms fresh / ~1ms cached on the emulator), per-node visibility surfaced as `hidden` in the compact format, `diff:true` returns only the change since the last list (smallest-wins fallback), window + foreground truth on every result, colocated-node merge, Arabic/bidi/diacritic-folded matching |
| Element handles stable across calls | — | ✅ elementRef (per snapshot) | ⬆ Compose test tags — stable across sessions, builds, locales; not per-snapshot |
| Window/dialog stack | ❌ | ❌ | ⬆ `mobile_list_windows` (app + IME windows, topmost first, owner package) |
| Screen recording | ❌ | ✅ `record_sim_video` | ✅ start/stop, background; stop SIGINTs the device-side recorder, waits for it to exit (moov atom finalized), then pulls the .mp4 — verified 700KB playable file 2026-08-28 |
| Logs (app/system) | ❌ | ✅ sim log capture | ✅ `mobile_logcat` — pid-scoped, priority/tag filters, marker-based "since", crash buffer, byte-capped |
| Crash capture | ❌ | ✅ | ✅ `mobile_list_crashes` / `mobile_get_crash` (DropBox: java crash, native crash, ANR, WTF) |
| ANR capture | ❌ | — | ✅ via DropBox `data_app_anr` entries |
| Assertions | ❌ | ❌ | ⬆ `mobile_assert` — exists/visible/textEquals/minCount/foregroundPackage with evidence; `visible` checks the node's real isVisibleToUser (agent transport), honestly reported unknown over adb |

## Determinism

| Capability | iOS `control` | XcodeBuildMCP | android-agent-mcp |
|---|---|---|---|
| Wait for UI stable | ❌ | ✅ `wait_for_ui` | ⬆ `mobile_wait_for_stable` — N identical tree samples + quiet window, transport-aware sampling floor |
| Wait for app foreground | ❌ (implicit in launch) | ❌ | ✅ built into launch; agent `waitForPackage` |
| Composite actions (one call, many steps) | ❌ | ✅ `batch` (same-screen taps) | ⬆ `mobile_run_steps` — tap/type/setText/scroll-to/assert/button/swipe/launch with settle between steps, per-step timing, stops at first failure |
| Verified actions (did the UI actually change?) | ❌ | ❌ | ⬆ agent reports `method: node|gesture` and `changed`; Compose "phantom ACTION_CLICK" is detected and retried as a real gesture |

## Environment control

| Capability | iOS `control` | XcodeBuildMCP | android-agent-mcp |
|---|---|---|---|
| Dark mode | ❌ | ✅ `set_sim_appearance` | ✅ `mobile_device_state` nightMode |
| Font scale | ❌ | ❌ | ⬆ `mobile_device_state` fontScale (Dynamic-Type gate) |
| Density / window size | ❌ | ❌ | ⬆ `mobile_device_state` density, and `size` to resize into an androidx window size class (`compact`/`medium`/`expanded`/`large`/`extraLarge`) so one device covers every adaptive band |
| Animations off (deterministic screenshots) | ❌ | ❌ | ⬆ `mobile_device_state` animations |
| Locale | ❌ | ❌ (sim boot arg only) | ⬆ per-app locale at launch and `mobile_app_state` locale without reinstall (API 33+) |
| Permission grants | ❌ | ❌ (simctl privacy exists, unexposed) | ✅ `mobile_app_state` permissions grant/revoke/list |
| Network: airplane | ❌ | ❌ | ✅ `mobile_device_state` airplaneMode (offline-contract release gate) |
| Network: wifi / mobile data toggles | ❌ | ❌ | ✅ `mobile_device_state` wifi/mobileData |
| Network shaping (bandwidth/latency) | ❌ | ❌ | ⬆ on an emulator: `mobile_emulator` shapes speed/latency at runtime via the console (no boot flags), plus battery and fold/posture simulation; still ❌ on a stock real device |
| Orientation | ❌ | ❌ | ✅ `mobile_device_state` orientation — verified rotation (`settings put`, not the `content insert` that no-ops on API 37) |
| App data reset | ❌ (reinstall only) | ✅ erase sim (nuclear) | ⬆ `mobile_app_state` clear — per-app, no reinstall |
| Device lifecycle / snapshots | ✅ attach/boot panel | ✅ boot_sim | real device: n/a (no snapshot hardware); emulator snapshot save/load is a designed follow-up when an AVD joins the rig |
| Live view panel for the user | ✅ `attach` (in-app panel) | ✅ `open_sim` | ✅ `mobile_watch` — a scrcpy mirror window on the Mac (start/stop/status); not an in-app panel (Claude Code does not expose that to third-party MCPs), but the same "human watches the automation" outcome. An emulator usually already shows its own window |

## Hot-path engineering (the mission's own bar)

| Requirement | Status |
|---|---|
| Instrumentation stays warm; no cold start per call | ✅ agent auto-start (20s first-run poll — a fresh APK pays dexopt), liveness TTL, relaunch after installs; host robots memoized per device |
| Failure reactions proportional to evidence | ✅ connection death demotes hard (force-stop releases UiAutomation); a TIMEOUT only marks the agent unavailable — force-stopping a busy agent would kill the app's process mid-session |
| Client parallelism cannot race the transports | ✅ per-device call queue in the server; different devices stay concurrent |
| No per-session device boilerplate | ✅ `device` optional on every tool; auto-resolved when exactly one device is connected |
| Compact semantic tree with stable handles | ✅ test-tag identity; token-lean list format; visibility included so the model never reasons about covered nodes |
| Screenshots fallback, downscaled/compressed | ✅ tree-first doctrine in tool descriptions; JPEG downscale with scale note + legibility floor |
| Deterministic waits, no sleeps | ✅ waitForStable / waitForPackage / scrollIntoView; launch confirms foreground |
| Composite actions | ✅ mobile_run_steps with settle + per-step evidence |
| Errors written for LLM recovery | ✅ ActionableError doctrine: what failed, device state (foreground pkg, addressable tags), exact next call |

## Known ceilings (stated, not hidden)

- **Unmerged Compose semantics** exist only in-process (Compose test APIs) — the agent reads the
  merged accessibility tree. ~95% sufficient with test tags at interaction boundaries.
- **A testTag on a non-semantic container is pruned** from the merged tree — tag interactive or
  scrollable nodes and verify on device (measured 2026-08-04).
- **Network shaping on a stock real device** is not possible; use an emulator for that matrix row.
- **`uiautomator dump` and the agent cannot run concurrently** — one UiAutomation connection per
  device. The server demotes/stops cleanly, but external `uiautomator dump` while the agent is up
  will be killed.
