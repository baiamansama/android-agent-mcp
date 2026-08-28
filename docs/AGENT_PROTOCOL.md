# Agent wire protocol

**Version 6.** For anyone extending the agent, porting it, or debugging it by hand.

The agent (`agent/driver/src/androidTest/.../DeviceAgent.kt`) serves **newline-delimited JSON** over
a TCP socket bound to `127.0.0.1:8299` on the device. One JSON object per line in, one per line
out. The host reaches it through `adb forward`.

Both halves are versioned together. Every `ping` response carries `protocol`, and the host
(`AGENT_PROTOCOL` in `src/agent.ts`) refuses a mismatch loudly — a stale APK otherwise fails much
later on a missing field, which is expensive to debug because everything *looks* connected. **If you
change any request or response shape, bump both constants in the same commit.**

## Connecting by hand

```bash
adb shell am instrument -w \
  -e class dev.androidagent.driver.agent.DeviceAgent \
  dev.androidagent.driver.test/androidx.test.runner.AndroidJUnitRunner &
adb forward tcp:8299 tcp:8299

printf '{"op":"ping"}\n' | nc 127.0.0.1 8299
```

The agent prints `ANDROID_AGENT_READY port=8299 protocol=6` on stdout when the socket is bound;
`am instrument` blocks while serving, so run it in the background.

Note the host does **not** use port 8299 in normal operation. `adb forward tcp:8299` is a global
*host* binding, so a second device would silently steal it; the host derives its own port as
`8299 + hash(deviceId) % 400`. Override with `ANDROID_AGENT_PORT` when debugging.

## Envelope

Every response carries `ok`. On failure it carries `error`, and on a selector miss it also carries
`foreground` — naming the app actually in front, since "the target app is not on screen" is the
most common cause.

```json
{"ok": true,  "elements": [...], "foreground": "com.example.app"}
{"ok": false, "error": "No node matched", "foreground": "com.android.launcher3"}
```

## Selectors

Ops that act on a node accept the same selector fields, checked in this order:

| Field | Meaning |
|---|---|
| `id` | Exact `viewIdResourceName` / Compose test tag |
| `idPrefix` | Prefix of the above — enumerates a family |
| `text` | Substring of `text` or `contentDescription`, case-insensitive |
| *(none)* | The currently focused editable node |
| `package` | Restrict to windows owned by this package |
| `includeIme` | Include IME windows. **Default false** — Gboard publishes every key as a clickable, visible node, so a text selector would otherwise resolve to the keyboard |

Resolution prefers a visible match, falling back to a hidden one. It ranks rather than filters,
because "exists but is covered" is more useful to a caller than "not found".

## Operations

| `op` | Request fields | Response |
|---|---|---|
| `ping` | — | `device`, `protocol` |
| `capabilities` | — | `protocol`, `sdkInt`, `clipboard`, `shellIdentity` |
| `dump` | `allWindows` (default true) | `elements[]`, `foreground` |
| `windows` | — | `windows[]`, `foreground` |
| `click` | selector, `gestureFallback` (default true) | `target`, `method`, `changed` |
| `longClick` | selector, `gestureFallback` | `target`, `method`, `changed` |
| `setText` | selector, `value`, `mode` (`replace`\|`append`) | `target`, `method` |
| `scrollIntoView` | selector, `maxScrolls` (default 12) | `target`, `scrolls` |
| `screenshot` | `maxWidth`, `format` (`jpeg`\|`png`), `quality` | `data` (base64), `width`, `height`, `deviceWidth`, `deviceHeight`, `format` |
| `gesture` | `points[]`, `holdMs` | `points` |
| `pinch` | `centerX`, `centerY`, `startSpread`, `endSpread`, `durationMs`, `angleDeg` | `steps` |
| `doubleTap` | `x`, `y` | — |
| `waitIdle` | `timeoutMs` | — |
| `waitStable` | `timeoutMs`, `settleSamples` (default 2) | `stable`, `fingerprint` |
| `waitForPackage` | `package`, `timeoutMs` | `foreground`, `expected` |
| `shutdown` | — | `op: "shutdown"`, then the agent exits |

### Element shape

```json
{
  "id": "com.example.app:id/search", "text": "Search", "desc": null,
  "className": "android.widget.EditText",
  "clickable": true, "enabled": true, "focused": false,
  "editable": true, "scrollable": false,
  "visible": true,
  "x": 24, "y": 210, "width": 1032, "height": 144,
  "window": 0, "package": "com.example.app"
}
```

`visible` is `AccessibilityNodeInfo.isVisibleToUser` — the signal a host-side XML dump structurally
cannot provide, and the reason this agent exists. Between API 16 and 29 the platform can report it
incorrectly while screen magnification is active, so treat it as advisory for ranking rather than a
hard filter.

`window` indexes the window stack (0 = topmost) and `package` names that window's owner, so a
caller can always tell a match in the app under test from one in a dialog, the IME, or the launcher.

A node is included if it has a resource id, text, a content description, or is clickable. The walk
is depth-first and capped at 4,000 nodes / depth 120 — generous enough that no real screen reaches
them, so a pathological tree becomes a truncated answer rather than a hang.

### `method` on actions

| Value | Meaning |
|---|---|
| `node` | `ACTION_CLICK` on the node itself, and the tree changed afterwards |
| `gesture` | The node action did not change anything, so a real `MotionEvent` was injected at its centre |
| `setText` | `ACTION_SET_TEXT`, verified to have held |
| `paste` | Clipboard + `ACTION_PASTE`, after `ACTION_SET_TEXT` was reverted |

See [ARCHITECTURE.md §4](ARCHITECTURE.md#4-verify-dont-trust) for why both fallbacks exist.

### `capabilities`

```json
{"ok": true, "protocol": 6, "sdkInt": 37, "clipboard": true, "shellIdentity": true}
```

`clipboard` is **measured, not inferred**: the agent writes a sentinel and reads it back. Android
10+ denies `setPrimaryClip` to a process that is neither focused nor the default IME, and the denial
is silent — the call returns normally and the clip is unchanged, which is indistinguishable from
success at the call site. A `false` here means the paste fallback in `setText` is unavailable on
this device.

## Concurrency

The device has exactly one `UiAutomation` and the agent's accept loop is single-threaded: it serves
one connection, one request at a time. The host serializes tool calls per device to match. While
the agent holds `UiAutomation`, an external `adb shell uiautomator dump` is killed — do not run raw
dumps alongside it.

## Extending it

1. Add the `OP_*` constant and its `handle` branch in `DeviceAgent.kt`.
2. Bump `PROTOCOL` there and `AGENT_PROTOCOL` in `src/agent.ts`.
3. Add the typed client method in `src/agent.ts`, then the tool in `src/server.ts`.
4. Add a row to the table above, and to [TOOLS.md](TOOLS.md) if it surfaces as a tool.
5. `npm run agent:install -- --rebuild` to get the new APK onto the device.

Degrade, don't fail: if the new capability has any adb equivalent, implement the fallback in
`src/automation.ts` so the server stays usable without the agent.
