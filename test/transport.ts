import { test, expect } from "@playwright/test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { AgentAndroidRobot } from "../src/automation";
import { AGENT_PROTOCOL } from "../src/agent";
import { resolveDeviceId, resetDeviceListCacheForTests } from "../src/server";

/**
 * The transport state machine is where every dogfood-caught bug has lived — probe, demote,
 * cooldown, killed-dump recovery — and it was the one layer with no tests because it needs a
 * device. These tests stand in the device: a fake `adb` shell script (reached via ANDROID_HOME)
 * answers the host's process spawns, and a local TCP server (reached via ANDROID_AGENT_PORT)
 * plays the on-device agent.
 */

const DEVICE = "fake-device-1";

const UI_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>`
	+ `<hierarchy rotation="0"><node class="android.widget.FrameLayout" text="" resource-id="root" bounds="[0,0][1080,2340]" clickable="false">`
	+ `<node class="android.widget.TextView" text="Path" resource-id="shell.dock.home" bounds="[24,2148][120,2244]" clickable="true"/>`
	+ `</node></hierarchy>`;

interface FakeRig {
	dir: string;
	logPath: string;
	env: Record<string, string | undefined>;
	adbCalls: () => string[];
	cleanup: () => void;
}

/**
 * Install a fake `adb` at $ANDROID_HOME/platform-tools/adb that logs every invocation and
 * answers the handful of queries the robot makes. `dumpMode` controls the uiautomator answer:
 * "xml" serves a real tree, "killed" simulates the agent holding UiAutomation.
 */
const makeRig = (options: { dumpMode: "xml" | "killed"; devicesOutput?: string }): FakeRig => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "android-agent-mcp-test-"));
	fs.mkdirSync(path.join(dir, "platform-tools"));
	const logPath = path.join(dir, "adb.log");
	const xmlPath = path.join(dir, "ui.xml");
	fs.writeFileSync(xmlPath, UI_XML);

	const devicesOutput = options.devicesOutput ?? `List of devices attached\n${DEVICE}\tdevice\n`;
	const dumpAnswer = options.dumpMode === "xml" ? `cat "${xmlPath}"` : `echo "Killed"`;

	const script = `#!/bin/bash
echo "$@" >> "${logPath}"
case "$*" in
  *"devices"*) printf '${devicesOutput.replace(/\n/g, "\\n")}' ;;
  *"forward"*) exit 0 ;;
  *"pm path"*) echo "package:/data/app/test.apk" ;;
  *"pidof -s dev.androidagent.driver"*) echo "1234" ;;
  *"dumpsys activity activities"*) echo "  topResumedActivity=ActivityRecord{x u0 com.example.app/.MainActivity t1}" ;;
  *"dumpsys activity | grep -c"*) echo "1" ;;
  *"uiautomator dump"*) ${dumpAnswer} ;;
  *"force-stop"*) exit 0 ;;
  *) exit 0 ;;
esac
`;
	const adbPath = path.join(dir, "platform-tools", "adb");
	fs.writeFileSync(adbPath, script, { mode: 0o755 });

	return {
		dir,
		logPath,
		env: {},
		adbCalls: () => fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n") : [],
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
};

/** A fake on-device agent: scripted responses per op, or silence, or an abrupt hang-up. */
const makeFakeAgent = (behavior: (op: string) => "answer" | "silent" | "die", protocol = AGENT_PROTOCOL): Promise<{ port: number; close: () => void }> =>
	new Promise(resolve => {
		const server = net.createServer(socket => {
			socket.on("data", chunk => {
				const line = chunk.toString().trim();
				if (!line) {
					return;
				}
				const request = JSON.parse(line);
				const mode = behavior(request.op);
				if (mode === "silent") {
					return; // never answer; the host's timeout fires
				}
				if (mode === "die") {
					socket.destroy();
					return;
				}
				const response: any = { ok: true };
				if (request.op === "ping") {
					response.protocol = protocol;
					response.device = "fake";
				}
				if (request.op === "dump") {
					response.elements = [{
						id: "shell.dock.home", text: "Path", desc: null, className: "android.view.View",
						clickable: true, enabled: true, focused: false, editable: false, visible: true,
						x: 24, y: 2148, width: 96, height: 96, window: 0, package: "com.example.app",
					}];
					response.foreground = "com.example.app";
				}
				socket.write(JSON.stringify(response) + "\n");
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as net.AddressInfo).port;
			resolve({ port, close: () => server.close() });
		});
	});

const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>) => {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(vars)) {
		saved.set(key, process.env[key]);
		process.env[key] = value;
	}
	try {
		await fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
};

test.describe("transport state machine", () => {

	test("healthy agent serves the tree and adb is never asked to dump", async () => {
		const rig = makeRig({ dumpMode: "xml" });
		const agent = await makeFakeAgent(() => "answer");
		try {
			await withEnv({ ANDROID_HOME: rig.dir, ANDROID_AGENT_PORT: String(agent.port) }, async () => {
				const robot = new AgentAndroidRobot(DEVICE);
				const elements = await robot.getElementsOnScreen();
				expect(elements.length).toBe(1);
				expect(elements[0].identifier).toBe("shell.dock.home");
				expect(elements[0].visible).toBe(true);
				expect(rig.adbCalls().filter(call => call.includes("uiautomator")).length).toBe(0);
			});
		} finally {
			agent.close();
			rig.cleanup();
		}
	});

	test("protocol mismatch refuses the agent and reports it in the envelope", async () => {
		const rig = makeRig({ dumpMode: "xml" });
		const agent = await makeFakeAgent(() => "answer", AGENT_PROTOCOL - 1);
		try {
			await withEnv({ ANDROID_HOME: rig.dir, ANDROID_AGENT_PORT: String(agent.port) }, async () => {
				const robot = new AgentAndroidRobot(DEVICE);
				const elements = await robot.getElementsOnScreen();
				// Served by the adb XML path instead.
				expect(elements.some(e => e.identifier === "shell.dock.home")).toBe(true);
				expect(rig.adbCalls().some(call => call.includes("uiautomator"))).toBe(true);
				const envelope = await robot.envelope({});
				expect(envelope.transport).toBe("adb");
				expect(envelope.agentProtocolMismatch).toBe(AGENT_PROTOCOL - 1);
			});
		} finally {
			agent.close();
			rig.cleanup();
		}
	});

	test("an agent TIMEOUT never force-stops the instrumentation", async () => {
		const rig = makeRig({ dumpMode: "killed" });
		// Ping answers (agent looks alive), dump goes silent (agent busy/wedged).
		const agent = await makeFakeAgent(op => op === "ping" ? "answer" : "silent");
		try {
			await withEnv({
				ANDROID_HOME: rig.dir,
				ANDROID_AGENT_PORT: String(agent.port),
				ANDROID_AGENT_OP_TIMEOUT_MS: "250",
			}, async () => {
				const robot = new AgentAndroidRobot(DEVICE);
				await expect(robot.getElementsOnScreen()).rejects.toThrow();
				// The one behavior that kills the app under test: force-stopping the test package
				// on a transient timeout. Must not happen.
				expect(rig.adbCalls().some(call => call.includes("force-stop"))).toBe(false);
			});
		} finally {
			agent.close();
			rig.cleanup();
		}
	});

	test("a DEAD connection demotes hard and releases UiAutomation via force-stop", async () => {
		const rig = makeRig({ dumpMode: "xml" });
		const agent = await makeFakeAgent(op => op === "ping" ? "answer" : "die");
		try {
			await withEnv({ ANDROID_HOME: rig.dir, ANDROID_AGENT_PORT: String(agent.port) }, async () => {
				const robot = new AgentAndroidRobot(DEVICE);
				const elements = await robot.getElementsOnScreen();
				// Demoted to adb and still served the caller.
				expect(elements.some(e => e.identifier === "shell.dock.home")).toBe(true);
				expect(rig.adbCalls().some(call => call.includes("force-stop"))).toBe(true);
			});
		} finally {
			agent.close();
			rig.cleanup();
		}
	});
});

test.describe("device resolution", () => {

	test("a single connected device is resolved without being named", async () => {
		const rig = makeRig({ dumpMode: "xml" });
		try {
			await withEnv({ ANDROID_HOME: rig.dir }, async () => {
				resetDeviceListCacheForTests();
				expect(resolveDeviceId(undefined)).toBe(DEVICE);
				expect(resolveDeviceId("explicit-id")).toBe("explicit-id");
			});
		} finally {
			rig.cleanup();
		}
	});

	test("zero and multiple devices fail with actionable errors", async () => {
		const none = makeRig({ dumpMode: "xml", devicesOutput: "List of devices attached\n" });
		try {
			await withEnv({ ANDROID_HOME: none.dir }, async () => {
				resetDeviceListCacheForTests();
				expect(() => resolveDeviceId(undefined)).toThrow(/No Android device/);
			});
		} finally {
			none.cleanup();
		}

		const two = makeRig({
			dumpMode: "xml",
			devicesOutput: "List of devices attached\nphone-1\tdevice\nemulator-5554\tdevice\n",
		});
		try {
			await withEnv({ ANDROID_HOME: two.dir }, async () => {
				resetDeviceListCacheForTests();
				expect(() => resolveDeviceId(undefined)).toThrow(/Multiple devices/);
			});
		} finally {
			two.cleanup();
		}
	});
});
