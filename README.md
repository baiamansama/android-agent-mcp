# android-agent-mcp

[![CI](https://github.com/baiamansama/android-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/baiamansama/android-agent-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

An MCP server that lets an LLM agent drive a real Android device or emulator — and does it by
reading the **live accessibility tree in-process** rather than shelling out to `uiautomator dump`.

That one difference changes what the tool can do:

| | `adb` / `uiautomator dump` | this server, with its on-device agent |
|---|---|---|
| Read the screen | 0.6–2.3s per read | **12–56ms** ([measured](docs/BENCHMARKS.md)) |
| "Is this element actually visible?" | not available — bounds are reported whether or not something covers them | real `isVisibleToUser` per node |
| Tap a thing | compute a coordinate and hope | dispatch to the **node**, then verify the screen changed |
| Type `مرحبا` or `oʻzbek` | impossible — `input text` is ASCII-only | works, no keyboard installed |
| Two fingers, or a drag that starts with a hold | inexpressible | real `MotionEvent` streams |

It works against **any app on the device**, including ones you did not write and cannot rebuild.
You do not modify your app, and nothing here ships inside your APK.

Without the agent everything still works over plain adb, minus those five rows —
`mobile_agent_status` always tells you which world you are in.

---

## Setup

Needs Node 20+, the Android SDK (`adb` on `PATH` or `ANDROID_HOME` set), and — for the agent — a
JDK 17+.

```bash
git clone https://github.com/baiamansama/android-agent-mcp.git
cd android-agent-mcp
npm install && npm run build
npm run agent:install     # builds and installs the on-device driver
```

Then register it with your MCP client. For Claude Code, in `.mcp.json`:

```json
{
  "mcpServers": {
    "android": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/android-agent-mcp/lib/index.js"]
    }
  }
}
```

That is the whole setup. The server finds the device when exactly one is connected, starts the
agent on demand, and falls back to adb whenever the agent is unavailable.

**Skipping `agent:install` is fine** — the server runs on adb alone. Add the driver when you want
the speed and the four capabilities adb cannot provide.

---

## What the agent is, and why it is a separate app

The agent is an Android **instrumentation**: a test process with access to `UiAutomation`, the same
API the platform's own test tooling uses. It serves newline-delimited JSON over a loopback socket
that the host reaches through `adb forward`.

Every instrumentation declares a `targetPackage`, and `am instrument` **restarts that package's
process** before running. Which package that is turns out to be the most consequential decision in
the whole design:

- The obvious choice is to put the agent in *your app's* `androidTest` source set. Then starting
  the agent restarts your app — so it can only be started at moments where losing the current
  screen is acceptable. In practice that means it is usually not running, and callers silently get
  the slow path.
- This project instead ships a **standalone driver** whose instrumentation targets its own empty
  stub app. Starting it restarts nothing that matters. `UiAutomation` is device-wide, so the agent
  still sees and drives every app on the device.

So the agent can be started at any time, against any app, with the screen left exactly as it was.
That is what makes this usable on apps you do not own.

Both arrangements are supported — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#embedded-mode).

---

## The 37 tools

Full reference with every parameter: **[docs/TOOLS.md](docs/TOOLS.md)**.

**Reading the screen**
`mobile_list_elements_on_screen` · `mobile_find_elements` · `mobile_list_windows` ·
`mobile_take_screenshot` · `mobile_save_screenshot` · `mobile_get_screen_size`

**Acting by identity** (test tag, id prefix, or folded text — never a coordinate)
`mobile_tap_on_element` · `mobile_set_text` · `mobile_scroll_into_view` · `mobile_type_keys`

**Acting by coordinate**
`mobile_click_on_screen_at_coordinates` · `mobile_double_tap_on_screen` ·
`mobile_long_press_on_screen_at_coordinates` · `mobile_swipe_on_screen` · `mobile_gesture` ·
`mobile_pinch` · `mobile_press_button` · `mobile_open_url`

**Waiting and asserting** (assertions poll until true or deadline — an assert *is* a wait)
`mobile_wait_for_stable` · `mobile_assert` · `mobile_run_steps`

**Apps and devices**
`mobile_list_available_devices` · `mobile_list_apps` · `mobile_launch_app` ·
`mobile_terminate_app` · `mobile_install_app` · `mobile_uninstall_app` · `mobile_app_state`

**Environment**
`mobile_device_state` (font scale, dark mode, animations, density, window size class, airplane
mode, wifi, data, orientation) · `mobile_emulator` (bandwidth/latency shaping, battery,
fold/posture)

**Diagnostics**
`mobile_logcat` · `mobile_list_crashes` · `mobile_get_crash` · `mobile_start_screen_recording` ·
`mobile_stop_screen_recording` · `mobile_watch` (live scrcpy mirror) · `mobile_agent_status`

### One call per journey

`mobile_run_steps` runs a whole flow — launch, taps, Unicode text, scroll-to, buttons, swipes,
asserts — with settling between steps, per-step timings, and a stop at the first failure:

```json
{ "steps": [
    { "action": "launch",   "packageName": "com.example.app" },
    { "action": "tap",      "text": "Search" },
    { "action": "setText",  "id": "com.example.app:id/query", "value": "مرحبا" },
    { "action": "assert",   "text": "3 results", "timeoutMs": 5000 }
] }
```

A 9-step journey measured at **~123 tokens, 12/12 runs with zero flakes**
([docs/BENCHMARKS.md](docs/BENCHMARKS.md)).

---

## Design doctrine

The details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the short version is five rules.

- **Tree first, pixels second.** `mobile_list_elements_on_screen` returns a compact line format
  (`#tag "text" (label) @x,y wxh clickable scrollable hidden`) at roughly a third the tokens of
  JSON, with `filter: "interactive"` for less and `diff: true` for only what changed since the last
  read. Screenshots are downscaled and JPEG-encoded **on the device**, so the wire carries tens of
  kilobytes and the host needs no image tooling.

- **Identity over coordinates.** Tap by test tag, tag prefix, or text folded across bidi isolates,
  Arabic diacritics, hamza/alef forms and Uzbek apostrophe variants. A text selector never resolves
  to the soft keyboard's own keys.

- **Verify, don't trust.** Compose publishes `ACTION_CLICK` it does not honour, and accepts
  `ACTION_SET_TEXT` it later reverts — both measured, both real. Clicks are confirmed by a
  structural fingerprint change, with a real-gesture fallback; text writes are verified at two
  delays because the failure mode is a value that reverts *after* the obvious check.

- **Waits, not sleeps.** Launch confirms the window is actually foreground. `scroll_into_view` uses
  the platform's own scroll actions and stops when the container says it cannot scroll further.
  Assertions poll until true or deadline, which is what absorbs debounces and transitions.

- **Errors an agent can act on.** A missed selector fails with the tags actually on screen. An
  agent-only tool names the exact command to start the agent. `mobile_agent_status` reports what is
  configured *and* what is installed, so the commonest setup mistake explains itself.

---

## Docs

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the two halves fit, and why each decision went the way it did |
| [TOOLS.md](docs/TOOLS.md) | Every tool, every parameter |
| [AGENT_PROTOCOL.md](docs/AGENT_PROTOCOL.md) | The wire protocol, for porting or extending the agent |
| [BENCHMARKS.md](docs/BENCHMARKS.md) | Measured numbers, with the rig and method stated |
| [COVERAGE.md](docs/COVERAGE.md) | Capability matrix against the iOS simulator tooling |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Every failure mode worth knowing, and what it means |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, tests, and what a good change looks like |

## Security

The agent binds **loopback only** and is reachable solely through an `adb forward`. It is
developer tooling: it is never part of a shipped APK, and the driver app has no components,
nothing exported, and nothing launchable.

An MCP client driving this server can do anything a person holding the unlocked device can do.
Use a device meant for that. See [SECURITY.md](SECURITY.md).

## License and attribution

Apache-2.0.

Forked from [`@mobilenext/mobile-mcp`](https://github.com/mobile-next/mobile-mcp) at tag **0.0.62**
(the last release before upstream moved its device backend to `mobilecli`, which is distributed
under the Functional Source License rather than an open-source license — this fork deliberately
does not use it). The iOS surface, the mobilecli backend, the SSE/Express listener, and upstream's
default-on analytics were removed; the on-device agent, the identity-based tool surface, and the
verification model are new. See [NOTICE](NOTICE) for the full attribution.
