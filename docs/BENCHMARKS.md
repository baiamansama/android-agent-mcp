# Measured performance

Every number here was measured, on stated hardware, by a bench client speaking **real MCP stdio
JSON-RPC** to the built server (`initialize` → `tools/call`) — so each figure includes the full wire
path an agent actually pays. Tokens ≈ result characters / 4. Each primitive: one unmeasured warmup,
then N measured runs.

Where a number came from driving a private production app, that is said plainly. Nothing here is
extrapolated.

---

## 2026-09-30 — 0.3.0, fresh reads, Pixel 10 and Pixel Tablet emulators (API 37.1, arm64, macOS host)

Same bench method. The app under test was a production Compose app (debug build) — the dictionary
and shell screens of a language-learning app, including Arabic entry.

**Why the numbers moved.** Before 0.3.0 the agent read from the accessibility node cache, which
Compose does not always invalidate for a UiAutomation client. Measured on both emulators: after BACK
closed a bottom sheet, the tree kept it `visible` at its old bounds for minutes; a tab switch whose
pixels had changed still read as unchanged. Cached reads were fast because they were wrong.

| Operation (Pixel 10) | 0.2.x (cached) | 0.3.0 (fresh) | note |
|---|---|---|---|
| Semantic tree dump, settled | 11ms | **~70ms** | 65–77ms over 8 reads; adb `uiautomator dump` is 2.3s on this AVD |
| `waitStable`, settled | 250ms (on a frozen tree) | **~430ms** | three fresh fingerprint samples |
| Dock tab `ACTION_CLICK` confirmed as `node` | 0 / 6 (all fell to a second, gesture tap) | **6 / 6** | pixels confirmed every tab switch in both builds |
| Tap by element, warm | 1.0–2.0s (gesture path) | 0.2–2.0s | node path; the upper end is this debug build's tab composition |
| Bottom sheet after BACK | still reported `visible` | gone | asserted `exists:false` in 159ms |

| Token cost | before | 0.3.0 | note |
|---|---|---|---|
| Dictionary screen, keyboard open | ~2,900 tok (143 lines) | **~520 tok (21 lines)** | same screen and state; 183 raw nodes, keyboard is one line |
| Dictionary screen, drawer open (tablet) | 4,251 chars (92 lines) | 2,832 chars (45 lines) | offline prototype of the same rules on a captured tree |
| Missed-selector error | ~190 tok | ~70 tok | tag families collapsed |
| Passing assertion | ~125 tok | ~16 tok | one line; failures keep full evidence and `isError` |
| Tool catalog (`tools/list`) | 38 tools, ~9.8k tok | 31 tools, ~8.7k tok | plus ~240 tok of MCP `instructions` |

**Auto-install.** With the driver uninstalled, the first `mobile_launch_app` installed both APKs
from this repo's build output and brought the agent up: 2.6s end to end, reported by
`mobile_agent_status` as `driverInstall`.

**The adb fallback, for scale.** Without the agent, `wait_for_stable` on a settled screen took 10.4s
on the Pixel 10 AVD and 6.5s on the tablet (each sample is a ~2.1–2.3s `uiautomator dump`), and a
screenshot 0.7s.

---

## 2026-08-29 — the standalone driver, Pixel 10 emulator (API 37, arm64, macOS host)

The current architecture: the agent runs in its own driver app and drives a **third-party** app it
did not ship with. Target was `com.android.settings` at 152 elements.

| Operation | measured | note |
|---|---|---|
| Semantic tree, fresh | **56ms** p50 (30–169) | vs 611ms p50 for `adb exec-out uiautomator dump` on the same screen — **~11×** |
| Screenshot (on-device scale + JPEG) | **126ms / 20KB** | 480×1077 from a 1080×2424 device; no host image tooling involved |
| `waitStable` on a settled screen | 269ms | fingerprint sampling, 2 identical samples required |
| `gesture` (3-point swipe) | 181ms | injected `MotionEvent` stream |
| `pinch` (400ms, 33 steps) | 1786ms | injection is synchronous, so wall time exceeds the requested duration |
| Cold server → agent auto-started → first tree | **345ms** | agent not running and no forward established beforehand |

**Cross-app capability, verified the same session.** With Settings in front, the driver read 152
elements from `com.android.settings`, tapped its search bar (`method: "gesture"`), followed the
navigation into `com.google.android.settings.intelligence`, and wrote `مرحبا oʻzbek` into that
app's field — matching exactly, via `ACTION_SET_TEXT`. `capabilities` reported
`clipboard: true`, i.e. `adoptShellPermissionIdentity()` is sufficient on API 37 for the paste
fallback.

Driver APKs: **852KB** app + **968KB** instrumentation.

---

## 2026-08-05 — the embedded agent, Galaxy S23 (SM-S911N, Android 16 / One UI, USB)

The original measurements, with the agent compiled into the app under test — a shipped
Arabic-learning app, 1.1.33 (56), debuggable. These are the strongest numbers recorded, because an
in-process agent on a fast phone is the best case.

### Primitives — agent transport vs adb transport

Same code path both times; the adb column is the same server with `ANDROID_AGENT_DISABLE=1`.

| Operation | agent p50 | agent p95 | adb p50 | adb p95 | speedup |
|---|---|---|---|---|---|
| Semantic tree, fresh (after a real screen change) | **14ms** | 16ms | 2304ms | 2335ms | **165×** |
| Semantic tree, cached (screen unchanged) | 0ms | 1ms | — cache also applies | | |
| Tap by element (incl. verified-change check) | **881ms** | 929ms | 2378ms | 2391ms | 2.7× |
| Wait-for-stable (settled screen) | **269ms** | 274ms | 6568ms | 6631ms | 24× |
| Screenshot (downscaled JPEG) | 334ms / 23KB | 335ms | 694ms / 18KB | 695ms | 2.1× |
| Assert element exists | 17ms | 23ms | ~1 dump (≈2.3s) | | ~135× |
| Window stack | 6ms | 8ms | n/a over adb | | — |
| Logcat, pid-scoped, 100 lines | 350ms | 361ms | same path | | 1× |

Server init (spawn → `initialize` handshake): **161ms**. First-call warmups are in the same range
as steady state — robots are memoized, and the agent is probed once and trusted for a 15s TTL.

**The 2304ms dump cost is device-specific.** The same `adb exec-out uiautomator dump` is ~40–60ms
on the API 37 emulator and ~611ms on the Pixel 10 emulator above, so the adb fallback is far less
punishing on some hardware than others. The agent's advantage is real everywhere; its *size* is not
portable.

### Tokens per screen read (same screen, 121 elements)

| Format | tokens | note |
|---|---|---|
| compact (default) | **~403** | one line per element |
| `filter: "interactive"` | ~261 | actionable subset |
| `verbose: true` JSON | ~1123 | legacy shape, 2.8× compact |

### A real 9-step journey

Cold relaunch → shell-ready assert → open a search root → switch search language to Arabic → write
`كتاب` (Unicode) → assert results → tap the first result → assert the detail screen → BACK.

| Strategy | wall p50 | tokens/run | MCP round trips | success |
|---|---|---|---|---|
| `mobile_run_steps` (one call) | 9.5s | **~123** | **1** | **12/12 — zero flake** |
| step-by-step with state reads | 8.6s | ~2855 | 13 | 3/3 |
| adb transport (ASCII "book" only) | 38.3s | — | 1 | 1/1 |

Wall time is comparable because the composite settles between every step. What an agent actually
feels is **13 round trips vs 1** — each round trip adds model and API seconds the bench does not
charge — and **23× the tokens**. The adb row is a capability line, not a latency line: Arabic input
is impossible over that transport at all, because `input text` is ASCII-only.

---

## What dogfooding caught

Each of these was a silent defect — nothing errored — found only by running the tool against a real
app. They are why the corresponding design rules exist.

1. **Auto-start murdered live sessions.** `am instrument` restarts the target app's process, so
   probing-and-starting the agent mid-journey destroyed the screen under test. Fixed first by never
   auto-starting while the app runs, and then — architecturally — by moving the agent into its own
   driver app, where the problem cannot occur.
2. **Compose `ACTION_SET_TEXT` lies on controlled fields.** `performed=true`, the node even reads
   back the new value for a while, then reverts: state never changed, the search never ran. Text
   entry now verifies at two delays and escalates to clipboard-paste through the real editing
   pipeline.
3. **Assertions must wait, not snapshot.** A one-shot assert loses every debounce race by design.
   Asserts now poll until true or deadline.
4. **`monkey` holds the device's single `UiAutomation`** for ~2s around every launch, so instant
   `uiautomator dump` retries all landed inside the window. Launch is now `am start -W`.
5. **Cold-start readiness is a journey concern.** After relaunch the window is foreground before the
   Compose tree is populated. Assert-with-timeout on a shell tag is the idiom: 12/12 with it, 9/10
   without.

## Tablet — Pixel Tablet API 37 (2560×1600 @ 320dpi)

Same server, *identical* journey script — test tags are form-factor independent, so nothing about
the flow changed.

| Check | Result |
|---|---|
| Agent auto-start on a second device (phone still attached) | works; per-device host ports (8340 / 8578), no collision |
| Full Arabic journey, landscape | **9/9** |
| Full Arabic journey, portrait | **9/9** |
| Fresh semantic tree | p50 **44ms**, p95 71ms (~3× the phone; still ~50× the adb path) |

**Three orientation bugs this exposed, every one invisible on a phone:**

1. **Rotation silently no-opped.** `user_rotation` counts quarter turns from the display's *natural*
   orientation. Mapping portrait→0 is correct only when natural is portrait; on a landscape-native
   tablet it wrote 0, changed nothing, and reported success. Now derived from measured geometry,
   and the setter blocks until the display actually turns.
2. **`getOrientation` inferred instead of measuring** — it read the rotation setting, which is
   meaningless without the natural orientation. Now reads the live display size.
3. **`getScreenSize` returned the physical (rotation-0) size**, so in portrait every derived
   coordinate was computed against a 2560-wide space on a 1600-wide screen: the default pinch centre
   landed off-screen, and swipe endpoints with it.

Also fixed: the element cache now invalidates on rotation, and a killed `uiautomator dump` is
treated as proof a late-arriving agent came up — the server re-probes and completes on the fast path
instead of failing a healthy device.

**Device behaviour, not a tool bug:** auto-rotate can be re-enabled by the system, after which the
emulator's virtual sensor pulls a tablet back to natural landscape on the next app relaunch.
Orientation is disabled-and-verified on every call, but if a sequence relaunches the app afterwards,
re-assert orientation rather than assuming it held. Rotate *after* launching.

## Honest caveats

- The adb-transport numbers double as an upstream-0.0.62 proxy: same commands, same dump path.
  0.0.62 additionally had no `run_steps`, asserts, or waits at all.
- The iOS comparison in [COVERAGE.md](COVERAGE.md) is capability coverage, not latency — the iOS
  `control` tool exposes no semantic tree, waits, assertions, logs, or composites to race against.
- Wifi/mobile-data *toggles* are implemented but were not exercised on the daily-driver phone;
  reads were verified. Pinch and gesture were verified by injection result plus screen change, not
  against a zoomable surface.
- The bench harness was disposable. The numbers and the method are what is recorded here; re-run
  before trusting any of it in a materially different setup.
