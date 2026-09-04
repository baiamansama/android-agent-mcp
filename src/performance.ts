import { ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getAdbPath } from "./android";
import { ActionableError } from "./robot";
import { validateFileExtension, validateOutputPath, validatePackageName } from "./utils";

export type ProfileKind = "perfetto" | "simpleperf";

export interface ActiveProfile {
	id: string;
	device: string;
	kind: ProfileKind;
	packageName: string;
	remotePath: string;
	startedAt: number;
	durationSeconds: number;
	pid?: number;
	process?: ChildProcess;
}

const PROFILE_EXTENSIONS: Record<ProfileKind, string> = {
	perfetto: ".perfetto-trace",
	simpleperf: ".data",
};

const DEFAULT_PERFETTO_CATEGORIES = [
	"sched", "freq", "idle", "am", "wm", "gfx", "view", "binder_driver", "hal", "dalvik",
];

const parseLastInteger = (value: string): number | undefined => {
	const lines = value.trim().split(/\r?\n/).reverse();
	for (const line of lines) {
		if (/^\d+$/.test(line.trim())) {
			return Number(line.trim());
		}
	}
	return undefined;
};

export const parseProfileableState = (value: string): { debuggable: boolean; profileable: boolean } => ({
	debuggable: /debuggable\s*=\s*true/i.test(value) || /flags\s*=\s*\[[^\]]*\bDEBUGGABLE\b/i.test(value),
	profileable: /profileable(?:ByShell)?\s*=\s*true/i.test(value) || /flags\s*=\s*\[[^\]]*\bPROFILEABLE_BY_SHELL\b/i.test(value),
});

export const compactText = (value: string, maxBytes = 64 * 1024): { text: string; truncated: boolean } => {
	const buffer = Buffer.from(value);
	if (buffer.length <= maxBytes) {
		return { text: value, truncated: false };
	}
	return {
		text: buffer.subarray(0, maxBytes).toString("utf8") + "\n… output truncated by android-agent-mcp …",
		truncated: true,
	};
};

const waitForExit = async (child: ChildProcess, timeoutMs: number): Promise<void> => {
	if (child.exitCode !== null) {
		return;
	}
	await new Promise<void>(resolve => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, timeoutMs);
		child.once("close", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
};

export class AndroidPerformanceController {
	private readonly active = new Map<string, ActiveProfile>();

	public constructor(private readonly adbPath = getAdbPath()) {}

	private adb(device: string, args: string[], timeout = 30_000): string {
		return execFileSync(this.adbPath, ["-s", device, ...args], {
			timeout,
			maxBuffer: 8 * 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
		}).toString();
	}

	private available(device: string, command: string): boolean {
		try {
			return this.adb(device, ["shell", "command", "-v", command], 5_000).trim().length > 0;
		} catch {
			return false;
		}
	}

	public capabilities(device: string, packageName?: string): Record<string, unknown> {
		if (packageName) {
			validatePackageName(packageName);
		}
		const sdk = Number(this.adb(device, ["shell", "getprop", "ro.build.version.sdk"], 5_000).trim());
		const release = this.adb(device, ["shell", "getprop", "ro.build.version.release"], 5_000).trim();
		const model = this.adb(device, ["shell", "getprop", "ro.product.model"], 5_000).trim();
		const result: Record<string, unknown> = {
			device,
			android: { sdk, release, model },
			collectors: {
				perfetto: sdk >= 28 && this.available(device, "perfetto"),
				simpleperf: this.available(device, "simpleperf"),
				gfxinfo: true,
				meminfo: true,
				heapDump: true,
			},
		};
		if (packageName) {
			let packageDump = "";
			try {
				packageDump = this.adb(device, ["shell", "dumpsys", "package", packageName]);
			} catch (err: any) {
				throw new ActionableError(`Package ${packageName} is not installed or could not be inspected: ${err.stderr?.toString().trim() || err.message}`);
			}
			result.package = { packageName, ...parseProfileableState(packageDump) };
		}
		return result;
	}

	public start(device: string, kind: ProfileKind, packageName: string, durationSeconds = 30, frequencyHz = 4000): ActiveProfile {
		validatePackageName(packageName);
		if (this.active.has(device)) {
			const current = this.active.get(device)!;
			throw new ActionableError(`Device ${device} already has active ${current.kind} capture ${current.id}. Stop it before starting another.`);
		}
		if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 300) {
			throw new ActionableError("durationSeconds must be between 1 and 300.");
		}
		if (!Number.isFinite(frequencyHz) || frequencyHz < 100 || frequencyHz > 10_000) {
			throw new ActionableError("frequencyHz must be between 100 and 10000.");
		}

		const id = `${kind}-${Date.now().toString(36)}`;
		const remotePath = kind === "perfetto"
			? `/data/misc/perfetto-traces/${id}.perfetto-trace`
			: `/data/local/tmp/${id}.data`;
		const profile: ActiveProfile = { id, device, kind, packageName, remotePath, startedAt: Date.now(), durationSeconds };

		if (kind === "perfetto") {
			if (!this.available(device, "perfetto")) {
				throw new ActionableError("Perfetto is unavailable. It requires Android 9 (API 28) or newer with the perfetto binary present.");
			}
			const output = this.adb(device, [
				"shell", "perfetto", "--background-wait", "-o", remotePath,
				"-t", `${durationSeconds}s`, "--app", packageName, ...DEFAULT_PERFETTO_CATEGORIES,
			], 15_000);
			const pid = parseLastInteger(output);
			if (!pid) {
				throw new ActionableError(`Perfetto did not return a capture pid: ${output.trim() || "no output"}`);
			}
			profile.pid = pid;
		} else {
			if (!this.available(device, "simpleperf")) {
				throw new ActionableError("Simpleperf is unavailable on this device.");
			}
			profile.process = spawn(this.adbPath, [
				"-s", device, "shell", "simpleperf", "record", "--app", packageName,
				"-o", remotePath, "-e", "cpu-clock", "-f", String(frequencyHz), "-g",
				"--duration", String(durationSeconds),
			], { stdio: "ignore" });
			// An adb executable that disappears between capability detection and spawn should not
			// become an unhandled EventEmitter error that terminates the MCP process.
			profile.process.on("error", () => undefined);
		}

		this.active.set(device, profile);
		return profile;
	}

	public status(device: string): Omit<ActiveProfile, "process"> | null {
		const current = this.active.get(device);
		if (!current) {
			return null;
		}
		return {
			id: current.id,
			device: current.device,
			kind: current.kind,
			packageName: current.packageName,
			remotePath: current.remotePath,
			startedAt: current.startedAt,
			durationSeconds: current.durationSeconds,
			...(current.pid ? { pid: current.pid } : {}),
		};
	}

	private async waitForRemoteFile(device: string, remotePath: string): Promise<number> {
		let lastSize = -1;
		let stable = 0;
		for (let attempt = 0; attempt < 30; attempt++) {
			try {
				const output = this.adb(device, ["shell", "stat", "-c", "%s", remotePath], 5_000).trim();
				const size = Number(output);
				if (size > 0 && size === lastSize) {
					stable++;
					if (stable >= 2) {
						return size;
					}
				} else {
					stable = 0;
				}
				lastSize = size;
			} catch {
				stable = 0;
			}
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		throw new ActionableError(`Capture did not finalize at ${remotePath}. It may still be running on the device.`);
	}

	public async stop(device: string, output?: string, includeReport = true): Promise<Record<string, unknown>> {
		const profile = this.active.get(device);
		if (!profile) {
			throw new ActionableError(`Device ${device} has no active performance capture.`);
		}
		if (profile.kind === "perfetto" && profile.pid) {
			try {
				this.adb(device, ["shell", "kill", "-TERM", String(profile.pid)], 5_000);
			} catch {
				// A duration-limited trace may already have ended.
			}
		} else if (profile.kind === "simpleperf") {
			try {
				const pids = this.adb(device, ["shell", "pidof", "simpleperf"], 5_000).trim().split(/\s+/).filter(Boolean);
				for (const pid of pids) {
					this.adb(device, ["shell", "kill", "-INT", pid], 5_000);
				}
			} catch {
				// The duration-limited capture may already have ended.
			}
			if (profile.process) {
				await waitForExit(profile.process, 10_000);
			}
		}

		const remoteBytes = await this.waitForRemoteFile(device, profile.remotePath);
		const outputPath = output ?? path.join(os.tmpdir(), `${profile.id}${PROFILE_EXTENSIONS[profile.kind]}`);
		validateFileExtension(outputPath, [PROFILE_EXTENSIONS[profile.kind]], "mobile_performance stop");
		validateOutputPath(outputPath);
		this.adb(device, ["pull", profile.remotePath, outputPath], 120_000);

		let reportPath: string | undefined;
		let reportTruncated: boolean | undefined;
		if (profile.kind === "simpleperf" && includeReport) {
			try {
				const report = this.adb(device, ["shell", "simpleperf", "report", "-i", profile.remotePath], 120_000);
				reportPath = `${outputPath}.report.txt`;
				validateOutputPath(reportPath);
				fs.writeFileSync(reportPath, report);
				reportTruncated = false;
			} catch {
				// The capture remains useful when device-side report generation is unsupported.
			}
		}
		try {
			this.adb(device, ["shell", "rm", "-f", profile.remotePath], 5_000);
		} catch {
			// A pulled artifact is success; remote cleanup is best effort.
		}
		this.active.delete(device);

		return {
			id: profile.id,
			kind: profile.kind,
			packageName: profile.packageName,
			outputPath,
			bytes: fs.statSync(outputPath).size,
			remoteBytes,
			durationMs: Date.now() - profile.startedAt,
			...(reportPath ? { reportPath, reportTruncated } : {}),
		};
	}

	public frameStats(device: string, packageName: string, reset = false, output?: string): Record<string, unknown> {
		validatePackageName(packageName);
		const args = ["shell", "dumpsys", "gfxinfo", packageName, reset ? "reset" : "framestats"];
		const raw = this.adb(device, args);
		if (output) {
			validateFileExtension(output, [".txt"], "mobile_performance frame_stats");
			validateOutputPath(output);
			fs.writeFileSync(output, raw);
		}
		if (reset) {
			// Android prints the old counters while resetting them. Do not return the
			// discarded multi-kilobyte dump from an operation whose intent is reset.
			return { packageName, reset: true, outputPath: output };
		}
		const profileMarker = "---PROFILEDATA---";
		const markerIndex = raw.indexOf(profileMarker);
		const summaryRaw = markerIndex >= 0 ? raw.slice(0, markerIndex).trimEnd() : raw;
		const result = compactText(summaryRaw, 8 * 1024);
		return {
			packageName,
			reset: false,
			outputPath: output,
			profileDataOmitted: markerIndex >= 0,
			rawBytes: Buffer.byteLength(raw),
			truncated: result.truncated,
			text: result.text,
		};
	}

	public memorySnapshot(device: string, packageName: string, output?: string): Record<string, unknown> {
		validatePackageName(packageName);
		const raw = this.adb(device, ["shell", "dumpsys", "meminfo", packageName]);
		const result = compactText(raw);
		if (output) {
			validateFileExtension(output, [".txt"], "mobile_performance memory");
			validateOutputPath(output);
			fs.writeFileSync(output, raw);
		}
		return { packageName, outputPath: output, truncated: result.truncated, text: result.text };
	}

	public async heapDump(device: string, packageName: string, output?: string): Promise<Record<string, unknown>> {
		validatePackageName(packageName);
		const id = `heap-${Date.now().toString(36)}`;
		const remotePath = `/data/local/tmp/${id}.hprof`;
		const outputPath = output ?? path.join(os.tmpdir(), `${id}.hprof`);
		validateFileExtension(outputPath, [".hprof"], "mobile_performance heap_dump");
		validateOutputPath(outputPath);
		this.adb(device, ["shell", "am", "dumpheap", "-g", packageName, remotePath], 120_000);
		await this.waitForRemoteFile(device, remotePath);
		this.adb(device, ["pull", remotePath, outputPath], 120_000);
		try {
			this.adb(device, ["shell", "rm", "-f", remotePath], 5_000);
		} catch {
			// Keep the local artifact even if remote cleanup fails.
		}
		return { packageName, outputPath, bytes: fs.statSync(outputPath).size };
	}
}
