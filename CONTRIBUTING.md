# Contributing

Bug reports, fixes, and new capabilities are all welcome. This file is what you need to be
productive; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is what you need to make a *good* change.

## Setup

Node 20+, the Android SDK, and — for the on-device agent — a JDK 17+.

```bash
npm install
npm run build
npm run lint
npm test
```

`npm test` is Playwright's runner over unit tests; it needs no device and never touches one,
even when one is attached. Device tests are opt-in, because they press HOME, open URLs and rotate
the display of whatever is connected — often an emulator someone else is using:

```bash
ANDROID_AGENT_DEVICE_TESTS=1 npm test                                    # device-backed tests
ANDROID_AGENT_DEVICE_TESTS=1 ANDROID_AGENT_THIRD_PARTY_E2E=1 npm test    # plus Chrome/Clock E2E
```

To work on the agent:

```bash
npm run agent:install -- --rebuild
```

## Verify on a device

This project exists because host-side assumptions about Android UI are wrong more often than they
look. **A change to behaviour is not done until it has run on a device or emulator.** Say in the PR
what you ran it on: API level, form factor, and whether the agent was up.

Both transports matter. The agent path is the fast one; the adb path is what everyone without the
driver gets. If your change touches a shared code path, exercise both:

```bash
ANDROID_AGENT_DISABLE=1   # forces the adb transport on unchanged code
```

## What a good change looks like

**Degrade, don't fail.** Every agent-backed operation has an adb fallback or an actionable error
naming the exact command to fix it. A new capability with no fallback must say so in its tool
description and in [TOOLS.md](docs/TOOLS.md).

**Verify, don't trust.** The platform accepts actions it does not perform — `ACTION_CLICK` on
Compose clickables, `ACTION_SET_TEXT` on controlled fields. If your change performs an action,
confirm from the tree that it landed, and report which mechanism carried it.

**Wait, don't sleep.** Poll a real condition with a deadline. A fixed sleep is either too short
(flaky) or too long (slow), and usually both on different hardware.

**Errors are for an LLM to recover from.** "No node matched" is a dead end; "no node matched, the
addressable tags on screen are X, Y, Z, and the foreground app is W" is a next step. Assume the
reader cannot see the device.

**Spend tokens like they are money.** Every character a tool returns is paid for on every call.
Prefer the compact format, prefer a filter, prefer a diff.

**Comments explain why.** The codebase documents the reasoning behind non-obvious decisions,
especially where a platform behaviour forced the shape. If you fix something subtle, leave the
measurement behind — that comment is the reason nobody re-introduces the bug.

## Changing the agent

The agent and host are versioned together by a protocol number checked on every `ping`.

1. Edit `agent/driver/src/androidTest/java/dev/androidagent/driver/agent/DeviceAgent.kt`.
2. Bump `PROTOCOL` there **and** `AGENT_PROTOCOL` in `src/agent.ts`, in the same commit.
3. Add the client method in `src/agent.ts`, the tool in `src/server.ts`.
4. Update [docs/AGENT_PROTOCOL.md](docs/AGENT_PROTOCOL.md), and [docs/TOOLS.md](docs/TOOLS.md) if it
   surfaces as a tool.
5. `npm run agent:install -- --rebuild`.

Skipping step 2 produces the worst kind of bug: everything connects and something fails much later
on a missing field.

## Style

`npm run lint` is the arbiter; `npm run fixlint` fixes most of it. Tabs, double quotes, semicolons —
inherited from upstream and kept so diffs against `mobile-mcp` stay cheap.

## Reporting a bug

Include the output of `mobile_agent_status`, `adb devices -l`, and the device's API level. Those
three answer most of the first round of questions. If it is a UI-tree problem, an
`adb shell uiautomator dump` of the same screen is the thing that settles it.

Security issues go through GitHub's private vulnerability reporting instead — see
[SECURITY.md](SECURITY.md).

## License

Contributions are accepted under the Apache License 2.0, matching the project. This is a fork of
[mobile-mcp](https://github.com/mobile-next/mobile-mcp) 0.0.62; if you touch a file that still
closely resembles its upstream original, keeping the diff small is a real (if minor) virtue.
