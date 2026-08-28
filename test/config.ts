import { test, expect } from "@playwright/test";
import {
	DEFAULT_DRIVER_CLASS,
	DEFAULT_DRIVER_PACKAGE,
	DEFAULT_DRIVER_TEST_PACKAGE,
	agentStartHint,
	parseInstrumentations,
	resolveAgentIdentity,
} from "../src/config";

/**
 * Run `body` with exactly `vars` applied over the agent-related environment.
 *
 * Every `ANDROID_AGENT_*` key is cleared first, because resolution reads the real process
 * environment and a developer with one of these exported would otherwise see different results
 * than CI — the kind of failure that gets "fixed" by deleting the assertion.
 */
const withEnv = (vars: Record<string, string | undefined>, body: () => void): void => {
	const keys = [
		"ANDROID_AGENT_TEST_PACKAGE",
		"ANDROID_AGENT_TARGET_PACKAGE",
		"ANDROID_AGENT_CLASS",
		"ANDROID_AGENT_MODE",
	];
	const saved = new Map(keys.map(key => [key, process.env[key]]));
	try {
		for (const key of keys) {
			delete process.env[key];
		}
		for (const [key, value] of Object.entries(vars)) {
			if (value !== undefined) {
				process.env[key] = value;
			}
		}
		body();
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

test.describe("config", () => {

	test.describe("resolveAgentIdentity", () => {
		test("should default to the bundled standalone driver", () => {
			withEnv({}, () => {
				const identity = resolveAgentIdentity();
				expect(identity.testPackage).toBe(DEFAULT_DRIVER_TEST_PACKAGE);
				expect(identity.targetPackage).toBe(DEFAULT_DRIVER_PACKAGE);
				expect(identity.className).toBe(DEFAULT_DRIVER_CLASS);
				expect(identity.mode).toBe("standalone");
			});
		});

		test("should derive target package and class from a test package alone", () => {
			withEnv({ ANDROID_AGENT_TEST_PACKAGE: "com.example.app.test" }, () => {
				const identity = resolveAgentIdentity();
				expect(identity.targetPackage).toBe("com.example.app");
				expect(identity.className).toBe("com.example.app.agent.DeviceAgent");
			});
		});

		test("should treat an agent embedded in someone else's app as embedded", () => {
			// This is the safety-critical inference: embedded mode is what stops the host from
			// restarting a live app to start the agent.
			withEnv({ ANDROID_AGENT_TEST_PACKAGE: "com.example.app.test" }, () => {
				expect(resolveAgentIdentity().mode).toBe("embedded");
			});
		});

		test("should honour an explicit mode override in both directions", () => {
			withEnv({ ANDROID_AGENT_TEST_PACKAGE: "com.example.app.test", ANDROID_AGENT_MODE: "standalone" }, () => {
				expect(resolveAgentIdentity().mode).toBe("standalone");
			});
			withEnv({ ANDROID_AGENT_MODE: "embedded" }, () => {
				expect(resolveAgentIdentity().mode).toBe("embedded");
			});
		});

		test("should ignore an unrecognised mode rather than trusting it", () => {
			withEnv({ ANDROID_AGENT_MODE: "turbo" }, () => {
				expect(resolveAgentIdentity().mode).toBe("standalone");
			});
		});

		test("should accept an explicit target package that is not the test package minus .test", () => {
			withEnv({
				ANDROID_AGENT_TEST_PACKAGE: "com.example.driver.test",
				ANDROID_AGENT_TARGET_PACKAGE: "com.example.other",
			}, () => {
				const identity = resolveAgentIdentity();
				expect(identity.targetPackage).toBe("com.example.other");
				expect(identity.className).toBe("com.example.other.agent.DeviceAgent");
			});
		});

		test("should treat a blank environment variable as unset", () => {
			withEnv({ ANDROID_AGENT_TEST_PACKAGE: "   " }, () => {
				expect(resolveAgentIdentity().testPackage).toBe(DEFAULT_DRIVER_TEST_PACKAGE);
			});
		});
	});

	test.describe("parseInstrumentations", () => {
		test("should parse the pm list instrumentation format", () => {
			const output = [
				"instrumentation:com.example.app.test/androidx.test.runner.AndroidJUnitRunner (target=com.example.app)",
				"instrumentation:dev.androidagent.driver.test/androidx.test.runner.AndroidJUnitRunner (target=dev.androidagent.driver)",
			].join("\n");
			expect(parseInstrumentations(output)).toEqual([
				{ testPackage: "com.example.app.test", runner: "androidx.test.runner.AndroidJUnitRunner", targetPackage: "com.example.app" },
				{ testPackage: "dev.androidagent.driver.test", runner: "androidx.test.runner.AndroidJUnitRunner", targetPackage: "dev.androidagent.driver" },
			]);
		});

		test("should skip lines it does not recognise instead of throwing", () => {
			// adb interleaves warnings and daemon chatter with command output often enough that a
			// strict parser here would fail on a perfectly healthy device.
			const output = [
				"* daemon started successfully",
				"instrumentation:com.example.app.test/androidx.test.runner.AndroidJUnitRunner (target=com.example.app)",
				"instrumentation:malformed-without-target",
				"",
			].join("\n");
			expect(parseInstrumentations(output)).toHaveLength(1);
		});

		test("should return nothing for empty output", () => {
			expect(parseInstrumentations("")).toEqual([]);
		});
	});

	test.describe("agentStartHint", () => {
		test("should quote the configured identity, not a hardcoded one", () => {
			const hint = agentStartHint("emulator-5554", {
				targetPackage: "com.example.app",
				testPackage: "com.example.app.test",
				className: "com.example.app.agent.DeviceAgent",
				mode: "embedded",
			});
			expect(hint).toContain("-s emulator-5554");
			expect(hint).toContain("com.example.app.agent.DeviceAgent");
			expect(hint).toContain("com.example.app.test/androidx.test.runner.AndroidJUnitRunner");
		});
	});
});
