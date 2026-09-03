import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import * as xml from "fast-xml-parser";

import { resolveAgentIdentity } from "./config";
import { ActionableError, Button, InstalledApp, Robot, ScreenElement, ScreenElementRect, ScreenSize, SwipeDirection, Orientation } from "./robot";
import { validatePackageName, validateLocale } from "./utils";

export interface AndroidDevice {
	deviceId: string;
	deviceType: "tv" | "mobile";
}

/**
 * Window size classes, named as `androidx.window.core.layout.WindowSizeClass` names them.
 *
 * Adaptive Android UI branches on the window's width and height in dp, never on a device label,
 * so "verified on a tablet" is not a claim until the band the window was actually in can be
 * named. `large` and `extraLarge` are not decoration: a 1280dp tablet is `large`, and code that
 * only knows about `expanded` cannot tell it apart from a 900dp one.
 */
export type WidthClass = "compact" | "medium" | "expanded" | "large" | "extraLarge";
export type HeightClass = "compact" | "medium" | "expanded";

export interface WindowMetrics {
	widthPx: number;
	heightPx: number;
	density: number;
	widthDp: number;
	heightDp: number;
	smallestWidthDp: number;
	widthClass: WidthClass;
	heightClass: HeightClass;
}

export type WindowSizeRequest = "reset" | { widthDp: number; heightDp: number };

/**
 * Breakpoints from `androidx.window.core.layout.WindowSizeClass`, read out of
 * window-core-android 1.5.1 sources (`BREAKPOINTS_V2`). Ordered high to low: first hit wins.
 */
const WIDTH_DP_BANDS: ReadonlyArray<readonly [WidthClass, number]> = [
	["extraLarge", 1600],
	["large", 1200],
	["expanded", 840],
	["medium", 600],
	["compact", 0],
];

const HEIGHT_DP_BANDS: ReadonlyArray<readonly [HeightClass, number]> = [
	["expanded", 900],
	["medium", 480],
	["compact", 0],
];

export const widthClassFor = (widthDp: number): WidthClass =>
	WIDTH_DP_BANDS.find(([, lowerBound]) => widthDp >= lowerBound)?.[0] ?? "compact";

export const heightClassFor = (heightDp: number): HeightClass =>
	HEIGHT_DP_BANDS.find(([, lowerBound]) => heightDp >= lowerBound)?.[0] ?? "compact";

/**
 * The width to use when a caller names a band instead of a number. Each sits clear of its own
 * boundaries so rounding cannot spill into the neighbouring band; `compact` is 412dp because
 * that is the width of the phones a compact layout is drawn for.
 */
export const WIDTH_CLASS_TARGET_DP: Readonly<Record<WidthClass, number>> = {
	compact: 412,
	medium: 700,
	expanded: 1000,
	large: 1400,
	extraLarge: 1700,
};

interface UiAutomatorXmlNode {
	node: UiAutomatorXmlNode[];
	class?: string;
	text?: string;
	bounds?: string;
	hint?: string;
	focused?: string;
	checkable?: string;
	clickable?: string;
	"content-desc"?: string;
	"resource-id"?: string;
}

interface UiAutomatorXml {
	hierarchy: {
		node: UiAutomatorXmlNode;
	};
}

export const getAdbPath = (): string => {
	const exeName = process.env.platform === "win32" ? "adb.exe" : "adb";
	if (process.env.ANDROID_HOME) {
		return path.join(process.env.ANDROID_HOME, "platform-tools", exeName);
	}

	if (process.platform === "win32" && process.env.LOCALAPPDATA) {
		const windowsAdbPath = path.join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe");
		if (existsSync(windowsAdbPath)) {
			return windowsAdbPath;
		}
	}

	if (process.platform === "darwin" && process.env.HOME) {
		const defaultAndroidSdk = path.join(process.env.HOME, "Library", "Android", "sdk", "platform-tools", "adb");
		if (existsSync(defaultAndroidSdk)) {
			return defaultAndroidSdk;
		}
	}

	// fallthrough, hope for the best
	return exeName;
};

const BUTTON_MAP: Record<string, string> = {
	"BACK": "KEYCODE_BACK",
	"HOME": "KEYCODE_HOME",
	"APP_SWITCH": "KEYCODE_APP_SWITCH",
	"POWER": "KEYCODE_POWER",
	"WAKEUP": "KEYCODE_WAKEUP",
	"MENU": "KEYCODE_MENU",
	"VOLUME_UP": "KEYCODE_VOLUME_UP",
	"VOLUME_DOWN": "KEYCODE_VOLUME_DOWN",
	"ENTER": "KEYCODE_ENTER",
	"TAB": "KEYCODE_TAB",
	"DELETE": "KEYCODE_DEL",
	"ESCAPE": "KEYCODE_ESCAPE",
	"PAGE_UP": "KEYCODE_PAGE_UP",
	"PAGE_DOWN": "KEYCODE_PAGE_DOWN",
	"MEDIA_PLAY_PAUSE": "KEYCODE_MEDIA_PLAY_PAUSE",
	"MEDIA_NEXT": "KEYCODE_MEDIA_NEXT",
	"MEDIA_PREVIOUS": "KEYCODE_MEDIA_PREVIOUS",
	"DPAD_CENTER": "KEYCODE_DPAD_CENTER",
	"DPAD_UP": "KEYCODE_DPAD_UP",
	"DPAD_DOWN": "KEYCODE_DPAD_DOWN",
	"DPAD_LEFT": "KEYCODE_DPAD_LEFT",
	"DPAD_RIGHT": "KEYCODE_DPAD_RIGHT",
};

const TIMEOUT = 30000;
const MAX_BUFFER_SIZE = 1024 * 1024 * 8;

type AndroidDeviceType = "tv" | "mobile";

export class AndroidRobot implements Robot {

	// `protected` rather than `private` so the agent-backed subclass can address the same device when
	// talking to the in-process agent over `adb forward`.
	public constructor(protected deviceId: string) {
	}

	public adb(...args: string[]): Buffer {
		return execFileSync(getAdbPath(), ["-s", this.deviceId, ...args], {
			maxBuffer: MAX_BUFFER_SIZE,
			timeout: TIMEOUT,
		});
	}

	public silentAdb(...args: string[]): Buffer {
		return execFileSync(getAdbPath(), ["-s", this.deviceId, ...args], {
			maxBuffer: MAX_BUFFER_SIZE,
			timeout: TIMEOUT,
			stdio: ["pipe", "pipe", "pipe"],
		});
	}

	public getSystemFeatures(): string[] {
		return this.adb("shell", "pm", "list", "features")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("feature:"))
			.map(line => line.substring("feature:".length));
	}

	/** Short-lived geometry cache: three adb round trips per read, consulted by every swipe/pinch. */
	private screenSizeCache: { value: ScreenSize; at: number } | null = null;

	/**
	 * The orientation in force when this robot first overrode the display size.
	 *
	 * Restoring "the orientation found at reset time" is not an undo: by then the orientation is
	 * itself a product of the override — a 700x800dp window is portrait whatever the device was —
	 * so a landscape tablet resized to medium and reset came back portrait. Only the orientation
	 * from before the first override is the one the caller had.
	 */
	private orientationBeforeOverride: Orientation | null = null;

	/** Rotation and density changes make cached geometry wrong; those paths call this. */
	protected invalidateScreenSize(): void {
		this.screenSizeCache = null;
	}

	public async getScreenSize(): Promise<ScreenSize> {
		if (this.screenSizeCache && Date.now() - this.screenSizeCache.at < 2000) {
			return this.screenSizeCache.value;
		}
		// The LIVE display size, which is the space every coordinate in this server is expressed in.
		// `wm size` reports the physical, rotation-0 size and does not change when the device turns,
		// so a rotated tablet reported 2560x1600 while its screen was 1600x2560 — putting swipe
		// endpoints and the default pinch centre outside the screen entirely. Measured on the Pixel
		// Tablet emulator in portrait: the pinch centred at 1280,800 on a 1600-wide display.
		const current = this.adb("shell", "dumpsys", "window", "displays").toString().match(/cur=(\d+)x(\d+)/);
		const fallback = this.adb("shell", "wm", "size").toString();
		const physical = fallback.match(/Override size:\s*(\d+)x(\d+)/) ?? fallback.match(/Physical size:\s*(\d+)x(\d+)/);
		const size = current ?? physical;

		if (!size) {
			throw new Error("Failed to get screen size");
		}

		const screenDensity = this.adb("shell", "wm", "density")
			.toString()
			.split(" ")
			.pop();

		const scale = screenDensity ? +screenDensity / 160 : 1;
		const value = { width: Number(size[1]), height: Number(size[2]), scale };
		this.screenSizeCache = { value, at: Date.now() };
		return value;
	}

	public async listApps(): Promise<InstalledApp[]> {
		// only apps that have a launcher activity are returned
		return this.adb("shell", "cmd", "package", "query-activities", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("packageName="))
			.map(line => line.substring("packageName=".length))
			.filter((value, index, self) => self.indexOf(value) === index)
			.map(packageName => ({
				packageName,
				appName: packageName,
			}));
	}

	private async listPackages(): Promise<string[]> {
		return this.adb("shell", "pm", "list", "packages")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("package:"))
			.map(line => line.substring("package:".length));
	}

	public async launchApp(packageName: string, locale?: string): Promise<void> {
		validatePackageName(packageName);

		if (locale) {
			validateLocale(locale);
			try {
				this.silentAdb("shell", "cmd", "locale", "set-app-locales", packageName, "--locales", locale);
			} catch (error) {
				// set-app-locales requires Android 13+ (API 33), silently ignore on older versions
			}
		}

		// `am start -W` on the resolved launcher activity, not `monkey`. monkey grabs the device's
		// single UiAutomation for ~2s around every launch (which is what used to kill concurrent
		// dumps), and -W blocks until the activity is actually launched and drawn, so the caller's
		// next read sees the destination. monkey stays as the fallback for exotic packages whose
		// launcher activity does not resolve.
		try {
			const resolved = this.silentAdb(
				"shell", "cmd", "package", "resolve-activity", "--brief",
				"-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", packageName,
			).toString().trim().split("\n").map(line => line.trim()).filter(Boolean).pop() ?? "";
			if (/^[\w.]+\/[\w.$]+$/.test(resolved)) {
				this.silentAdb("shell", "am", "start", "-W", "-n", resolved);
				return;
			}
		} catch {
			// Fall through to monkey below.
		}

		try {
			this.silentAdb("shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1");
		} catch (error) {
			throw new ActionableError(`Failed launching app with package name "${packageName}", please make sure it exists`);
		}
	}

	public async listRunningProcesses(): Promise<string[]> {
		return this.adb("shell", "ps", "-e")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("u")) // non-system processes
			.map(line => line.split(/\s+/)[8]); // get process name
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		const screenSize = await this.getScreenSize();
		const centerX = screenSize.width >> 1;

		let x0: number, y0: number, x1: number, y1: number;

		switch (direction) {
			case "up":
				x0 = x1 = centerX;
				y0 = Math.floor(screenSize.height * 0.80);
				y1 = Math.floor(screenSize.height * 0.20);
				break;
			case "down":
				x0 = x1 = centerX;
				y0 = Math.floor(screenSize.height * 0.20);
				y1 = Math.floor(screenSize.height * 0.80);
				break;
			case "left":
				x0 = Math.floor(screenSize.width * 0.80);
				x1 = Math.floor(screenSize.width * 0.20);
				y0 = y1 = Math.floor(screenSize.height * 0.50);
				break;
			case "right":
				x0 = Math.floor(screenSize.width * 0.20);
				x1 = Math.floor(screenSize.width * 0.80);
				y0 = y1 = Math.floor(screenSize.height * 0.50);
				break;
			default:
				throw new ActionableError(`Swipe direction "${direction}" is not supported`);
		}

		this.adb("shell", "input", "swipe", `${x0}`, `${y0}`, `${x1}`, `${y1}`, "1000");
	}

	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance?: number): Promise<void> {
		const screenSize = await this.getScreenSize();

		let x0: number, y0: number, x1: number, y1: number;

		// Use provided distance or default to 30% of screen dimension
		const defaultDistanceY = Math.floor(screenSize.height * 0.3);
		const defaultDistanceX = Math.floor(screenSize.width * 0.3);
		const swipeDistanceY = distance || defaultDistanceY;
		const swipeDistanceX = distance || defaultDistanceX;

		switch (direction) {
			case "up":
				x0 = x1 = x;
				y0 = y;
				y1 = Math.max(0, y - swipeDistanceY);
				break;
			case "down":
				x0 = x1 = x;
				y0 = y;
				y1 = Math.min(screenSize.height, y + swipeDistanceY);
				break;
			case "left":
				x0 = x;
				x1 = Math.max(0, x - swipeDistanceX);
				y0 = y1 = y;
				break;
			case "right":
				x0 = x;
				x1 = Math.min(screenSize.width, x + swipeDistanceX);
				y0 = y1 = y;
				break;
			default:
				throw new ActionableError(`Swipe direction "${direction}" is not supported`);
		}

		this.adb("shell", "input", "swipe", `${x0}`, `${y0}`, `${x1}`, `${y1}`, "1000");
	}

	private getDisplayCount(): number {
		return this.adb("shell", "dumpsys", "SurfaceFlinger", "--display-id")
			.toString()
			.split("\n")
			.filter(s => s.startsWith("Display "))
			.length;
	}

	private getFirstDisplayId(): string | null {
		try {
			// Try using cmd display get-displays (Android 11+)
			const displays = this.adb("shell", "cmd", "display", "get-displays")
				.toString()
				.split("\n")
				.filter(s => s.startsWith("Display id "))
				// filter for state ON even though get-displays only returns turned on displays
				.filter(s => s.indexOf(", state ON,") >= 0)
				// another paranoia check
				.filter(s => s.indexOf(", uniqueId ") >= 0);

			if (displays.length > 0) {
				const m = displays[0].match(/uniqueId \"([^\"]+)\"/);
				if (m !== null) {
					let displayId = m[1];
					if (displayId.startsWith("local:")) {
						displayId = displayId.substring("local:".length);
					}

					return displayId;
				}
			}
		} catch (error) {
			// cmd display get-displays not available on this device
		}

		// fallback: parse dumpsys display for display info (compatible with older Android versions)
		try {
			const dumpsys = this.adb("shell", "dumpsys", "display")
				.toString();

			// look for DisplayViewport entries with isActive=true and type=INTERNAL
			const viewportMatch = dumpsys.match(/DisplayViewport\{type=INTERNAL[^}]*isActive=true[^}]*uniqueId='([^']+)'/);
			if (viewportMatch) {
				let uniqueId = viewportMatch[1];
				if (uniqueId.startsWith("local:")) {
					uniqueId = uniqueId.substring("local:".length);
				}

				return uniqueId;
			}

			// fallback: look for active display with state ON
			const displayStateMatch = dumpsys.match(/Display Id=(\d+)[\s\S]*?Display State=ON/);
			if (displayStateMatch) {
				return displayStateMatch[1];
			}
		} catch (error) {
			// dumpsys display also failed
		}

		return null;
	}

	public async getScreenshot(): Promise<Buffer> {
		if (this.getDisplayCount() <= 1) {
			// backward compatibility for android 10 and below, and for single display devices
			return this.adb("exec-out", "screencap", "-p");
		}

		// find the first display that is turned on, and capture that one
		const displayId = this.getFirstDisplayId();
		if (displayId === null) {
			// no idea why, but we have displayCount >= 2, yet we failed to parse
			// let's go with screencap's defaults and hope for the best
			return this.adb("exec-out", "screencap", "-p");
		}

		return this.adb("exec-out", "screencap", "-p", "-d", `${displayId}`);
	}

	private collectElements(node: UiAutomatorXmlNode): ScreenElement[] {
		const elements: Array<ScreenElement> = [];

		if (node.node) {
			if (Array.isArray(node.node)) {
				for (const childNode of node.node) {
					elements.push(...this.collectElements(childNode));
				}
			} else {
				elements.push(...this.collectElements(node.node));
			}
		}

		if (node.text || node["content-desc"] || node.hint || node["resource-id"] || node.checkable === "true" || node.clickable === "true") {
			const element: ScreenElement = {
				type: node.class || "text",
				text: node.text,
				label: node["content-desc"] || node.hint || "",
				rect: this.getScreenElementRect(node),
			};

			if (node.clickable === "true") {
				element.clickable = true;
			}

			if (node.focused === "true") {
				// only provide it if it's true, otherwise don't confuse llm
				element.focused = true;
			}

			const resourceId = node["resource-id"];
			if (resourceId !== null && resourceId !== "") {
				element.identifier = resourceId;
			}

			if (element.rect.width > 0 && element.rect.height > 0) {
				elements.push(element);
			}
		}

		return elements;
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		const parsedXml = await this.getUiAutomatorXml();
		const hierarchy = parsedXml.hierarchy;
		const elements = this.collectElements(hierarchy.node);
		return elements;
	}

	public async terminateApp(packageName: string): Promise<void> {
		validatePackageName(packageName);
		this.adb("shell", "am", "force-stop", packageName);
	}

	public async installApp(path: string): Promise<void> {
		try {
			this.adb("install", "-r", path);
		} catch (error: any) {
			const stdout = error.stdout ? error.stdout.toString() : "";
			const stderr = error.stderr ? error.stderr.toString() : "";
			const output = (stdout + stderr).trim();
			throw new ActionableError(output || error.message);
		}
	}

	public async uninstallApp(bundleId: string): Promise<void> {
		try {
			this.adb("uninstall", bundleId);
		} catch (error: any) {
			const stdout = error.stdout ? error.stdout.toString() : "";
			const stderr = error.stderr ? error.stderr.toString() : "";
			const output = (stdout + stderr).trim();
			throw new ActionableError(output || error.message);
		}
	}

	public async openUrl(url: string): Promise<void> {
		// -W blocks until the resolved activity is launched and drawn, so the caller's next read
		// sees the destination rather than racing the transition.
		this.adb("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", this.escapeShellText(url));
	}

	private isAscii(text: string): boolean {
		return /^[\x00-\x7F]*$/.test(text);
	}

	private escapeShellText(text: string): string {
		// escape all shell special characters that could be used for injection
		return text.replace(/[\\'"` \t\n\r|&;()<>{}[\]$*?]/g, "\\$&");
	}

	private async isDeviceKitInstalled(): Promise<boolean> {
		const packages = await this.listPackages();
		return packages.includes("com.mobilenext.devicekit");
	}

	public async sendKeys(text: string): Promise<void> {
		if (text === "") {
			// bailing early, so we don't run adb shell with empty string.
			// this happens when you prompt with a simple "submit".
			return;
		}

		if (this.isAscii(text)) {
			// adb shell input only supports ascii characters. and
			// some of the keys have to be escaped.
			const _text = this.escapeShellText(text);
			this.adb("shell", "input", "text", _text);
		} else if (await this.isDeviceKitInstalled()) {
			// try sending over clipboard
			const base64 = Buffer.from(text).toString("base64");

			// send clipboard over and immediately paste it
			this.adb("shell", "am", "broadcast", "-a", "devicekit.clipboard.set", "-e", "encoding", "base64", "-e", "text", base64, "-n", "com.mobilenext.devicekit/.ClipboardBroadcastReceiver");
			this.adb("shell", "input", "keyevent", "KEYCODE_PASTE");

			// clear clipboard when we're done
			this.adb("shell", "am", "broadcast", "-a", "devicekit.clipboard.clear", "-n", "com.mobilenext.devicekit/.ClipboardBroadcastReceiver");
		} else {
			throw new ActionableError("Non-ASCII text is not supported on Android, please install mobilenext devicekit, see https://github.com/mobile-next/devicekit-android");
		}
	}

	public async pressButton(button: Button) {
		// Any raw KEYCODE_* passes through, so the tool surface covers the whole Android keymap
		// without this file having to enumerate it. The curated names stay for discoverability.
		const mapped = BUTTON_MAP[button]
			?? (/^KEYCODE_[A-Z0-9_]{1,64}$/.test(button) ? button : undefined);
		if (!mapped) {
			throw new ActionableError(
				`Button "${button}" is not supported. Use one of ${Object.keys(BUTTON_MAP).join(", ")}, `
				+ "or any raw Android KEYCODE_* name."
			);
		}
		this.adb("shell", "input", "keyevent", mapped);
	}

	public async tap(x: number, y: number): Promise<void> {
		this.adb("shell", "input", "tap", `${x}`, `${y}`);
	}

	public async longPress(x: number, y: number, duration: number): Promise<void> {
		// a long press is a swipe with no movement and a long duration
		this.adb("shell", "input", "swipe", `${x}`, `${y}`, `${x}`, `${y}`, `${duration}`);
	}

	public async doubleTap(x: number, y: number): Promise<void> {
		await this.tap(x, y);
		await new Promise(r => setTimeout(r, 100)); // short delay
		await this.tap(x, y);
	}

	/**
	 * The display's geometry at rotation 0.
	 *
	 * On a phone that is portrait, on a tablet it is routinely landscape — which is the whole
	 * reason a rotation number cannot be read as an orientation.
	 */
	private naturalOrientation(): Orientation {
		const match = this.adb("shell", "wm", "size").toString().match(/Physical size:\s*(\d+)x(\d+)/);
		if (!match) {
			return "portrait";
		}
		return Number(match[1]) > Number(match[2]) ? "landscape" : "portrait";
	}

	/**
	 * Rotate the display, then confirm it actually turned.
	 *
	 * `user_rotation` counts quarter turns from the display's NATURAL orientation, so the value
	 * that produces portrait is hardware-dependent: 0 on a phone, 1 on a landscape-native tablet.
	 * Treating it as an absolute orientation silently no-ops on exactly the devices where rotation
	 * matters most — measured on a Pixel Tablet, where requesting portrait wrote rotation 0 and
	 * left the display at 2560x1600 while the tool reported success.
	 *
	 * Verification is part of the contract rather than a nicety: a caller that screenshots or dumps
	 * straight after this call would otherwise capture the pre-rotation layout.
	 */
	public async setOrientation(orientation: Orientation): Promise<void> {
		this.invalidateScreenSize();
		const value = this.naturalOrientation() === orientation ? 0 : 1;

		// disable auto-rotation prior to setting the orientation
		this.adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
		// `settings put`, not upstream's `content insert` incantation: measured on the API 37
		// emulator (2026-08-28), the content-provider write silently no-ops while `settings put`
		// rotates the display within two seconds.
		this.adb("shell", "settings", "put", "system", "user_rotation", String(value));

		// 8s, not 5: an emulator on software GL animates a rotation in whole seconds, and a
		// deadline the hardware occasionally misses turns a working rotation into a flaky error.
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			if (await this.getOrientation() === orientation) {
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 150));
		}
		throw new ActionableError(
			`The display did not rotate to ${orientation}. The foreground activity may pin its own `
			+ "orientation, or the device may be in a mode that blocks rotation."
		);
	}

	/**
	 * Current orientation, measured rather than inferred.
	 *
	 * The window manager's live display size is the authoritative answer; `user_rotation` is
	 * meaningless without knowing the natural orientation, and is stale whenever an app pinned a
	 * rotation of its own.
	 */
	public async getOrientation(): Promise<Orientation> {
		const current = this.adb("shell", "dumpsys", "window", "displays").toString().match(/cur=(\d+)x(\d+)/);
		if (current) {
			return Number(current[1]) > Number(current[2]) ? "landscape" : "portrait";
		}
		const size = this.adb("shell", "wm", "size").toString().match(/Override size:\s*(\d+)x(\d+)/)
			?? this.adb("shell", "wm", "size").toString().match(/Physical size:\s*(\d+)x(\d+)/);
		return size && Number(size[1]) > Number(size[2]) ? "landscape" : "portrait";
	}

	// -------------------------------------------------------------------------
	// Window size class
	//
	// The server reported pixels and density and left the arithmetic — and the breakpoint table —
	// to the caller, which is the step that gets skipped. A caller who cannot name the band cannot
	// tell a passing screenshot from one taken in the wrong window.
	// -------------------------------------------------------------------------

	/**
	 * The window's geometry in the units adaptive code reasons in.
	 *
	 * dp comes from `am get-config`, which is the configuration Android itself resolves resource
	 * qualifiers and `LocalConfiguration` against — the same numbers the app under test branches
	 * on. Dividing display pixels by density can disagree with it, because the configuration
	 * accounts for insets the raw display size does not; that derivation is the fallback for a
	 * configuration that cannot be parsed, never for one that could not be read.
	 *
	 * This describes the default display. An app in split-screen or freeform occupies less than
	 * this, and no adb surface reports that window's dp without the in-process agent.
	 */
	public async getWindowMetrics(): Promise<WindowMetrics> {
		// Deliberately past the geometry cache. Pixels and dp come from two different adb reads,
		// and pairing a cached pixel size with a fresh configuration reports a window that does not
		// exist: measured mid-resize as 2560x824px alongside 412x1280dp, one landscape and one
		// portrait. This is a diagnostic call, not the swipe hot path, so it pays for the round trip.
		this.invalidateScreenSize();
		const screen = await this.getScreenSize();

		// `am get-config` is polled hardest immediately after a resize, which is exactly when the
		// activity manager is rebuilding every activity — measured failing there on the
		// software-rendered tablet AVD. One retry absorbs that; a second failure is rethrown rather
		// than swallowed, because the other reason this call fails is that the device has gone, and
		// quietly substituting a derived number would report a window that no longer exists.
		let config: string;
		try {
			config = this.adb("shell", "am", "get-config").toString();
		} catch {
			await new Promise(resolve => setTimeout(resolve, 500));
			config = this.adb("shell", "am", "get-config").toString();
		}

		const parse = (pattern: RegExp): number | null => {
			const value = Number(config.match(pattern)?.[1]);
			return Number.isFinite(value) && value > 0 ? value : null;
		};

		const widthDp = parse(/-w(\d+)dp\b/) ?? Math.round(screen.width / screen.scale);
		const heightDp = parse(/-h(\d+)dp\b/) ?? Math.round(screen.height / screen.scale);

		return {
			widthPx: screen.width,
			heightPx: screen.height,
			density: Math.round(screen.scale * 160),
			widthDp,
			heightDp,
			smallestWidthDp: parse(/-sw(\d+)dp\b/) ?? Math.min(widthDp, heightDp),
			widthClass: widthClassFor(widthDp),
			heightClass: heightClassFor(heightDp),
		};
	}

	/**
	 * Override the display size so the window lands in a chosen size class, then prove it did.
	 *
	 * `wm size` does not resize the current window — it redefines the display's NATURAL frame, and
	 * the live window is that frame turned by whatever `user_rotation` holds. Writing a size
	 * therefore silently changes what an already-written rotation means. Measured on the Pixel
	 * Tablet AVD, 2026-09-03: with a 1400x1600 override, `user_rotation 1` gave landscape
	 * (cur=1600x1400); after `wm size reset` the same unchanged `1` gave portrait (cur=1600x2560).
	 * Screenshots keep working across that flip, so a caller who resizes and then captures gets a
	 * window in the band it asked for only by luck.
	 *
	 * So the rotation is pinned to 0 rather than preserved: with the frame and the window aligned,
	 * the pair written is the pair that appears. Orientation becomes a consequence of the requested
	 * dp — a window taller than it is wide is portrait — and the caller changes it afterwards if it
	 * wants the other one. The result is read back from the window manager, never assumed.
	 */
	public async setWindowSize(request: WindowSizeRequest): Promise<WindowMetrics> {
		if (request !== "reset" && this.orientationBeforeOverride === null) {
			this.orientationBeforeOverride = await this.getOrientation();
		}

		if (request === "reset") {
			this.adb("shell", "wm", "size", "reset");
		} else {
			const { scale } = await this.getScreenSize();
			const px = (dp: number): number => Math.round(dp * scale);
			this.adb("shell", "wm", "size", `${px(request.widthDp)}x${px(request.heightDp)}`);
		}

		this.adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
		this.adb("shell", "settings", "put", "system", "user_rotation", "0");
		this.invalidateScreenSize();

		const target = request === "reset" ? null : widthClassFor(request.widthDp);
		const settled = (metrics: WindowMetrics): boolean => target === null
			// A reset is done when the override is gone, which the window manager reports by
			// dropping the `base=` frame it was holding — not by any value the metrics can show.
			? !this.adb("shell", "dumpsys", "window", "displays").toString().includes("base=")
			: metrics.widthClass === target;

		// The window manager re-lays out asynchronously, and on a software-rendered emulator that
		// takes whole seconds; reading straight back reports the pre-resize window as a success.
		const deadline = Date.now() + 8000;
		let metrics = await this.getWindowMetrics();
		while (!settled(metrics) && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 200));
			this.invalidateScreenSize();
			metrics = await this.getWindowMetrics();
		}

		if (!settled(metrics)) {
			throw new ActionableError(
				request === "reset"
					? "The display size override was not cleared."
					: `The display did not resize to ${request.widthDp}x${request.heightDp}dp `
						+ `(wanted width class ${target}, got ${metrics.widthDp}dp / `
						+ `${metrics.widthClass}). The device may refuse override sizes outside the `
						+ "range reported as `rng=` by `adb shell dumpsys window displays`."
			);
		}

		// A reset undoes the size and nothing else. Pinning the rotation above was the only way to
		// read the cleared frame honestly, but leaving the device turned would make "reset" change
		// something the caller never asked about. An explicit size gets no such restore: a pair
		// taller than it is wide IS a request for portrait.
		//
		// With nothing remembered — a fresh server, or a robot evicted when the device dropped off
		// adb — the pinned rotation 0 leaves the display in its natural orientation, which is the
		// honest answer to "put it back" when there is no record of what "back" was.
		if (request === "reset") {
			const restore = this.orientationBeforeOverride;
			this.orientationBeforeOverride = null;
			if (restore !== null && await this.getOrientation() !== restore) {
				await this.setOrientation(restore);
				this.invalidateScreenSize();
				return this.getWindowMetrics();
			}
		}
		return metrics;
	}

	private async getUiAutomatorDump(): Promise<string> {
		let lastDump = "";
		for (let tries = 0; tries < 10; tries++) {
			if (tries > 0) {
				// The connection holder is usually transient — `monkey` keeps UiAutomation for a
				// couple of seconds around an app launch. Ten instant retries all land inside that
				// window and fail as one; spaced retries outlive it.
				await new Promise(resolve => setTimeout(resolve, 250));
			}
			const dump = this.adb("exec-out", "uiautomator", "dump", "/dev/tty").toString();
			lastDump = dump;
			if (dump.includes("null root node returned by UiTestAutomationBridge")) {
				continue;
			}

			const start = dump.indexOf("<?xml");
			if (start < 0) {
				// Not XML at all. The dominant cause is UiAutomation contention: only one connection
				// exists per device, so while the in-process agent holds it `uiautomator dump` is
				// killed outright and prints "Killed". Returning the text unchecked produced a
				// `hierarchy.node` TypeError several layers away, which named neither the cause nor
				// the fix.
				continue;
			}
			return dump.substring(start);
		}

		const killed = lastDump.trim().startsWith("Killed") || lastDump.includes("UiAutomation not connected");
		throw new ActionableError(
			killed
				? "uiautomator dump was killed, which means something else holds this device's single "
				+ "UiAutomation connection — normally the in-process agent. Stop it before using the "
				+ `adb path: adb shell am force-stop ${resolveAgentIdentity().testPackage}`
				: `Failed to get UIAutomator XML. Device returned: ${JSON.stringify(lastDump.slice(0, 200))}`
		);
	}

	private async getUiAutomatorXml(): Promise<UiAutomatorXml> {
		const dump = await this.getUiAutomatorDump();
		const parser = new xml.XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "",
		});

		const parsed = parser.parse(dump) as UiAutomatorXml;
		if (!parsed?.hierarchy?.node) {
			throw new ActionableError(
				"uiautomator returned a document with no node hierarchy. The screen may have been "
				+ "mid-transition; retry, or use the in-process agent which reads the live tree."
			);
		}
		return parsed;
	}

	private getScreenElementRect(node: UiAutomatorXmlNode): ScreenElementRect {
		const bounds = String(node.bounds);

		const [, left, top, right, bottom] = bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.map(Number) || [];
		return {
			x: left,
			y: top,
			width: right - left,
			height: bottom - top,
		};
	}
}

export class AndroidDeviceManager {

	private getDeviceType(name: string): AndroidDeviceType {
		try {
			const device = new AndroidRobot(name);
			const features = device.getSystemFeatures();
			if (features.includes("android.software.leanback") || features.includes("android.hardware.type.television")) {
				return "tv";
			}
			return "mobile";
		} catch (error) {
			// Fallback to mobile if we cannot determine device type
			return "mobile";
		}
	}

	private getDeviceVersion(deviceId: string): string {
		try {
			const output = execFileSync(getAdbPath(), ["-s", deviceId, "shell", "getprop", "ro.build.version.release"], {
				timeout: 5000,
			}).toString().trim();
			return output;
		} catch (error) {
			return "unknown";
		}
	}

	private getDeviceName(deviceId: string): string {
		try {
			// Try getting AVD name first (for emulators)
			const avdName = execFileSync(getAdbPath(), ["-s", deviceId, "shell", "getprop", "ro.boot.qemu.avd_name"], {
				timeout: 5000,
			}).toString().trim();

			if (avdName !== "") {
				// Replace underscores with spaces (e.g., "Pixel_9_Pro" -> "Pixel 9 Pro")
				return avdName.replace(/_/g, " ");
			}

			// Fall back to product model
			const output = execFileSync(getAdbPath(), ["-s", deviceId, "shell", "getprop", "ro.product.model"], {
				timeout: 5000,
			}).toString().trim();
			return output;
		} catch (error) {
			return deviceId;
		}
	}

	public getConnectedDevices(): AndroidDevice[] {
		try {
			const names = execFileSync(getAdbPath(), ["devices"])
				.toString()
				.split("\n")
				.map(line => line.trim())
				.filter(line => line !== "")
				.filter(line => !line.startsWith("List of devices attached"))
				.filter(line => line.split("\t")[1]?.trim() === "device")  // Only include devices that are online and ready
				.map(line => line.split("\t")[0]);

			return names.map(name => ({
				deviceId: name,
				deviceType: this.getDeviceType(name),
			}));
		} catch (error) {
			console.error("Could not execute adb command, maybe ANDROID_HOME is not set?");
			return [];
		}
	}

	public getConnectedDevicesWithDetails(): Array<AndroidDevice & { version: string, name: string }> {
		try {
			const names = execFileSync(getAdbPath(), ["devices"])
				.toString()
				.split("\n")
				.map(line => line.trim())
				.filter(line => line !== "")
				.filter(line => !line.startsWith("List of devices attached"))
				.filter(line => line.split("\t")[1]?.trim() === "device")  // Only include devices that are online and ready
				.map(line => line.split("\t")[0]);

			return names.map(deviceId => ({
				deviceId,
				deviceType: this.getDeviceType(deviceId),
				version: this.getDeviceVersion(deviceId),
				name: this.getDeviceName(deviceId),
			}));
		} catch (error) {
			console.error("Could not execute adb command, maybe ANDROID_HOME is not set?");
			return [];
		}
	}
}
