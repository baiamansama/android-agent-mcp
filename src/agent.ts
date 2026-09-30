import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { getAdbPath } from "./android";
import { AgentIdentity, INSTRUMENTATION_RUNNER, agentStartHint as startHint, autoInstallEnabled, resolveAgentIdentity, resolveDriverApks } from "./config";
import { ActionableError, ScreenElement } from "./robot";

/**
 * Client for the on-device agent (`DeviceAgent`, built from `agent/` in this repo).
 *
 * The host-side `uiautomator dump` path is a flattened XML snapshot pulled off the device. It is
 * slow (~2.3s per read) and it discards the two things that make automation reliable: whether a
 * node is actually visible, and the ability to act on a node rather than a screen coordinate.
 * When the agent is running, every one of those problems disappears.
 *
 * Availability is never assumed. The agent needs the androidTest APK installed and an
 * `am instrument` process alive, which is often not true, so every call site must degrade to the
 * adb path rather than fail.
 */

/** The port the on-device agent binds. Fixed in the Kotlin agent; identical on every device. */
const DEVICE_PORT = 8299;

/**
 * Host-side port range for the forwards.
 *
 * The host port must differ per device. `adb forward tcp:8299 …` is a global host binding, so a
 * second device — an emulator booting alongside a phone — silently steals it, and every request
 * afterwards reaches the wrong device or nothing at all. Measured exactly that: the emulator took
 * the forward, the phone's agent became unreachable, and the server degraded to adb for the rest
 * of the session while reporting nothing unusual. Deriving the host port from the device id makes
 * the collision impossible rather than merely unlikely.
 */
const HOST_PORT_BASE = 8299;
const HOST_PORT_SPAN = 400;

/**
 * Which instrumentation carries the agent, and whether starting it is free.
 *
 * Resolved once from the environment (see `config.ts`) rather than hardcoded, because the answer
 * differs between the bundled standalone driver and an agent someone compiled into their own app.
 * Read at module load: an MCP server does not outlive a change to its own configuration.
 */
export const AGENT_IDENTITY: AgentIdentity = resolveAgentIdentity();

/** Do not retry a failed launch on every call — the test APK may simply not be installed. */
const LAUNCH_COOLDOWN_MS = 30_000;
const LAUNCH_POLL_ATTEMPTS = 12;
/**
 * The very first `am instrument` after an install pays dexopt/verification and took ~6-10s on
 * the API 37 emulator (measured 2026-08-28) — past the ordinary 6s window. When WE just spawned
 * the instrumentation deliberately, waiting longer is strictly better than launching the
 * activity into a process the instrumentation is still bringing up.
 */
const SPAWNED_POLL_ATTEMPTS = 40;
const LAUNCH_POLL_MS = 500;

/** Stable host port for one device. Override with `ANDROID_AGENT_PORT` when debugging by hand. */
export const agentPort = (deviceId = ""): number => {
	const configured = Number(process.env.ANDROID_AGENT_PORT);
	if (Number.isFinite(configured) && configured > 0) {
		return configured;
	}
	let hash = 0;
	for (const char of deviceId) {
		hash = (hash * 31 + char.charCodeAt(0)) % HOST_PORT_SPAN;
	}
	return HOST_PORT_BASE + hash;
};

/** One element as reported by the agent. Richer than the XML dump can be. */
export interface AgentElement {
	id: string | null;
	text: string | null;
	desc: string | null;
	className: string | null;
	clickable: boolean;
	enabled: boolean;
	focused: boolean;
	editable: boolean;
	/**
	 * Whether the node is actually visible to the user.
	 *
	 * This is the signal the host-side dump cannot provide, and the reason a tap could previously
	 * land on the soft keyboard while the tree insisted the target was right there.
	 *
	 * Caveat from the platform docs: between API 16 and API 29 this can incorrectly report false
	 * while screen magnification is active. The driver's minSdk is 26, so that band is in range —
	 * treat it as advisory for ranking, never as a hard filter.
	 */
	visible: boolean;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Index into the window stack this node came from; 0 is topmost. */
	window?: number;
	/** Package owning that window. Lets a caller spot a match that is not in the app under test. */
	package?: string | null;
	scrollable?: boolean;
	/** Protocol 7+. */
	selected?: boolean;
	/** Protocol 7+, present only on checkable nodes. */
	checked?: boolean;
	/** Protocol 7+: the node belongs to the soft keyboard's window. */
	ime?: boolean;
}

export const toScreenElement = (element: AgentElement): ScreenElement => {
	const screenElement: ScreenElement = {
		type: element.className || "android.view.View",
		rect: { x: element.x, y: element.y, width: element.width, height: element.height },
	};
	if (element.id) {
		screenElement.identifier = element.id;
	}
	if (element.text) {
		screenElement.text = element.text;
	}
	if (element.desc) {
		screenElement.label = element.desc;
	}
	if (element.clickable) {
		screenElement.clickable = true;
	}
	if (element.focused) {
		screenElement.focused = true;
	}
	// Visibility is the signal this agent exists to provide; dropping it here once made
	// `mobile_assert visible` silently degrade into an existence check. Always carried, both
	// values — `false` is the informative one.
	screenElement.visible = element.visible;
	if (element.scrollable) {
		screenElement.scrollable = true;
	}
	if (element.enabled === false) {
		screenElement.enabled = false;
	}
	if (element.selected) {
		screenElement.selected = true;
	}
	if (element.checked !== undefined) {
		screenElement.checked = element.checked;
	}
	if (element.ime) {
		screenElement.ime = true;
	}
	return screenElement;
};

/** A selector as the agent understands it. `index` picks among matches, visible ones first. */
export interface AgentSelector {
	id?: string;
	idPrefix?: string;
	text?: string;
	index?: number;
}

/**
 * What a click actually did, as the agent observed it.
 *
 * `method` is `node` when the accessibility action changed the screen and `gesture` when a real tap
 * had to follow; `changed` is present only after a gesture and is false when even that moved
 * nothing. Reporting these is the difference between "tapped" and "tapped, and the screen
 * responded" — a caller that is told only the first cannot tell a dead button from a live one.
 */
export interface ActionOutcome {
	target?: AgentElement;
	method?: string;
	changed?: boolean;
	matchCount?: number;
}

/** One application or IME window, topmost first. */
export interface AgentWindow {
	index: number;
	package: string | null;
	title: string | null;
	type: string;
	active: boolean;
	focused: boolean;
	layer: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface AgentScreenshot {
	/** Returned image dimensions — scaled when maxWidth was passed. */
	width: number;
	height: number;
	/** Native display dimensions, the pixel space element bounds use. */
	deviceWidth: number;
	deviceHeight: number;
	format: string;
	data: string;
}

interface AgentResponse {
	ok: boolean;
	error?: string;
	elements?: AgentElement[];
	target?: AgentElement;
	device?: string;
	protocol?: number;
	windows?: AgentWindow[];
	foreground?: string | null;
	stable?: boolean;
	visible?: boolean;
	scrolls?: number;
	width?: number;
	height?: number;
	deviceWidth?: number;
	deviceHeight?: number;
	format?: string;
	data?: string;
	method?: string;
	changed?: boolean;
	matchCount?: number;
}

/**
 * Agent wire protocol this host speaks.
 *
 * Bumped whenever an op's request or response shape changes, and checked on every `ping`, so a
 * driver APK built from a different commit is refused loudly instead of failing later on a
 * missing field. `DeviceAgent.PROTOCOL` in `agent/` is the other half of this pair; the two must
 * be changed together.
 *
 * 7 — every read clears the accessibility cache first; `selected`, `checked` and `ime` on elements;
 *     `index` on selectors; `matchCount` on click and longClick.
 * 6 — `capabilities` op added; `setText` tries ACTION_SET_TEXT before the clipboard path.
 * 5 — on-device screenshot scaling, per-node visibility, window stack.
 */
export const AGENT_PROTOCOL = 7;

/**
 * A request that reached the agent but got no answer in time.
 *
 * Distinguished from connection errors because the two demand opposite reactions: a refused or
 * reset connection means the agent is dead and force-stopping the instrumentation to release
 * UiAutomation is correct — but the instrumentation shares the app's process, so force-stopping a
 * merely *busy* agent kills the app mid-session, which is the one thing this server promises not
 * to do. A timeout therefore only marks the agent unavailable and lets the next call re-probe.
 */
export class AgentTimeoutError extends Error {}

/** One timed point on a single-finger path, in device pixels. */
export interface GesturePoint {
	x: number;
	y: number;
	/** Milliseconds after the previous point. Ignored on the first point. */
	dtMs?: number;
}

export interface PinchRequest {
	centerX: number;
	centerY: number;
	/** Finger-to-finger distance at the start, in pixels. */
	startSpread: number;
	/** Finger-to-finger distance at the end. Larger than start = zoom in. */
	endSpread: number;
	durationMs?: number;
	/** Finger axis in degrees; 0 places the fingers horizontally. */
	angleDeg?: number;
}

export class AgentClient {

	private forwarded = false;

	constructor(private readonly deviceId: string) {}

	/**
	 * Publish the device port on the host.
	 *
	 * Idempotent and cheap, so it runs before the first probe rather than being a separate setup
	 * step a caller has to remember.
	 */
	private ensureForward(): void {
		if (this.forwarded) {
			return;
		}
		try {
			execFileSync(
				getAdbPath(),
				["-s", this.deviceId, "forward", `tcp:${agentPort(this.deviceId)}`, `tcp:${DEVICE_PORT}`],
				{ encoding: "utf8", timeout: 5000 },
			);
			this.forwarded = true;
		} catch {
			// Leave `forwarded` false so the next call retries; a missing forward simply means the
			// agent is unreachable and the caller falls back.
		}
	}

	private request(payload: Record<string, unknown>, timeoutMs: number): Promise<AgentResponse> {
		this.ensureForward();

		// Test hook: the real op timeouts are seconds long, which is correct on a device and
		// unusable in a unit test driving a fake agent that deliberately never answers.
		const override = Number(process.env.ANDROID_AGENT_OP_TIMEOUT_MS);
		if (Number.isFinite(override) && override > 0) {
			timeoutMs = override;
		}

		return new Promise((resolve, reject) => {
			const socket = net.connect(agentPort(this.deviceId), "127.0.0.1");
			let buffer = "";
			let settled = false;

			const finish = (fn: () => void) => {
				if (settled) {
					return;
				}
				settled = true;
				socket.destroy();
				fn();
			};

			const timer = setTimeout(
				() => finish(() => reject(new AgentTimeoutError(`Agent timed out after ${timeoutMs}ms`))),
				timeoutMs,
			);

			socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
			socket.on("data", chunk => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline < 0) {
					return;
				}
				clearTimeout(timer);
				const line = buffer.slice(0, newline);
				finish(() => {
					try {
						resolve(JSON.parse(line) as AgentResponse);
					} catch (error: any) {
						reject(new Error(`Agent sent malformed JSON: ${error.message}`));
					}
				});
			});
			socket.on("error", error => {
				clearTimeout(timer);
				finish(() => reject(error));
			});
			socket.on("close", () => {
				clearTimeout(timer);
				finish(() => reject(new Error("Agent closed the connection without responding")));
			});
		});
	}

	/** Cheap liveness probe. Short timeout so a missing agent costs almost nothing. */
	public async isAvailable(): Promise<boolean> {
		try {
			const response = await this.request({ op: "ping" }, 1200);
			if (response.ok !== true) {
				return false;
			}
			// A device carrying an older test APK answers ping but not the ops added since. Treating
			// that as "available" would route every call to an agent that cannot serve it.
			if (typeof response.protocol === "number" && response.protocol !== AGENT_PROTOCOL) {
				this.protocolMismatch = response.protocol;
				return false;
			}
			this.protocolMismatch = null;
			return true;
		} catch {
			// Re-establish the forward on the next call. A dead agent is the usual reason a probe
			// fails, but a stolen or dropped forward looks identical from here and would otherwise
			// persist for the life of the process.
			this.forwarded = false;
			return false;
		}
	}

	/** Non-null when the device is running an agent this host cannot talk to. */
	public protocolMismatch: number | null = null;

	/**
	 * Forget the cooldown so the next call relaunches immediately, and stop any agent still serving
	 * from the previous APK.
	 *
	 * Installing an APK is the one event that both kills the agent and proves it is installable, so
	 * it must not be subject to a backoff meant for "the test APK probably is not there".
	 *
	 * Stopping the old instrumentation matters more than it looks. `am instrument` survives an app
	 * force-stop, and the host-side `adb forward` keeps accepting connections regardless — so a
	 * stale agent answers `ping` perfectly while serving code from the APK you just replaced. The
	 * symptom is a fix that appears not to work, which is an expensive thing to debug.
	 */
	public invalidate(): void {
		this.lastLaunchAttempt = 0;
		this.forwarded = false;
		this.testApkPresent = null;
		this.stop();
	}

	/**
	 * Stop the on-device instrumentation, releasing the device's single UiAutomation connection.
	 *
	 * Separate from [invalidate] because releasing the connection is sometimes the whole point: the
	 * adb path cannot read the screen at all while the agent holds it.
	 */
	public stop(): void {
		try {
			execFileSync(getAdbPath(), ["-s", this.deviceId, "shell", "am", "force-stop", AGENT_IDENTITY.testPackage], {
				encoding: "utf8",
				timeout: 5000,
			});
		} catch {
			// Nothing was running, or the package is absent. Either way the relaunch below is correct.
		}
	}

	/**
	 * Probe, and start the agent if it is not answering.
	 *
	 * The agent is killed by every `adb install -r` of either the app or the test APK, which happens
	 * constantly during development — so in practice it spent most of its life dead and callers
	 * silently ran on the slower adb path without anyone noticing. Requiring a human to re-run
	 * `am instrument` after each install is why the fast path was rarely the path actually taken.
	 *
	 * The counterweight applies to **embedded** agents only: `am instrument` restarts its target
	 * package's process, so in embedded mode auto-starting mid-session destroys the very screen the
	 * caller is operating on — measured as journeys whose app vanished to the launcher between two
	 * steps. There, when the app is running and the agent is not, the honest move is to stay on adb
	 * and let the next tool-driven launch re-arm the fast path via [allowAppRestart].
	 *
	 * In **standalone** mode the target is the driver's own empty stub, so there is no session to
	 * destroy and the guard is simply skipped: the agent starts on demand, whatever is on screen.
	 * That is most of the value of shipping a separate driver, and it is why the standalone path
	 * reaches the fast transport in situations the embedded one has to decline.
	 *
	 * Launch is detached and unref'd: `am instrument` blocks while serving, so it must outlive the
	 * call that started it.
	 */
	public async ensureRunning(options: { allowAppRestart?: boolean } = {}): Promise<boolean> {
		if (await this.isAvailable()) {
			return true;
		}

		// A missing driver, or one speaking another protocol, is the most common reason the fast
		// path is silently off. When a matching driver is available locally, installing it is free:
		// it is this tool's own package, and in standalone mode nothing else restarts.
		if (this.protocolMismatch !== null || !this.testApkInstalled()) {
			this.installBundledDriver();
		}

		// No test APK, no agent — answer from a cached ~40ms check instead of paying a 6s spawn
		// poll on every launch in environments that never installed it.
		if (!this.testApkInstalled()) {
			return false;
		}

		// An instrumentation that is already connecting will answer `ping` within a second or two.
		// Racing it with a second `am instrument` kills the app process, so wait it out instead —
		// this applies even on the launch path, which otherwise skips every guard below.
		if (this.instrumentationRunning()) {
			return await this.pollUntilAvailable();
		}

		if (!options.allowAppRestart && AGENT_IDENTITY.mode === "embedded") {
			if (this.targetAppRunning()) {
				return false;
			}
			// A failed launch must not be retried on every single call — the instrumentation may
			// be genuinely unlaunchable here (wrong device state, CI). An explicit app launch is
			// exempt: the caller is deliberately paying for a fresh, instrumented process.
			const now = Date.now();
			if (now - this.lastLaunchAttempt < LAUNCH_COOLDOWN_MS) {
				return false;
			}
		}
		this.lastLaunchAttempt = Date.now();

		try {
			const child = spawn(
				getAdbPath(),
				[
					"-s", this.deviceId, "shell", "am", "instrument", "-w",
					"-e", "class", AGENT_IDENTITY.className,
					`${AGENT_IDENTITY.testPackage}/${INSTRUMENTATION_RUNNER}`,
				],
				{ detached: true, stdio: "ignore" },
			);
			child.unref();
		} catch {
			return false;
		}

		return await this.pollUntilAvailable(SPAWNED_POLL_ATTEMPTS);
	}

	/** Instrumentation takes a moment to install its hooks and bind the socket. */
	private async pollUntilAvailable(attempts = LAUNCH_POLL_ATTEMPTS): Promise<boolean> {
		for (let attempt = 0; attempt < attempts; attempt++) {
			await new Promise(resolve => setTimeout(resolve, LAUNCH_POLL_MS));
			if (await this.isAvailable()) {
				return true;
			}
		}
		return false;
	}

	private lastLaunchAttempt = 0;

	/** Cached "is the test APK installed" answer; cleared by [invalidate] when an install occurs. */
	private testApkPresent: boolean | null = null;

	/** Set once an install has been attempted, so a failing install is not retried on every call. */
	private driverInstallAttempted = false;

	/** Result of the last automatic install, for status reporting. */
	public driverInstall: { installed: boolean; from?: string; error?: string } | null = null;

	/**
	 * Install the standalone driver from a local build, at most once per server lifetime.
	 *
	 * Standalone only: an embedded agent lives in the caller's own app build, which this server has
	 * no business replacing. Stops any running instrumentation first so the new APK is what serves.
	 */
	private installBundledDriver(): void {
		if (this.driverInstallAttempted || !autoInstallEnabled(AGENT_IDENTITY)) {
			return;
		}
		this.driverInstallAttempted = true;
		const apks = resolveDriverApks(path.resolve(__dirname, ".."), fs.existsSync, path.join);
		if (!apks) {
			return;
		}
		try {
			this.stop();
			for (const apk of [apks.app, apks.test]) {
				execFileSync(getAdbPath(), ["-s", this.deviceId, "install", "-r", "-t", apk], {
					encoding: "utf8",
					timeout: 120_000,
					stdio: ["pipe", "pipe", "pipe"],
				});
			}
			this.testApkPresent = true;
			this.protocolMismatch = null;
			this.forwarded = false;
			this.driverInstall = { installed: true, from: path.dirname(apks.test) };
		} catch (error: any) {
			this.testApkPresent = null;
			this.driverInstall = { installed: false, error: (error.stderr?.toString() || error.message || "").split("\n")[0] };
		}
	}

	private testApkInstalled(): boolean {
		if (this.testApkPresent !== null) {
			return this.testApkPresent;
		}
		try {
			this.testApkPresent = execFileSync(getAdbPath(), ["-s", this.deviceId, "shell", "pm", "path", AGENT_IDENTITY.testPackage], {
				encoding: "utf8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
			}).toString().includes("package:");
		} catch {
			this.testApkPresent = false;
		}
		return this.testApkPresent;
	}

	/**
	 * Whether ActivityManager already has an instrumentation registered for our runner.
	 *
	 * Starting a second `am instrument` while the first is still connecting throws
	 * `Cannot call disconnect() while connecting UiAutomation` inside the APP's process, and the
	 * default handler kills that process — so a redundant start does not merely waste time, it
	 * destroys the session under test and drops the caller back to the launcher. Measured twice on
	 * the tablet emulator, once mid-journey.
	 *
	 * The check has to be ActivityManager's own record: instrumentation shares the target app's
	 * process, so `pidof <testPackage>` is always blank and proves nothing. Grepping
	 * device-side keeps this at ~40ms and off the host.
	 */
	private instrumentationRunning(): boolean {
		try {
			const count = execFileSync(
				getAdbPath(),
				["-s", this.deviceId, "shell", `dumpsys activity | grep -c '${AGENT_IDENTITY.testPackage}/'`],
				{ encoding: "utf8", timeout: 8000, stdio: ["pipe", "pipe", "pipe"] },
			).toString().trim();
			return Number(count) > 0;
		} catch {
			// grep exits non-zero when it matches nothing, which is exactly "not running".
			return false;
		}
	}

	/**
	 * Whether the app the instrumentation targets currently has a live process.
	 *
	 * Only consulted in embedded mode. In standalone mode the target is the driver's own stub, and
	 * whether it happens to be running says nothing about whether restarting it is safe.
	 */
	private targetAppRunning(): boolean {
		try {
			return execFileSync(getAdbPath(), ["-s", this.deviceId, "shell", "pidof", "-s", AGENT_IDENTITY.targetPackage], {
				encoding: "utf8",
				timeout: 3000,
				stdio: ["pipe", "pipe", "pipe"],
			}).toString().trim() !== "";
		} catch {
			// pidof exits non-zero when there is no such process.
			return false;
		}
	}

	/**
	 * Every describable node across the window stack, with the foreground package alongside.
	 *
	 * `allWindows` false restricts the walk to the topmost application window, which is what a
	 * caller wants when a dialog or IME is up and it only cares about the app beneath.
	 */
	public async dump(allWindows = true): Promise<{ elements: AgentElement[]; foreground: string | null }> {
		const response = await this.request({ op: "dump", allWindows }, 15000);
		if (!response.ok || !response.elements) {
			throw new ActionableError(response.error || "Agent dump failed");
		}
		return { elements: response.elements, foreground: response.foreground ?? null };
	}

	public async click(selector: AgentSelector): Promise<ActionOutcome> {
		return this.act("click", selector);
	}

	private async act(op: "click" | "longClick", selector: AgentSelector): Promise<ActionOutcome> {
		const response = await this.request({ op, ...selector }, 15000);
		if (!response.ok) {
			throw new ActionableError(response.error || `Agent ${op} failed`);
		}
		return { target: response.target, method: response.method, changed: response.changed, matchCount: response.matchCount };
	}

	/**
	 * Write a field's contents. Unicode-safe and needs no keyboard installed.
	 *
	 * `mode: "replace"` (default) swaps the field's contents — set-a-field semantics. `"append"`
	 * pastes at the end of the existing text — type-into-a-field semantics, matching what the adb
	 * path does at the cursor, so both transports agree on what typing means.
	 *
	 * Passing an empty string with replace clears the field, per the ACTION_SET_TEXT contract.
	 */
	public async setText(
		selector: AgentSelector,
		value: string,
		mode: "replace" | "append" = "replace",
	): Promise<AgentElement | undefined> {
		const response = await this.request({ op: "setText", ...selector, value, mode }, 15000);
		if (!response.ok) {
			throw new ActionableError(response.error || "Agent setText failed");
		}
		return response.target;
	}

	public async waitIdle(timeoutMs = 10000): Promise<void> {
		await this.request({ op: "waitIdle", timeoutMs }, timeoutMs + 5000);
	}

	public async longClick(selector: AgentSelector): Promise<ActionOutcome> {
		return this.act("longClick", selector);
	}

	/** Every application and IME window, topmost first, plus which package owns the foreground. */
	public async windows(): Promise<{ windows: AgentWindow[]; foreground: string | null }> {
		const response = await this.request({ op: "windows" }, 10000);
		if (!response.ok || !response.windows) {
			throw new ActionableError(response.error || "Agent window query failed");
		}
		return { windows: response.windows, foreground: response.foreground ?? null };
	}

	/** The package owning the topmost application window, or null when nothing is in front. */
	public async foreground(): Promise<string | null> {
		const response = await this.request({ op: "windows" }, 10000);
		return response.ok ? response.foreground ?? null : null;
	}

	/**
	 * Block until the accessibility tree stops changing.
	 *
	 * Returns `stable:false` on timeout rather than throwing — some surfaces animate forever, and
	 * that is a fact worth reporting rather than an error to catch.
	 */
	public async waitStable(options: { timeoutMs?: number; settleSamples?: number } = {}): Promise<boolean> {
		const timeoutMs = options.timeoutMs ?? 10000;
		const response = await this.request(
			{ op: "waitStable", timeoutMs, settleSamples: options.settleSamples },
			timeoutMs + 5000,
		);
		return response.stable === true;
	}

	/** Block until `packageName` owns the topmost application window. */
	public async waitForPackage(packageName: string, timeoutMs = 10000): Promise<boolean> {
		const response = await this.request(
			{ op: "waitForPackage", package: packageName, timeoutMs },
			timeoutMs + 5000,
		);
		return response.ok === true && response.visible !== false;
	}

	/** Scroll a node into view through its nearest scrollable ancestor. */
	public async scrollIntoView(
		selector: AgentSelector,
		maxScrolls?: number,
	): Promise<AgentElement | undefined> {
		const response = await this.request({ op: "scrollIntoView", ...selector, maxScrolls }, 45000);
		if (!response.ok) {
			throw new ActionableError(response.error || "Agent scrollIntoView failed");
		}
		return response.target;
	}

	/**
	 * Drive one finger through a timed path. `holdMs` waits between touch-down and the first
	 * move, which is what turns a drag into a long-press-then-drag.
	 */
	public async gesture(points: GesturePoint[], holdMs?: number): Promise<void> {
		const budget = points.reduce((total, point) => total + (point.dtMs ?? 12), 0) + (holdMs ?? 0);
		const response = await this.request({ op: "gesture", points, holdMs }, budget + 15000);
		if (!response.ok) {
			throw new ActionableError(response.error || "Agent gesture failed");
		}
	}

	/** Two-finger pinch about a centre. Larger endSpread than startSpread zooms in. */
	public async pinch(request: PinchRequest): Promise<void> {
		const response = await this.request({ op: "pinch", ...request }, (request.durationMs ?? 400) + 15000);
		if (!response.ok) {
			throw new ActionableError(response.error || "Agent pinch failed");
		}
	}

	/**
	 * Screenshot scaled and encoded on the device.
	 *
	 * The agent compresses before the wire, so the payload is tens of kilobytes instead of a
	 * multi-megabyte base64 PNG, and the host needs no image tooling at all on this path.
	 */
	public async screenshot(options: { maxWidth?: number; quality?: number; format?: "jpeg" | "png" } = {}): Promise<AgentScreenshot> {
		const response = await this.request({ op: "screenshot", ...options }, 20000);
		if (!response.ok || !response.data) {
			throw new ActionableError(response.error || "Agent screenshot failed");
		}
		return {
			width: response.width ?? 0,
			height: response.height ?? 0,
			deviceWidth: response.deviceWidth ?? response.width ?? 0,
			deviceHeight: response.deviceHeight ?? response.height ?? 0,
			format: response.format ?? "jpeg",
			data: response.data,
		};
	}

	/** Two precise taps inside the platform's double-tap window — inexpressible over adb. */
	public async doubleTap(x: number, y: number): Promise<void> {
		const response = await this.request({ op: "doubleTap", x, y }, 15000);
		if (!response.ok) {
			throw new ActionableError(response.error || "Agent doubleTap failed");
		}
	}
}

/** The exact command that starts the agent, surfaced in errors so a caller is never stuck. */
export const agentStartHint = (deviceId: string): string =>
	startHint(deviceId, AGENT_IDENTITY);
