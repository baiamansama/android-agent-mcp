# Architecture

Two cooperating halves, and a set of decisions that are only obvious in hindsight. This document
is the reasoning; [TOOLS.md](TOOLS.md) is the surface and [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) is
the wire.

```
   MCP client (an LLM agent)
        │  stdio JSON-RPC
        ▼
   ┌─────────────────────────────────────────────┐
   │ host server  (TypeScript, src/)             │
   │  · 31 tools                                 │
   │  · device resolution + per-device locking   │
   │  · picks a transport per call               │
   └───────────┬─────────────────────┬───────────┘
               │ agent transport     │ adb transport (fallback)
               │ TCP over            │ exec adb: uiautomator dump,
               │ `adb forward`       │ input tap, screencap, …
               ▼                     ▼
   ┌─────────────────────────┐   ┌──────────────┐
   │ DeviceAgent             │   │ adb / shell  │
   │ (instrumentation,       │   └──────────────┘
   │  agent/ in this repo)   │
   │  · UiAutomation         │──── sees and drives EVERY app on the device
   │  · loopback socket 8299 │
   └─────────────────────────┘
```

---

## 1. Why an on-device agent at all

The host-side alternative is `adb shell uiautomator dump`: a flattened XML snapshot pulled off the
device. It is slow, and it structurally throws away two things that matter more than speed.

**It cannot tell you what is visible.** The dump reports every node's bounds in screen coordinates
whether or not something covers it. An element behind the soft keyboard looks perfectly tappable,
so the tap lands on a key instead — and nothing in the payload reveals that. `isVisibleToUser` is
the real signal and it exists only in-process. It is this agent's equivalent of XCTest's
`isHittable`.

**It cannot act on a node.** Everything becomes a coordinate, so occlusion, scroll offsets and
relayout between the read and the tap all become your problem. Dispatching `ACTION_CLICK` to the
node itself removes the whole class.

Two more things fall out once you are in-process: `ACTION_SET_TEXT` writes Unicode directly (host
`adb shell input text` maps characters onto key events and throws outside ASCII, which makes
Arabic, Cyrillic and Uzbek `ʻ` untypeable), and screenshots can be scaled and JPEG-encoded before
they touch the wire, which turns a multi-megabyte base64 string into ~20–40KB and deletes the
host's dependency on `sips`/ImageMagick.

---

## 2. Why the driver is a separate app

This is the decision the whole project turns on.

Every Android instrumentation declares a `targetPackage` in its manifest, and `am instrument`
**restarts that package's process** before running.

The obvious design puts the agent in your app's `androidTest` source set, so `targetPackage` is
your app. Then:

- Starting the agent kills and restarts the app under test. Whatever screen the caller was working
  on is gone.
- So the host may only auto-start the agent at moments where that is survivable — essentially, at
  an app launch it performed itself.
- The agent also dies on every `adb install -r` of either APK, which during development is constant.
- Net effect: the agent spends most of its life dead, callers silently run the slow path, and
  nobody notices because nothing errors.

The standalone driver targets **its own empty stub app** instead. `am instrument` restarts that
stub — a package with no components, nothing exported, nothing launchable, and no state. Restarting
it is a no-op that nobody can observe.

The reason this works at all is that **`UiAutomation` is device-wide**. It is granted to the
instrumentation process, not scoped to the target package, so the agent reads the accessibility
tree of every window on the device and injects input anywhere. Nothing reads the app under test's
memory or classloader.

Verified on API 37: with Settings in the foreground, the driver read 152 elements from
`com.android.settings`, tapped its search bar, followed the navigation into a *third* app
(`com.google.android.settings.intelligence`), and wrote `مرحبا oʻzbek` into its field — all
while the driver's own `targetPackage` was its stub.

So: the agent can be started at any time, whatever is on screen, against any app — including one
you did not write and cannot rebuild.

### The one thing that changes

Running outside the target app's process costs one thing: **the clipboard is no longer the app's**.

Android 10+ denies `setPrimaryClip` to a process that is neither focused nor the default IME, and
the denial is **silent** — the call returns normally and the clip is unchanged. This matters
because clipboard-paste is the fallback for text entry (see §4).

The agent handles it in three parts:

1. It escalates via `UiAutomation.adoptShellPermissionIdentity()` around the clipboard write, which
   lends the instrumentation the shell UID's permission set. On API 37 this is sufficient — measured.
2. It never assumes. `clipboardWritable()` writes a sentinel and reads it back, because a silent
   denial is indistinguishable from success at the call site.
3. `mobile_agent_status` reports the answer, so a device that refuses says so instead of producing
   a mysterious text-entry failure.

### Embedded mode

The in-your-app arrangement is still supported and is occasionally the right call — the agent runs
inside your process, so it shares your app's clipboard and classloader with no escalation.

Copy `agent/driver/src/androidTest/java/dev/androidagent/driver/agent/DeviceAgent.kt` into your own
`androidTest` source set, add `androidx.test.uiautomator` and `androidx.test:runner`, then point the
server at it:

```bash
ANDROID_AGENT_TEST_PACKAGE=com.example.app.test
```

`src/config.ts` infers `mode: "embedded"` from that and re-enables the restart guard: the host will
decline to auto-start the agent while your app is running, and re-arm on the next launch it
performs itself. The inference is deliberately one-directional — treating an embedded agent as
standalone would let the host restart a live app, while the reverse merely makes it more cautious
than necessary — so anything that is not recognisably the bundled driver is assumed embedded.

---

## 3. Transport selection and lifecycle

The host holds an `AgentClient` per device and picks a transport per call. Every agent-backed
operation degrades to adb rather than failing, so the server is never *worse* than an adb-only one.

**Warm everything.** Robots are memoized per device for the server's life. The agent is probed on a
15-second liveness TTL rather than once at startup — a long-lived MCP server outlives many installs,
so "probe once" is wrong in exactly the situation that matters. The probe costs ~20ms when absent.

**Protocol numbers, not hope.** Every `ping` carries the agent's protocol version and the host
refuses a mismatch loudly. The agent's APK and the host are versioned together, and a stale APK
otherwise fails much later on a missing field — which is expensive to debug because everything
*looks* connected.

**Teardown is asymmetric, on purpose.** A request *timeout* only marks the agent unavailable; a
*dead connection* demotes hard and releases `UiAutomation`. The asymmetry exists because
force-stopping the instrumentation kills its process — in embedded mode, that is the app under
test. A merely busy agent must never be force-stopped.

**Per-device serialization.** The device has exactly one `UiAutomation`, and both transports are
single-threaded. The server serializes tool calls per device so a client's parallel calls cannot
race them — measured as two concurrent calls completing cleanly rather than thrashing.

**Per-device host ports.** `adb forward tcp:8299` is a *global host* binding, so a second device
silently steals it and every request afterwards reaches the wrong device. The host port is derived
from a hash of the device id (`8299 + hash % 400`), which makes the collision impossible rather
than merely unlikely. This was a real failure: an emulator booting beside a phone took the forward,
the phone's agent became unreachable, and the session degraded to adb reporting nothing unusual.

**Launch is `am start -W`,** not `monkey`. Upstream's `monkey` launch held the device's single
`UiAutomation` for ~2s around *every* launch.

---

## 4. Verify, don't trust

Platform behaviours that make optimistic automation quietly wrong, each measured rather than assumed.

**The accessibility cache goes stale.** A UiAutomation connection caches every node it fetches and
drops an entry only when the app reports a change — and Compose does not report every change to a
UiAutomation client. On API 37 emulators (2026-09-30), after BACK closed a bottom sheet the tree
kept the sheet `visible`, at its old bounds, for minutes and through a scroll that visibly moved
every row; only a window change (HOME and back) refreshed it. Everything downstream inherited the
lie: `waitStable` hashed a frozen tree and answered "stable" in 250ms, and a click whose effect had
landed (the pixels showed the new tab) looked like a no-op, so the gesture fallback below fired a
**second, physical tap** — harmless on a tab, a double action on a toggle. Since protocol 7 every
read clears the cache first. It costs a re-fetch — a Pixel 10 emulator dump went from ~11ms
(cached, wrong) to ~70ms (fresh) — and removes the whole class.

**Compose publishes `ACTION_CLICK` it does not honour — or appeared to.** On Android 16 / Compose UI 1.12.0-beta01,
every Compose clickable in the app under test accepted `ACTION_CLICK` and returned `true` while the
handler's effect never landed — dock, icon buttons, M3 buttons, plain cards alike. Invoking the
node's Compose `OnClick` semantics lambda directly, in-process on the main thread, behaved
identically, which places the loss below the accessibility layer rather than inside it. Only real
`MotionEvent`s worked.

With fresh reads the picture changed: on the API 37 emulator every dock `ACTION_CLICK` was confirmed
by the tree as a node click (6/6, no gesture fallback), where the cached tree had sent every one to
the fallback. The Android 16 measurement above predates the cache fix and has not been repeated on
that hardware, so the fallback stays — and the host now reports `method` and `changed` on every
tap, so a no-op is visible instead of being narrated as success.

So a click is followed by a structural re-read, and if the tree is untouched the node's centre is
tapped as a real gesture instead. The response reports `method: "node" | "gesture"` so a caller is
never guessing. Polling for the change rather than sleeping a fixed budget matters twice: a click
that works is confirmed as soon as the frame lands, and a click that does nothing reaches its
fallback sooner.

**Compose accepts `ACTION_SET_TEXT` and then reverts it.** On a controlled Compose field the node's
reported text reflects the write for long enough to pass any immediate verification, then reverts,
because the app's own state never changed and no `onValueChange` fired. Measured: `performed=true`,
verification at +150ms clean, placeholder back moments later, the search never ran.

Text entry therefore tries two mechanisms in order and reports which carried:

1. **`ACTION_SET_TEXT`** — documented, correct for View-based fields and most Compose fields, needs
   no clipboard, unaffected by which process the agent runs in.
2. **Clipboard + `ACTION_PASTE`** — the way a person's text arrives. Paste runs through the field's
   real editing pipeline, updating app state and firing the same listeners typing does, so it
   survives the controlled-Compose case.

Both are verified at two delays, because the failure mode is a value that reverts *after* the
obvious check. `mode: "append"` keeps existing contents (type-into-a-field semantics, matching what
`adb shell input text` does at the cursor); the default replaces (set-a-field semantics). The host
maps `mobile_type_keys` onto append and `mobile_set_text` onto replace so both transports agree.

---

## 5. Selection

`find` resolves a selector to a single node with three rules that are each a bug that happened once.

**Visibility ranks, it does not filter.** A caller may legitimately want to know that a thing
exists but is currently covered — more useful than "not found". But when both a visible and a
hidden match exist, which is routine with a lazy list that keeps offscreen items attached, acting
on the hidden one is always wrong. So: prefer visible, fall back to any.

**IME windows are excluded unless asked for.** Gboard publishes every key as a labelled, clickable,
*visible* node. A text selector like `"a"` with the keyboard open would otherwise resolve to the
key — and visible-first ranking would actively prefer it over the app's own occluded content.
Acting on the keyboard is never what a selector means.

**Text is folded before comparison.** `foldForMatch` normalises bidi isolates, Arabic tashkeel,
hamza/alef forms, alef maqsura, Uzbek apostrophe variants, case and whitespace. Apps wrap
mixed-direction content in isolates, so an Arabic word arrives from the tree with invisible
characters around it that no author ever typed. Folding is for matching only and is never shown to
a user.

An unmatched selector fails with the addressable tags actually on screen, which turns "no node
matched" into something the caller can act on.

---

## 6. Token economy

An LLM agent pays for every character it reads, so the tree format is a first-class design
concern, not presentation.

The compact line format
(`#tag "text" (label) @x,y wxh clickable scrollable hidden`) costs roughly a third of the
equivalent JSON, mostly by dropping a `coordinates` object per element — on a real screen that
alone is about two thirds of the payload. `filter: "interactive"` narrows to what can be acted on.
`diff: true` returns only the lines added and removed since the last read, falling back to the full
tree when the diff would be larger.

Since 0.3.0 the lines are shaped for a reader rather than mirrored from the tree: framework wrappers
are dropped, same-rectangle nodes fuse, a clickable container absorbs the words inside it (so an
icon button reads `"Save to a collection" … clickable` instead of an anonymous box plus a stray
label), bidi isolates are stripped, and an open soft keyboard — a hundred-odd key nodes — becomes one
line. On the Pixel 10 emulator's dictionary screen with the keyboard up that is 183 raw nodes in 21
lines, ~520 tokens where the previous format spent ~2,900. Presentation only: selectors still
resolve against the raw tree.

The same economy applies to the tool catalog and to failures. 0.3.0 folds seven tools into
parameters of surviving ones (31 tools, ~8.7k schema tokens, from 38 and ~9.8k), sends a short MCP
`instructions` block naming the tools to reach for first, returns a passing assertion as one line,
and collapses generated tag families in error messages to the `idPrefix` a caller should use.

Screenshots are the fallback, not the default: the element list answers "what is on screen" faster
and cheaper, and its `#tags` feed the element tools directly. Reach for pixels only when layout,
imagery, or rendering itself is the question.

`mobile_run_steps` exists for the same reason — a 9-step journey as one call is ~123 tokens and one
round trip, against a step-per-call shape that costs an order of magnitude more of both.

Performance evidence follows the same rule. One `mobile_performance` tool multiplexes collector
discovery, capture lifecycle, frame stats, memory and heap dumps. Large text is returned in a
bounded preview and can be written in full to an artifact, avoiding both tool-catalog expansion and
accidental context floods. Small JSON results also use MCP structured content; large diagnostics
are not duplicated into both result forms.

---

## 7. Known limits

- **The merged accessibility tree is the ceiling.** A `testTag` on a bare layout container may be
  pruned before it reaches the tree. Tag interactive and scrollable nodes, and verify against a
  real dump rather than assuming a tag survived.
- **A selected navigation tab reports `clickable=false`** (`Role.Tab` + selected). Selection never
  filters on clickability, for this reason.
- **One `UiAutomation` per device.** While the agent runs, an external `uiautomator dump` is
  killed. The server sequences its own transports; do not run raw dumps alongside it.
- **Network shaping needs an emulator.** `-netdelay`/`-netspeed` go through the emulator console; a
  stock physical device cannot do it.
- **Without the agent**, you lose visibility truth, gestures/pinch, precise double-tap, and
  non-ASCII text entry. Everything else still works. `mobile_agent_status` says which world you are
  in.
- **stdio only.** Upstream's Express/SSE listener and its `express`/`qs`/`commander`/`ajv`
  dependencies were removed: a local tool driving real developer devices should not carry a network
  listener with no caller.
- **Focused traces are not benchmarks.** Perfetto and Simpleperf explain one journey. Stable
  regression claims belong in AndroidX Macrobenchmark on physical hardware and a release-like,
  profileable build.
- **Diagnostic output is summarized by default.** `gfxinfo` raw frame timestamps are written only
  when the caller requests an output artifact; counter reset returns an acknowledgement. Verbose
  server traces go to `LOG_FILE`, or to stderr only with `ANDROID_AGENT_MCP_DEBUG=1`, so stdio
  clients do not pay for a second copy of every result.
