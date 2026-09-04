# Changelog

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
