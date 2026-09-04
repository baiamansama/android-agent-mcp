# Security Policy

## What this tool is

`android-agent-mcp` gives an MCP client — typically an LLM agent — control of a connected Android
device or emulator. **It can do anything a person holding the unlocked device can do**: open any
app, read anything on screen, type anywhere, grant permissions, change system settings, and read
logs.

Treat that as the security boundary. Use a device intended for automation, not one holding personal
accounts, messages, or payment methods. Review what your agent is invoking, the same way you would
review any tool with shell access.

## Design choices that limit exposure

- **The agent binds loopback only.** `ServerSocket(8299, backlog, InetAddress.getByName("127.0.0.1"))`
  — it is reachable solely through an `adb forward` from a host that already has adb access to the
  device. Nothing listens on an external interface.
- **The server is stdio-only.** Upstream's Express/SSE listener was removed: a local tool driving
  real developer devices should not carry a network listener with no caller.
- **The driver app is inert.** No activity, no service, no receiver, nothing exported, nothing
  launchable. It exists so `am instrument` has a target package to restart.
- **The agent never ships in your app.** It lives in an instrumentation APK, installed by hand over
  adb. Nothing in this project belongs in a production build.
- **No telemetry.** Upstream's default-on analytics was removed and nothing replaced it. This
  project makes no network requests of its own.
- **Shell arguments are validated.** Package names, locales, file extensions and output paths are
  checked before they reach a shell (`src/utils.ts`, covered by tests) — these tools take
  model-generated input, so injection is a live concern rather than a theoretical one.

## Known sharp edges

- `mobile_open_url` is guarded to http/https by default; custom schemes require an explicit env
  override, because a deep link is a way to reach app state a URL bar cannot.
- `mobile_app_state` can grant runtime permissions, and `mobile_device_state` can change system
  settings. Both are the point of the tool and both are real changes to the device.
- `mobile_logcat` and `mobile_get_crash` return device logs, which may contain whatever apps on
  that device chose to log.
- `mobile_performance` can collect traces, CPU samples, memory details and heap dumps. Those
  artifacts may contain method names, identifiers, strings or other user data; heap dumping can
  briefly pause the target. Store and share them as sensitive developer artifacts.
- The agent holds the device's single `UiAutomation` while running. That is a capability an
  ordinary app cannot get, which is exactly why it is instrumentation and not a library.

## Reporting a vulnerability

Report privately through **GitHub's private vulnerability reporting** on this repository
(Security → Report a vulnerability). Please do not open a public issue for a security problem.

Include the device and API level, whether the agent was running, and the smallest reproduction you
have. You will get an acknowledgement, and a fix or an explanation of why it is not one.

## Supported versions

This project is pre-1.0. Fixes land on `main`; there are no backports.
