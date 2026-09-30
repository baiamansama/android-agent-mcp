# Changelog

## 0.3.0 — 2026-09-30

Measured on Pixel 10 and Pixel Tablet emulators (API 37.1); numbers in
[docs/BENCHMARKS.md](docs/BENCHMARKS.md).

### Correctness

- **Fresh reads (agent protocol 7).** The agent clears the accessibility node cache before every
  read. Compose does not report every change to a UiAutomation client, and the cached tree kept a
  closed bottom sheet `visible` for minutes, made `waitStable` report a frozen screen as stable,
  and turned working `ACTION_CLICK`s into apparent no-ops that triggered a second, physical tap.
- **Honest taps.** `mobile_tap_on_element` and `mobile_run_steps` report how a tap landed
  (`screen changed`, a real-tap follow-up, or **the screen did not change**) and how many elements
  matched. Previously every agent tap read "directly (agent, no coordinates)".
- **Failures are `isError`.** Missed selectors, failed assertions and journeys that stop early are
  flagged as errors instead of arriving as ordinary text.
- **`index` on every selector** — pick the Nth match. Host and agent now rank matches the same way
  (visible first, then tree order), so a numbered listing, the adb path and the agent agree.
- adb path: numeric XML entities are decoded (`&#128578;` → 🙂).

### Tokens

- Compact lines are shaped for a reader: framework wrappers dropped, same-rectangle nodes fused,
  clickable containers carry the words inside them, bidi isolates stripped, and an open soft
  keyboard collapses to one line. Dictionary screen with the keyboard up: ~2,900 → ~520 tokens.
- New state flags: `disabled`, `selected`, `checked` / `unchecked` (agent and adb).
- A passing `mobile_assert` is one line; missed-selector errors collapse generated tag families to
  `prefix.* (n)`.
- The server sends MCP `instructions`: which tools to reach for first and what results mean.
- `mobile_run_steps` `snapshot: "interactive"` returns only actionable lines.

### Tools: 38 → 31 (breaking)

| Removed | Use instead |
|---|---|
| `mobile_find_elements` | `mobile_list_elements_on_screen` with `id` / `idPrefix` / `text` (numbered for `index`) |
| `mobile_get_screen_size` | `mobile_device_state` (reports pixels, dp and size classes) |
| `mobile_save_screenshot` | `mobile_take_screenshot` with `saveTo` |
| `mobile_double_tap_on_screen`, `mobile_long_press_on_screen_at_coordinates` | `mobile_click_on_screen_at_coordinates` with `count: 2` or `longPress` |
| `mobile_start_screen_recording`, `mobile_stop_screen_recording` | `mobile_screen_recording` with `action` |
| `mobile_list_crashes`, `mobile_get_crash` | `mobile_crashes` (no `id` lists, `id` fetches) |

### Setup

- **Automatic driver install** (standalone mode): when the driver is missing or speaks another
  protocol, the server installs it from `ANDROID_AGENT_DRIVER_DIR`, a packaged `driver/` directory
  (`npm run agent:bundle`), or this repo's Gradle output. `ANDROID_AGENT_AUTO_INSTALL=0` turns it
  off; `mobile_agent_status` reports what happened.
- `@modelcontextprotocol/server` 2.0.0 → 2.2.0.
- `npm test` never touches an attached device; device tests need `ANDROID_AGENT_DEVICE_TESTS=1`.
- The CI workflow was removed; run the checks locally.

## Unreleased

First public release, forked from [mobile-mcp](https://github.com/mobile-next/mobile-mcp) 0.0.62.
See [NOTICE](NOTICE) for the full list of modifications.

### The on-device agent

- **Standalone driver** (`agent/`): the agent now ships in its own app whose instrumentation
  targets an empty stub, so starting it never restarts the app under test. It drives any app on the
  device via `UiAutomation`, including apps you did not write.
- Wire protocol **6**: newline-delimited JSON over a loopback socket, versioned against the host and
  refused on mismatch. See [docs/AGENT_PROTOCOL.md](docs/AGENT_PROTOCOL.md).
- `capabilities` op reports measured device facts — notably whether this device permits a clipboard
  write from an unfocused process, which decides whether the text-entry fallback is available.
- Text entry tries `ACTION_SET_TEXT` first and escalates to clipboard-paste only when the tree shows
  the write was reverted.
- One-command install: `npm run agent:install`.

### Window size classes

- `mobile_get_screen_size` and `mobile_device_state` report the window in dp with its
  `androidx.window.core.layout.WindowSizeClass` band — `compact` / `medium` / `expanded` / `large` /
  `extraLarge` for width, `compact` / `medium` / `expanded` for height — alongside pixels and
  `smallestWidthDp`. Pixels alone cannot separate a 1280dp tablet from a 900dp one, and adaptive
  layouts branch on neither.
- `mobile_device_state` gains `size`: resize the window into a named band, an explicit `WxH` in dp,
  or `reset`. A named band moves width and holds height, so the width class is the only variable
  that changed. The rotation is pinned across the write (`wm size` redefines the display's natural
  frame, which silently reverses what an existing `user_rotation` means) and the result is read back
  from the window manager, so the call fails rather than reporting a band it did not reach.

### Host

- `mobile_assert` and nested run-step assertions can verify only the foreground package, without
  inventing an element selector or paying for an unnecessary UI-tree lookup.
- `frame_stats` omits raw profile rows from inline results and reset calls return only their
  acknowledgement; full raw data remains available through an explicit output file.
- Routine tool traces stay out of stderr unless `ANDROID_AGENT_MCP_DEBUG=1`, avoiding duplicate
  model-context traffic while preserving errors and optional file logging.
- Launch and screen-changing operations invalidate cached foreground metadata; a confirmed agent
  launch now reports the launched package instead of a stale launcher window.
- Agent identity is configuration, not a constant (`src/config.ts`): `ANDROID_AGENT_TEST_PACKAGE`,
  `ANDROID_AGENT_TARGET_PACKAGE`, `ANDROID_AGENT_CLASS`, `ANDROID_AGENT_MODE`.
- The `am instrument` restart guard now applies only in embedded mode, where it is real.
- `mobile_agent_status` reports the configured identity, the mode, and — when the agent is absent —
  the instrumentations actually installed, so a mismatch explains itself.
- 38 tools, stdio only. Upstream's Express/SSE listener and its dependency tree were removed.
- Added one consolidated `mobile_performance` surface for Perfetto and Simpleperf capture, gfxinfo
  frame stats, meminfo snapshots and HPROF artifacts. Inline diagnostics are bounded while full
  evidence can be saved locally.
- Migrated the host to the stable MCP TypeScript SDK 2.0 packages and MCP 2026-era server factory,
  while retaining legacy-client handshake compatibility. Tools publish safety annotations and
  small JSON results as structured content without duplicating large diagnostics.
- Updated production dependencies to `@modelcontextprotocol/server` 2.0.0,
  `fast-xml-parser` 5.11.1 and Zod 4.5.4; production and full npm audits are clean.
- No telemetry.

### Removed from upstream

- The iOS surface, the `mobilecli` backend (FSL-licensed), and default-on PostHog analytics.
