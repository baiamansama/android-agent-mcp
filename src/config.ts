/**
 * Where the on-device agent lives, and what the host may assume about restarting it.
 *
 * The agent is an Android instrumentation. Every instrumentation names a `targetPackage`, and
 * `am instrument` **restarts that package's process** before it runs. Which package that is turns
 * out to be the single most consequential fact about the whole system, so it is resolved once,
 * here, rather than assumed at each call site.
 *
 * Two arrangements are supported:
 *
 * - **standalone** (the default): the agent ships in `android-agent-driver`, whose instrumentation
 *   targets its own empty stub app. Starting the agent restarts nothing that matters, so the host
 *   may start it whenever it likes — including in the middle of a session, with the app under test
 *   in the foreground and untouched. `UiAutomation` is device-wide, so the agent still reads and
 *   drives every app on the device. This is what makes the tool usable against apps you do not own
 *   and cannot rebuild.
 *
 * - **embedded**: the agent is compiled into your own app's `androidTest` source set, so the
 *   instrumentation targets your app. This buys one thing — the agent runs *inside* your app's
 *   process, so it shares the app's clipboard and classloader — at the cost of the restart hazard:
 *   starting the agent while your app is running destroys the screen the caller was working on.
 *   The lifecycle in `AgentClient.ensureRunning` degrades to the adb path rather than take that
 *   risk, which is why the same code is slower to reach the fast path in this mode.
 *
 * Nothing here talks to a device. Resolution is pure so it can be unit-tested and so a
 * misconfiguration surfaces as a clear message rather than a mystery timeout.
 */

/** The driver shipped in `agent/` — see that module's README for how to build and install it. */
export const DEFAULT_DRIVER_PACKAGE = "dev.androidagent.driver";
export const DEFAULT_DRIVER_TEST_PACKAGE = "dev.androidagent.driver.test";
export const DEFAULT_DRIVER_CLASS = "dev.androidagent.driver.agent.DeviceAgent";

/** The runner every androidx.test instrumentation is started through. */
export const INSTRUMENTATION_RUNNER = "androidx.test.runner.AndroidJUnitRunner";

export type AgentMode = "standalone" | "embedded";

export interface AgentIdentity {
	/** The package `am instrument` restarts. Harmless in standalone mode; the app under test in embedded mode. */
	targetPackage: string;
	/** The instrumentation APK that carries the agent class. */
	testPackage: string;
	/** Fully-qualified name of the agent's JUnit class. */
	className: string;
	mode: AgentMode;
}

const env = (name: string): string | undefined => {
	const value = process.env[name];
	return value && value.trim().length > 0 ? value.trim() : undefined;
};

/**
 * Resolve the agent's identity from the environment, defaulting to the bundled standalone driver.
 *
 * Overrides, all optional:
 *
 * - `ANDROID_AGENT_TEST_PACKAGE` — the instrumentation APK. Setting this alone is enough for the
 *   common embedded case, because the target package and class are derivable from it by the same
 *   conventions AGP itself uses (`<app>.test` for the APK, `<app>.agent.DeviceAgent` for a class
 *   copied unmodified out of this repo).
 * - `ANDROID_AGENT_TARGET_PACKAGE` — the app the instrumentation targets, when it is not simply
 *   the test package with `.test` removed.
 * - `ANDROID_AGENT_CLASS` — the agent class, if you renamed or repackaged it.
 * - `ANDROID_AGENT_MODE` — force `standalone` or `embedded` when the inference below is wrong.
 *
 * Mode is inferred rather than demanded because getting it wrong is expensive in only one
 * direction. Treating an embedded agent as standalone lets the host restart your app mid-session;
 * treating a standalone agent as embedded merely makes it more cautious than it needs to be. So
 * anything that is not recognisably the bundled driver is assumed embedded.
 */
export const resolveAgentIdentity = (): AgentIdentity => {
	const testPackage = env("ANDROID_AGENT_TEST_PACKAGE") ?? DEFAULT_DRIVER_TEST_PACKAGE;
	const targetPackage = env("ANDROID_AGENT_TARGET_PACKAGE") ?? testPackage.replace(/\.test$/, "");
	const className = env("ANDROID_AGENT_CLASS")
		?? (testPackage === DEFAULT_DRIVER_TEST_PACKAGE
			? DEFAULT_DRIVER_CLASS
			: `${targetPackage}.agent.DeviceAgent`);

	const declared = env("ANDROID_AGENT_MODE");
	const mode: AgentMode = declared === "standalone" || declared === "embedded"
		? declared
		: targetPackage === DEFAULT_DRIVER_PACKAGE ? "standalone" : "embedded";

	return { targetPackage, testPackage, className, mode };
};

/**
 * Parse `adb shell pm list instrumentation`.
 *
 * Line shape: `instrumentation:pkg.test/androidx.test.runner.AndroidJUnitRunner (target=pkg)`.
 * Used by `mobile_agent_status` to tell a caller what is actually installed, which turns the most
 * common setup failure — the driver was never installed, or was installed for a different user —
 * from a silent fallback to the adb path into a stated fact.
 */
export const parseInstrumentations = (output: string): { testPackage: string; runner: string; targetPackage: string }[] =>
	output.split("\n")
		.map(line => line.trim())
		.filter(line => line.startsWith("instrumentation:"))
		.flatMap(line => {
			const match = line.match(/^instrumentation:(\S+?)\/(\S+?)\s+\(target=(\S+?)\)$/);
			if (!match) {
				return [];
			}
			return [{ testPackage: match[1], runner: match[2], targetPackage: match[3] }];
		});

/** The exact command that starts the agent, surfaced in errors so a caller is never stuck. */
export const agentStartHint = (deviceId: string, identity: AgentIdentity): string =>
	`adb -s ${deviceId} shell am instrument -w -e class ${identity.className} `
	+ `${identity.testPackage}/${INSTRUMENTATION_RUNNER} `
	+ "(run it in the background; it blocks while serving)";

/** The two APKs that make up the standalone driver. */
export interface DriverApks {
	app: string;
	test: string;
}

const DRIVER_APP_APK = "driver-debug.apk";
const DRIVER_TEST_APK = "driver-debug-androidTest.apk";

/**
 * Where a locally available copy of the standalone driver lives, if anywhere.
 *
 * Checked in order: `ANDROID_AGENT_DRIVER_DIR` (both APKs side by side), a `driver/` directory
 * next to `lib/` (how a packaged or vendored copy ships them), and this repository's own Gradle
 * output (a source checkout after `npm run agent:build`). The first directory holding both wins.
 *
 * `root` is the package root; injectable so the lookup can be tested without touching the real
 * build tree.
 */
export const resolveDriverApks = (
	root: string,
	exists: (file: string) => boolean,
	join: (...parts: string[]) => string,
): DriverApks | null => {
	const candidates: DriverApks[] = [];
	const configured = env("ANDROID_AGENT_DRIVER_DIR");
	if (configured) {
		candidates.push({ app: join(configured, DRIVER_APP_APK), test: join(configured, DRIVER_TEST_APK) });
	}
	candidates.push({ app: join(root, "driver", DRIVER_APP_APK), test: join(root, "driver", DRIVER_TEST_APK) });
	const outputs = join(root, "agent", "driver", "build", "outputs", "apk");
	candidates.push({
		app: join(outputs, "debug", DRIVER_APP_APK),
		test: join(outputs, "androidTest", "debug", DRIVER_TEST_APK),
	});
	return candidates.find(pair => exists(pair.app) && exists(pair.test)) ?? null;
};

/** Auto-install is on unless `ANDROID_AGENT_AUTO_INSTALL=0`, and only ever for the standalone driver. */
export const autoInstallEnabled = (identity: AgentIdentity): boolean =>
	identity.mode === "standalone" && env("ANDROID_AGENT_AUTO_INSTALL") !== "0";
