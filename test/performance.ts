import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AndroidPerformanceController, compactText, parseProfileableState } from "../src/performance";

const DEVICE = "fake-device";

const makeAdb = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "android-agent-perf-"));
	const adb = path.join(dir, "adb");
	const log = path.join(dir, "calls.log");
	fs.writeFileSync(adb, `#!/bin/bash
echo "$@" >> "${log}"
case "$*" in
  *"getprop ro.build.version.sdk"*) echo 37 ;;
  *"getprop ro.build.version.release"*) echo 17 ;;
  *"getprop ro.product.model"*) echo "Pixel Test" ;;
  *"command -v perfetto"*) echo /system/bin/perfetto ;;
  *"command -v simpleperf"*) echo /system/bin/simpleperf ;;
  *"dumpsys package"*) echo "flags=[ DEBUGGABLE PROFILEABLE_BY_SHELL ]" ;;
  *"perfetto --background-wait"*) echo 4242 ;;
  *"pidof simpleperf"*) exit 1 ;;
  *"stat -c %s"*) echo 128 ;;
  *"pull"*) printf trace > "\${@: -1}" ;;
  *"simpleperf report"*) echo "12.5% com.example.HotPath" ;;
  *"dumpsys gfxinfo"*) printf 'Janky frames: 2 (4.00%%)\n---PROFILEDATA---\nlarge,raw,frame,data\n' ;;
  *"dumpsys meminfo"*) echo "TOTAL PSS: 12345" ;;
  *"am dumpheap"*) exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
	return {
		adb,
		log: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "",
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
};

test("profileable flags are parsed without depending on dumpsys formatting", () => {
	expect(parseProfileableState("flags=[ DEBUGGABLE PROFILEABLE_BY_SHELL ]")).toEqual({ debuggable: true, profileable: true });
	expect(parseProfileableState("debuggable=false profileableByShell=true")).toEqual({ debuggable: false, profileable: true });
});

test("large diagnostic text is bounded", () => {
	const result = compactText("x".repeat(100), 12);
	expect(result.truncated).toBe(true);
	expect(Buffer.byteLength(result.text)).toBeLessThan(100);
});

test("capabilities report collectors and package profiling state", () => {
	const rig = makeAdb();
	try {
		const controller = new AndroidPerformanceController(rig.adb);
		const result = controller.capabilities(DEVICE, "com.example.app");
		expect(result.android).toEqual({ sdk: 37, release: "17", model: "Pixel Test" });
		expect(result.collectors).toEqual({ perfetto: true, simpleperf: true, gfxinfo: true, meminfo: true, heapDump: true });
		expect(result.package).toEqual({ packageName: "com.example.app", debuggable: true, profileable: true });
	} finally {
		rig.cleanup();
	}
});

test("perfetto capture starts, finalizes, pulls, and cleans up", async () => {
	const rig = makeAdb();
	const output = path.join(os.tmpdir(), `android-agent-${Date.now()}.perfetto-trace`);
	try {
		const controller = new AndroidPerformanceController(rig.adb);
		const started = controller.start(DEVICE, "perfetto", "com.example.app", 5);
		expect(started.pid).toBe(4242);
		const stopped = await controller.stop(DEVICE, output);
		expect(stopped.outputPath).toBe(output);
		expect(fs.readFileSync(output, "utf8")).toBe("trace");
		expect(rig.log()).toContain("kill -TERM 4242");
		expect(rig.log()).toContain("rm -f /data/misc/perfetto-traces/");
	} finally {
		fs.rmSync(output, { force: true });
		rig.cleanup();
	}
});

test("frame and memory snapshots return bounded evidence", () => {
	const rig = makeAdb();
	try {
		const controller = new AndroidPerformanceController(rig.adb);
		const frames = controller.frameStats(DEVICE, "com.example.app");
		expect(frames.text).toContain("Janky frames");
		expect(frames.text).not.toContain("large,raw,frame,data");
		expect(frames.profileDataOmitted).toBe(true);
		expect(controller.frameStats(DEVICE, "com.example.app", true)).toEqual({
			packageName: "com.example.app",
			reset: true,
			outputPath: undefined,
		});
		expect(controller.memorySnapshot(DEVICE, "com.example.app").text).toContain("TOTAL PSS");
	} finally {
		rig.cleanup();
	}
});
