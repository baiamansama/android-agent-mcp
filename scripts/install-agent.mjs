#!/usr/bin/env node
/**
 * Build and install the on-device driver.
 *
 * The agent is the difference between this server being fast and being ordinary, and the manual
 * route — build two APKs with Gradle, install both, get the package names right — is exactly the
 * kind of setup people abandon halfway. So it is one command.
 *
 *   npm run agent:install                 # build if needed, install on the only connected device
 *   npm run agent:install -- --device X   # target a specific device
 *   npm run agent:install -- --rebuild    # force a Gradle build even if the APKs look current
 *   npm run agent:install -- --start      # leave the agent running afterwards
 *
 * Requires a JDK 17+ and the Android SDK. `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) locates adb;
 * `JAVA_HOME` is passed through to Gradle untouched.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_DIR = path.join(REPO, "agent");
const APK_DIR = path.join(AGENT_DIR, "driver", "build", "outputs", "apk");
const APP_APK = path.join(APK_DIR, "debug", "driver-debug.apk");
const TEST_APK = path.join(APK_DIR, "androidTest", "debug", "driver-debug-androidTest.apk");

const TEST_PACKAGE = "dev.androidagent.driver.test";
const AGENT_CLASS = "dev.androidagent.driver.agent.DeviceAgent";
const RUNNER = "androidx.test.runner.AndroidJUnitRunner";

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};

const die = message => {
	console.error(`\n  ${message}\n`);
	process.exit(1);
};

const adbPath = () => {
	const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
	if (home) {
		const candidate = path.join(home, "platform-tools", "adb");
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	// Fall back to PATH; `adb version` below turns a missing binary into a clear message.
	return "adb";
};

const adb = (deviceArgs, ...rest) =>
	execFileSync(adbPath(), [...deviceArgs, ...rest], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

/**
 * Resolve the device to install on.
 *
 * Refusing to guess between two connected devices is deliberate: installing the driver on the
 * wrong one produces a server that reports "agent not running" against a device where it is, in
 * fact, running — on the other device.
 */
const resolveDevice = () => {
	const explicit = option("--device");
	let listing;
	try {
		listing = adb([], "devices");
	} catch {
		die(`Could not run adb (${adbPath()}). Set ANDROID_HOME, or put platform-tools on your PATH.`);
	}
	const devices = listing.split("\n")
		.slice(1)
		.map(line => line.trim().split(/\s+/))
		.filter(parts => parts.length >= 2 && parts[1] === "device")
		.map(parts => parts[0]);

	if (explicit) {
		if (!devices.includes(explicit)) {
			die(`Device "${explicit}" is not connected. Connected: ${devices.join(", ") || "(none)"}`);
		}
		return explicit;
	}
	if (devices.length === 0) {
		die("No device connected. Start an emulator or plug in a phone with USB debugging enabled.");
	}
	if (devices.length > 1) {
		die(`More than one device connected; pass --device <id>. Connected: ${devices.join(", ")}`);
	}
	return devices[0];
};

const build = () => {
	const gradlew = path.join(AGENT_DIR, process.platform === "win32" ? "gradlew.bat" : "gradlew");
	console.log("Building the driver (this takes about a minute the first time)...");
	const result = spawn(gradlew, [":driver:assembleDebug", ":driver:assembleDebugAndroidTest"], {
		cwd: AGENT_DIR,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	return new Promise((resolve, reject) => {
		result.on("exit", code => code === 0
			? resolve()
			: reject(new Error(`Gradle exited ${code}. A JDK 17+ and the Android SDK are required.`)));
		result.on("error", reject);
	});
};

const main = async () => {
	if (flag("--rebuild") || !existsSync(APP_APK) || !existsSync(TEST_APK)) {
		await build();
	} else {
		console.log("Using the already-built driver APKs (pass --rebuild to force a rebuild).");
	}

	const device = resolveDevice();
	const target = ["-s", device];
	console.log(`Installing on ${device}...`);
	// -r replaces an existing install; -g pre-grants runtime permissions so no dialog can block
	// automation later. Both APKs are debug-signed, so a previous install signed with a different
	// debug key has to go first — hence the uninstall attempt, which is allowed to fail.
	for (const pkg of [TEST_PACKAGE, TEST_PACKAGE.replace(/\.test$/, "")]) {
		try {
			adb(target, "uninstall", pkg);
		} catch {
			// Not installed. Nothing to remove.
		}
	}
	adb(target, "install", "-r", "-g", APP_APK);
	adb(target, "install", "-r", "-g", TEST_APK);

	const listed = adb(target, "shell", "pm", "list", "instrumentation").includes(TEST_PACKAGE);
	if (!listed) {
		die("Installed, but the instrumentation is not registered. Try `adb uninstall` both packages and re-run.");
	}
	console.log(`\n  Driver installed on ${device}.`);

	if (flag("--start")) {
		console.log("  Starting the agent in the background...");
		const child = spawn(adbPath(), [...target, "shell", "am", "instrument", "-w", "-e", "class", AGENT_CLASS, `${TEST_PACKAGE}/${RUNNER}`], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		console.log("  Started. The MCP server also starts it on demand, so this is optional.");
	} else {
		console.log("  The MCP server starts the agent on demand — nothing else to do.");
	}
	console.log("  Verify any time with the mobile_agent_status tool.\n");
};

main().catch(error => die(error.message));
