---
name: Bug report
about: Something behaves differently than documented
labels: bug
---

**What happened, and what you expected instead**

**Environment**

Paste the output of the `mobile_agent_status` tool — it reports the transport, the configured agent
identity, and (when the agent is absent) what is actually installed. Most first questions are
answered by it.

```json

```

- `adb devices -l`:
- Device API level (`adb shell getprop ro.build.version.sdk`):
- Host OS and Node version:

**Reproduction**

The smallest sequence of tool calls that shows it.

**If it is a UI-tree problem**

An `adb shell uiautomator dump` of the same screen usually settles whether the node is missing from
the accessibility tree or missing from our handling of it.
