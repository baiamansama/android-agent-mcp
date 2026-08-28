import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildProcess, spawn, execFileSync } from "node:child_process";

import { error, trace } from "./logger";
import { AndroidDeviceManager, getAdbPath } from "./android";
import { AgentAndroidRobot, ElementSelector, computeCompactDiff, describeSelector, formatCompactElementLines } from "./automation";
import { AGENT_IDENTITY, agentStartHint } from "./agent";
import { ActionableError } from "./robot";
import { PNG } from "./png";
import { isScalingAvailable, Image } from "./image-utils";
import { validateOutputPath, validateFileExtension } from "./utils";

const ALLOWED_SCREENSHOT_EXTENSIONS = [".png", ".jpg", ".jpeg"];
const ALLOWED_RECORDING_EXTENSIONS = [".mp4"];

interface DeviceSummary {
	id: string;
	name: string;
	platform: "android" | "ios";
	type: "real" | "emulator" | "simulator";
	version: string;
	state: "online" | "offline";
}

interface DevicesResponse {
	devices: DeviceSummary[];
}

interface ActiveRecording {
	process: ChildProcess;
	outputPath: string;
	remotePath: string;
	startedAt: number;
}

export const getAgentVersion = (): string => {
	const json = require("../package.json");
	return json.version;
};

// ---------------------------------------------------------------------------
// Device resolution
// ---------------------------------------------------------------------------

let deviceListCache: { ids: string[]; at: number } | null = null;

/** Test hook: the 5s cache would otherwise leak one scenario's device list into the next. */
export const resetDeviceListCacheForTests = (): void => {
	deviceListCache = null;
};

const connectedDeviceIds = (): string[] => {
	if (deviceListCache && Date.now() - deviceListCache.at < 5000) {
		return deviceListCache.ids;
	}
	const ids = execFileSync(getAdbPath(), ["devices"], { timeout: 10000 })
		.toString()
		.split("\n")
		.map(line => line.trim())
		.filter(line => line !== "" && !line.startsWith("List of devices attached"))
		.filter(line => line.split("\t")[1]?.trim() === "device")
		.map(line => line.split("\t")[0]);
	deviceListCache = { ids, at: Date.now() };
	return ids;
};

/**
 * Resolve the target device, defaulting to the only one connected.
 *
 * Requiring an explicit id on every call made each session open with a list-devices round trip
 * whose answer was already determined — this rig connects one device at a time in the normal
 * case. Ambiguity still fails loudly: with several devices online, guessing would race whichever
 * one the caller actually meant.
 */
export const resolveDeviceId = (supplied?: string): string => {
	if (supplied) {
		return supplied;
	}
	const ids = connectedDeviceIds();
	if (ids.length === 1) {
		return ids[0];
	}
	if (ids.length === 0) {
		throw new ActionableError("No Android device or emulator is connected (adb devices lists none). Boot one, then retry.");
	}
	throw new ActionableError(`Multiple devices are connected: ${ids.join(", ")}. Pass device explicitly.`);
};

export const createMcpServer = (): McpServer => {

	const server = new McpServer({
		name: "mobile-mcp",
		version: getAgentVersion(),
	});


	type ZodSchemaShape = Record<string, z.ZodType>;

	interface ToolAnnotations {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
	}

	/**
	 * One in-flight tool call per device.
	 *
	 * The client is allowed to issue tool calls in parallel (Claude Code does), but both transports
	 * assume serial use: the on-device agent is a single-threaded accept loop, and a probe ping
	 * that queues behind a long-running op times out and reads as a dead agent — which used to
	 * demote the transport, kill concurrent dumps, and occasionally force-stop the app mid-session.
	 * Serializing per device removes the whole class while leaving different devices concurrent.
	 */
	const deviceQueues = new Map<string, Promise<unknown>>();

	const withDeviceLock = <T>(deviceId: string, fn: () => Promise<T>): Promise<T> => {
		const previous = deviceQueues.get(deviceId) ?? Promise.resolve();
		const run = previous.then(fn, fn);
		deviceQueues.set(deviceId, run.catch(() => undefined));
		return run;
	};

	const tool = (name: string, title: string, description: string, paramsSchema: ZodSchemaShape, annotations: ToolAnnotations, cb: (args: any) => Promise<string>) => {
		server.registerTool(name, {
			title,
			description,
			inputSchema: paramsSchema,
			annotations,
		}, (async (args: any, _extra: any) => {
			let resolvedDevice: string | undefined;
			try {
				trace(`Invoking ${name} with args: ${JSON.stringify(args)}`);
				let response: string;
				if ("device" in paramsSchema) {
					resolvedDevice = resolveDeviceId(args?.device);
					const resolvedArgs = { ...args, device: resolvedDevice };
					response = await withDeviceLock(resolvedDevice, () => cb(resolvedArgs));
				} else {
					response = await cb(args);
				}
				trace(`=> ${response}`);
				return {
					content: [{ type: "text", text: response }],
				};
			} catch (error: any) {
				evictRobotIfGone(resolvedDevice ?? args?.device, error?.message ?? "");
				if (error instanceof ActionableError) {
					return {
						content: [{ type: "text", text: `${error.message}. Please fix the issue and try again.` }],
					};
				} else {
					// a real exception
					trace(`Tool '${description}' failed: ${error.message} stack: ${error.stack}`);
					return {
						content: [{ type: "text", text: `Error: ${error.message}` }],
						isError: true,
					};
				}
			}
		}) as any);
	};

	/** Shared device parameter: optional, resolved by [resolveDeviceId]. */
	const deviceParam = () => z.string().optional().describe("Device id. Omit when exactly one device is connected; see mobile_list_available_devices.");

	const activeRecordings = new Map<string, ActiveRecording>();
	const watchers = new Map<string, ChildProcess>();

	/**
	 * One robot per device for the life of the server.
	 *
	 * The robot is where all the warmth lives: the agent liveness TTL, the launch cooldown, the
	 * `adb forward` flag, the element cache, and the last-seen foreground. Constructing a fresh
	 * robot per tool call — the upstream shape — silently reset every one of those, so each call
	 * re-ran `adb devices`, re-established the forward, re-probed the agent, and worst of all
	 * re-spawned `am instrument` with a fresh cooldown whenever the test APK was missing. The
	 * result was ~100ms of avoidable latency per call on the happy path and multi-second stalls
	 * on the unhappy one.
	 */
	const robots = new Map<string, AgentAndroidRobot>();

	const getRobot = (deviceId: string): AgentAndroidRobot => {
		const existing = robots.get(deviceId);
		if (existing) {
			return existing;
		}
		// resolveDeviceId consulted `adb devices` moments ago; membership is the whole check.
		if (!connectedDeviceIds().includes(deviceId)) {
			throw new ActionableError(`Device "${deviceId}" is not connected. Use mobile_list_available_devices to see connected Android devices.`);
		}
		const robot = new AgentAndroidRobot(deviceId);
		robots.set(deviceId, robot);
		return robot;
	};

	/** A device that dropped off adb must not pin a stale robot in the memo. */
	const evictRobotIfGone = (deviceId: string | undefined, message: string): void => {
		if (deviceId && /device .* not found|device offline|no devices\/emulators found|is not connected/i.test(message)) {
			robots.delete(deviceId);
			deviceListCache = null;
		}
	};

	const isEmulator = (deviceId: string): boolean => {
		if (deviceId.startsWith("emulator-")) {
			return true;
		}
		try {
			return execFileSync(getAdbPath(), ["-s", deviceId, "shell", "getprop", "ro.kernel.qemu"], { timeout: 5000 })
				.toString().trim() === "1";
		} catch {
			return false;
		}
	};

	tool(
		"mobile_list_available_devices",
		"List Devices",
		"List connected Android devices and emulators. This fork is Android-only. Rarely needed: every other tool resolves the device automatically when exactly one is connected.",
		{},
		{ readOnlyHint: true },
		async ({}) => {
			const androidManager = new AndroidDeviceManager();
			const devices: DeviceSummary[] = [];

			const androidDevices = androidManager.getConnectedDevicesWithDetails();
			for (const device of androidDevices) {
				devices.push({
					id: device.deviceId,
					name: device.name,
					platform: "android",
					type: isEmulator(device.deviceId) ? "emulator" : "real",
					version: device.version,
					state: "online",
				});
			}

			const out: DevicesResponse = { devices };
			return JSON.stringify(out);
		}
	);

	tool(
		"mobile_list_apps",
		"List Apps",
		"List all the installed apps on the device",
		{
			device: deviceParam(),
		},
		{ readOnlyHint: true },
		async ({ device }) => {
			const robot = getRobot(device);
			const result = await robot.listApps();
			return `Found these apps on device: ${result.map(app => `${app.appName} (${app.packageName})`).join(", ")}`;
		}
	);

	tool(
		"mobile_launch_app",
		"Launch App",
		"Launch an app on mobile device. Use this to open a specific app. You can find the package name of the app by calling list_apps_on_device.",
		{
			device: deviceParam(),
			packageName: z.string().describe("The package name of the app to launch"),
			locale: z.string().optional().describe("Comma-separated BCP 47 locale tags to launch the app with (e.g., fr-FR,en-GB)"),
		},
		{ destructiveHint: true },
		async ({ device, packageName, locale }) => {
			const robot = getRobot(device);
			await robot.launchApp(packageName, locale);
			// Returning the moment the start command exits is why callers followed every launch with
			// a sleep and still screenshotted the previous screen. Wait for the window to be in front.
			const visible = await robot.waitForForeground(packageName, 15000);
			return JSON.stringify(await robot.envelope({
				launched: packageName,
				foregroundConfirmed: visible,
			}));
		}
	);

	tool(
		"mobile_terminate_app",
		"Terminate App",
		"Stop and terminate an app on mobile device",
		{
			device: deviceParam(),
			packageName: z.string().describe("The package name of the app to terminate"),
		},
		{ destructiveHint: true },
		async ({ device, packageName }) => {
			const robot = getRobot(device);
			await robot.terminateApp(packageName);
			return `Terminated app ${packageName}`;
		}
	);

	tool(
		"mobile_install_app",
		"Install App",
		"Install an app on mobile device",
		{
			device: deviceParam(),
			path: z.string().describe("The path to the .apk file to install"),
		},
		{ destructiveHint: true },
		async ({ device, path }) => {
			const robot = getRobot(device);
			await robot.installApp(path);
			// Installing either APK kills the instrumentation the agent runs in. Clearing the launch
			// backoff here is the difference between the next call being on the fast path and the
			// session silently finishing on adb.
			robot.invalidateAgent();
			const transport = await robot.transport();
			return `Installed app from ${path} (agent transport: ${transport})`;
		}
	);

	tool(
		"mobile_uninstall_app",
		"Uninstall App",
		"Uninstall an app from mobile device",
		{
			device: deviceParam(),
			bundle_id: z.string().describe("Package name of the app to be uninstalled"),
		},
		{ destructiveHint: true },
		async ({ device, bundle_id }) => {
			const robot = getRobot(device);
			await robot.uninstallApp(bundle_id);
			return `Uninstalled app ${bundle_id}`;
		}
	);

	tool(
		"mobile_get_screen_size",
		"Get Screen Size",
		"Get the screen size of the mobile device in pixels",
		{
			device: deviceParam(),
		},
		{ readOnlyHint: true },
		async ({ device }) => {
			const robot = getRobot(device);
			const screenSize = await robot.getScreenSize();
			return `Screen size is ${screenSize.width}x${screenSize.height} pixels`;
		}
	);

	tool(
		"mobile_click_on_screen_at_coordinates",
		"Click Screen",
		"Click on the screen at given x,y coordinates. If clicking on an element, use the list_elements_on_screen tool to find the coordinates.",
		{
			device: deviceParam(),
			x: z.coerce.number().describe("The x coordinate to click on the screen, in pixels"),
			y: z.coerce.number().describe("The y coordinate to click on the screen, in pixels"),
		},
		{ destructiveHint: true },
		async ({ device, x, y }) => {
			const robot = getRobot(device);
			await robot.tap(x, y);
			return `Clicked on screen at coordinates: ${x}, ${y}`;
		}
	);

	tool(
		"mobile_double_tap_on_screen",
		"Double Tap Screen",
		"Double-tap on the screen at given x,y coordinates. Through the in-process agent both taps are injected inside the platform's double-tap window; over adb the two taps land too far apart and may register as two singles.",
		{
			device: deviceParam(),
			x: z.coerce.number().describe("The x coordinate to double-tap, in pixels"),
			y: z.coerce.number().describe("The y coordinate to double-tap, in pixels"),
		},
		{ destructiveHint: true },
		async ({ device, x, y }) => {
			const robot = getRobot(device);
			await robot.doubleTap(x, y);
			return `Double-tapped on screen at coordinates: ${x}, ${y}`;
		}
	);

	tool(
		"mobile_long_press_on_screen_at_coordinates",
		"Long Press Screen",
		"Long press on the screen at given x,y coordinates. If long pressing on an element, use the list_elements_on_screen tool to find the coordinates.",
		{
			device: deviceParam(),
			x: z.coerce.number().describe("The x coordinate to long press on the screen, in pixels"),
			y: z.coerce.number().describe("The y coordinate to long press on the screen, in pixels"),
			duration: z.coerce.number().min(1).max(10000).optional().describe("Duration of the long press in milliseconds. Defaults to 500ms."),
		},
		{ destructiveHint: true },
		async ({ device, x, y, duration }) => {
			const robot = getRobot(device);
			const pressDuration = duration ?? 500;
			await robot.longPress(x, y, pressDuration);
			return `Long pressed on screen at coordinates: ${x}, ${y} for ${pressDuration}ms`;
		}
	);

	tool(
		"mobile_list_elements_on_screen",
		"List Screen Elements",
		"The screen as a compact semantic tree: one element per line — `#test-tag \"text\" (label) Type @x,y wxh clickable scrollable hidden`. Prefer this over screenshots; it is faster and cheaper, and the #tags feed mobile_tap_on_element directly. `hidden` marks nodes present but not visible to the user (agent transport only) — never plan a tap on one. The header reports `transport` (agent = live in-process tree; adb = XML dump without visibility) and `foreground` — if foreground is not the app you expect, the tree belongs to something else. diff:true returns only lines added (+) and removed (-) since the previous list call, which is much cheaper after a small change. Do not cache this result.",
		{
			device: deviceParam(),
			filter: z.enum(["all", "interactive"]).optional().describe("interactive returns only clickable/focused elements and named fields — the actionable subset. Default all."),
			verbose: z.boolean().optional().describe("Return the legacy JSON element objects instead of compact lines. Costs roughly 3x the tokens."),
			diff: z.boolean().optional().describe("Return only the change against the previous list call: `+` added lines, `-` removed lines. Falls back to the full tree when there is no baseline."),
		},
		{ readOnlyHint: true },
		async ({ device, filter, verbose, diff }) => {
			const robot = getRobot(device);
			let elements = await robot.getElementsOnScreen();
			const total = elements.length;
			if (filter === "interactive") {
				elements = elements.filter(e => e.clickable || e.focused || e.identifier);
			}

			if (verbose) {
				const result = elements.map(element => {
					const out: any = {
						type: element.type,
						text: element.text,
						label: element.label,
						name: element.name,
						value: element.value,
						identifier: element.identifier,
						coordinates: {
							x: element.rect.x,
							y: element.rect.y,
							width: element.rect.width,
							height: element.rect.height,
						},
					};
					if (element.focused) {
						out.focused = true;
					}
					if (element.visible !== undefined) {
						out.visible = element.visible;
					}
					if (element.scrollable) {
						out.scrollable = true;
					}
					return out;
				});
				robot.lastCompactLines = formatCompactElementLines(elements);
				return JSON.stringify(await robot.envelope({ count: result.length, total, elements: result }));
			}

			const lines = formatCompactElementLines(elements);
			const baseline = robot.lastCompactLines;
			robot.lastCompactLines = lines;

			if (diff && baseline) {
				const delta = computeCompactDiff(baseline, lines);
				const body = [
					...delta.added.map(line => `+ ${line}`),
					...delta.removed.map(line => `- ${line}`),
				].join("\n");
				// A diff only earns its keep when the change is small. After a navigation the whole
				// screen turns over and added+removed exceeds the plain tree — serve the smaller one.
				if (body.length < lines.join("\n").length) {
					const header = await robot.envelope({
						diffAgainstPreviousList: true,
						added: delta.added.length,
						removed: delta.removed.length,
						unchanged: delta.unchanged,
						count: elements.length,
						total,
					});
					return `${JSON.stringify(header)}\n${body || "(no changes since the previous list)"}`;
				}
				const fullHeader = await robot.envelope({
					diffFellBackToFull: true,
					count: elements.length,
					total,
				});
				return `${JSON.stringify(fullHeader)}\n${lines.join("\n")}`;
			}

			const header = await robot.envelope({ count: elements.length, total });
			return `${JSON.stringify(header)}\n${lines.join("\n")}`;
		}
	);

	tool(
		"mobile_press_button",
		"Press Button",
		"Press a button on device",
		{
			device: deviceParam(),
			button: z.string().describe("The button to press: BACK, HOME, APP_SWITCH, POWER, WAKEUP, MENU, VOLUME_UP, VOLUME_DOWN, ENTER, TAB, DELETE, ESCAPE, PAGE_UP, PAGE_DOWN, MEDIA_PLAY_PAUSE, MEDIA_NEXT, MEDIA_PREVIOUS, DPAD_* — or any raw Android KEYCODE_* name for the rest of the keymap"),
		},
		{ destructiveHint: true },
		async ({ device, button }) => {
			const robot = getRobot(device);
			await robot.pressButton(button);
			return `Pressed the button: ${button}`;
		}
	);

	tool(
		"mobile_open_url",
		"Open URL",
		"Open a URL in browser on device",
		{
			device: deviceParam(),
			url: z.string().describe("The URL to open"),
		},
		{ destructiveHint: true },
		async ({ device, url }) => {
			const allowUnsafeUrls = process.env.MOBILEMCP_ALLOW_UNSAFE_URLS === "1";
			if (!allowUnsafeUrls && !url.startsWith("http://") && !url.startsWith("https://")) {
				throw new ActionableError("Only http:// and https:// URLs are allowed. Set MOBILEMCP_ALLOW_UNSAFE_URLS=1 to allow other URL schemes.");
			}

			const robot = getRobot(device);
			await robot.openUrl(url);
			return `Opened URL: ${url}`;
		}
	);

	tool(
		"mobile_swipe_on_screen",
		"Swipe Screen",
		"Swipe on the screen. Direction is FINGER direction: swiping up scrolls the content down.",
		{
			device: deviceParam(),
			direction: z.enum(["up", "down", "left", "right"]).describe("The direction the finger moves"),
			x: z.coerce.number().optional().describe("The x coordinate to start the swipe from, in pixels. If not provided, uses center of screen"),
			y: z.coerce.number().optional().describe("The y coordinate to start the swipe from, in pixels. If not provided, uses center of screen"),
			distance: z.coerce.number().optional().describe("The distance to swipe in pixels. Defaults to 30% of the screen dimension"),
		},
		{ destructiveHint: true },
		async ({ device, direction, x, y, distance }) => {
			const robot = getRobot(device);

			if (x !== undefined && y !== undefined) {
				// Use coordinate-based swipe
				await robot.swipeFromCoordinate(x, y, direction, distance);
				const distanceText = distance ? ` ${distance} pixels` : "";
				return `Swiped ${direction}${distanceText} from coordinates: ${x}, ${y}`;
			} else {
				// Use center-based swipe
				await robot.swipe(direction);
				return `Swiped ${direction} on screen`;
			}
		}
	);

	tool(
		"mobile_type_keys",
		"Type Text",
		"Type text into the focused field, appending at the cursor — Unicode-safe (Arabic, Cyrillic, Uzbek ʻ) through the in-process agent; ASCII-only over bare adb. To replace a field's contents, use mobile_set_text instead.",
		{
			device: deviceParam(),
			text: z.string().describe("The text to type"),
			submit: z.boolean().describe("Whether to submit the text. If true, the text will be submitted as if the user pressed the enter key."),
		},
		{ destructiveHint: true },
		async ({ device, text, submit }) => {
			const robot = getRobot(device);
			await robot.sendKeys(text);

			if (submit) {
				await robot.pressButton("ENTER");
			}

			return `Typed text: ${text}`;
		}
	);

	tool(
		"mobile_save_screenshot",
		"Save Screenshot",
		"Save a full-resolution screenshot of the mobile device to a file",
		{
			device: deviceParam(),
			saveTo: z.string().describe("The path to save the screenshot to. Filename must end with .png, .jpg, or .jpeg"),
		},
		{ destructiveHint: true },
		async ({ device, saveTo }) => {
			validateFileExtension(saveTo, ALLOWED_SCREENSHOT_EXTENSIONS, "save_screenshot");
			validateOutputPath(saveTo);

			const robot = getRobot(device);

			// Native resolution, PNG: a saved artifact is for close inspection, not token economy.
			const shot = await robot.screenshotWithSize({ format: "png" });
			fs.writeFileSync(saveTo, shot.buffer);
			return `Screenshot saved to: ${saveTo} (${shot.width}x${shot.height})`;
		}
	);

	server.registerTool(
		"mobile_take_screenshot",
		{
			title: "Take Screenshot",
			description: "Screenshot, downscaled and compressed on the device for token economy. This is the fallback, not the default: mobile_list_elements_on_screen answers \"what is on screen\" faster and cheaper, and its #tags feed the element tools directly. Reach for pixels only when layout, imagery or rendering itself is the question. Do not cache this result.",
			inputSchema: {
				device: deviceParam(),
				maxWidth: z.coerce.number().min(240).max(2400).optional().describe("Longest acceptable image width in pixels. Default: device width divided by display scale, floored at 480 for legibility."),
				quality: z.coerce.number().min(30).max(100).optional().describe("JPEG quality. Default 75."),
			},
			annotations: {
				readOnlyHint: true,
			},
		},
		async ({ device, maxWidth, quality }) => {
			try {
				const deviceId = resolveDeviceId(device);
				return await withDeviceLock(deviceId, async () => {
					const robot = getRobot(deviceId);
					const screenSize = await robot.getScreenSize();

					// Downscale target: dp width by default (device px / scale), floored for legibility.
					// On a 480dpi phone the raw dp width is 360px, at which Arabic UI text stops being
					// readable — the floor keeps the image useful while still ~4x cheaper than native.
					const targetWidth = Math.min(
						screenSize.width,
						Math.max(maxWidth ?? Math.floor(screenSize.width / screenSize.scale), 480),
					);

					// Through the agent the device itself scales and JPEG-encodes (~20-40KB on the
					// wire); over adb the buffer is native PNG and the host scales below.
					const shot = await robot.screenshotWithSize({ maxWidth: targetWidth, quality: quality ?? 75 });
					let screenshot = shot.buffer;
					let mimeType = shot.format === "jpeg" ? "image/jpeg" : "image/png";
					let returnedWidth = shot.width;

					if (shot.format === "png") {
						// adb path: validate we received a png, will throw exception otherwise
						const image = new PNG(screenshot);
						const pngSize = image.getDimensions();
						if (pngSize.width <= 0 || pngSize.height <= 0) {
							throw new ActionableError("Screenshot is invalid. Please try again.");
						}
						returnedWidth = pngSize.width;

						if (isScalingAvailable() && targetWidth < pngSize.width) {
							trace("Image scaling is available, resizing screenshot");
							const beforeSize = screenshot.length;
							screenshot = Image.fromBuffer(screenshot)
								.resize(targetWidth)
								.jpeg({ quality: quality ?? 75 })
								.toBuffer();
							trace(`Screenshot resized from ${beforeSize} bytes to ${screenshot.length} bytes`);
							mimeType = "image/jpeg";
							returnedWidth = targetWidth;
						}
					}

					const screenshot64 = screenshot.toString("base64");
					trace(`Screenshot taken: ${screenshot.length} bytes`);

					// The image is downscaled to save tokens, so its pixels are NOT device pixels. A
					// caller that reads a coordinate off this image and taps it lands in the wrong
					// place unless it knows the factor — state it rather than leaving it inferred.
					const deviceScale = returnedWidth > 0 ? shot.deviceWidth / returnedWidth : 1;
					const geometry = await robot.envelope({
						deviceWidth: shot.deviceWidth,
						deviceHeight: shot.deviceHeight,
						imageWidth: returnedWidth,
						imageScale: Number(deviceScale.toFixed(4)),
						note: deviceScale === 1
							? "Image pixels are device pixels; coordinates can be used directly."
							: `Multiply any coordinate read off this image by ${deviceScale.toFixed(4)} to get device pixels. Prefer mobile_tap_on_element, which needs no coordinates at all.`,
					});

					return {
						content: [
							{ type: "image", data: screenshot64, mimeType },
							{ type: "text", text: JSON.stringify(geometry) },
						]
					};
				});
			} catch (err: any) {
				error(`Error taking screenshot: ${err.message} ${err.stack}`);
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					isError: true,
				};
			}
		}
	);

	tool(
		"mobile_start_screen_recording",
		"Start Screen Recording",
		"Start recording the screen of a mobile device. The recording runs in the background until stopped with mobile_stop_screen_recording. Returns the path where the recording will be saved.",
		{
			device: deviceParam(),
			output: z.string().optional().describe("The file path to save the recording to. Filename must end with .mp4. If not provided, a temporary path will be used."),
			timeLimit: z.coerce.number().optional().describe("Maximum recording duration in seconds. The recording will stop automatically after this time."),
		},
		{ destructiveHint: true },
		async ({ device, output, timeLimit }) => {
			if (output) {
				validateFileExtension(output, ALLOWED_RECORDING_EXTENSIONS, "start_screen_recording");
				validateOutputPath(output);
			}

			getRobot(device);

			if (activeRecordings.has(device)) {
				throw new ActionableError(`Device "${device}" is already being recorded. Stop the current recording first with mobile_stop_screen_recording.`);
			}

			const outputPath = output || path.join(os.tmpdir(), `screen-recording-${Date.now()}.mp4`);

			// adb records to device storage; the stop tool pulls the file to the host.
			const remotePath = `/sdcard/android-agent-recording-${Date.now()}.mp4`;
			const args = ["-s", device, "shell", "screenrecord"];
			if (timeLimit !== undefined) {
				args.push("--time-limit", String(timeLimit));
			} else {
				// screenrecord's built-in default stops at 180s. Android 14+ accepts 0 = unlimited,
				// which is what "record until I say stop" means; on API <= 33 the value is rejected,
				// so keep the platform default there.
				try {
					const sdk = Number(execFileSync(getAdbPath(), ["-s", device, "shell", "getprop", "ro.build.version.sdk"], { timeout: 5000 }).toString().trim());
					if (sdk >= 34) {
						args.push("--time-limit", "0");
					}
				} catch {
					// Unknown SDK: leave the default cap rather than risk an invalid flag.
				}
			}
			args.push(remotePath);

			const child = spawn(getAdbPath(), args, { stdio: "ignore" });

			const cleanup = () => {
				// Keep the map entry so stop can still pull a recording whose process already
				// exited (its own time limit, or screenrecord's 180s default).
			};

			child.on("error", cleanup);
			child.on("exit", cleanup);

			activeRecordings.set(device, {
				process: child,
				outputPath,
				remotePath,
				startedAt: Date.now(),
			});

			return `Screen recording started. Output will be saved to: ${outputPath}`;
		}
	);

	tool(
		"mobile_stop_screen_recording",
		"Stop Screen Recording",
		"Stop an active screen recording, finalize it on the device, and pull the .mp4 to the host. Returns the file path, size, and approximate duration.",
		{
			device: deviceParam(),
		},
		{ destructiveHint: true },
		async ({ device }) => {
			const recording = activeRecordings.get(device);
			if (!recording) {
				throw new ActionableError(`No active recording found for device "${device}". Start a recording first with mobile_start_screen_recording.`);
			}

			const { process: child, outputPath, remotePath, startedAt } = recording;
			activeRecordings.delete(device);

			// Stop the device-side recorder directly with SIGINT so it finalizes the mp4 (writes the
			// moov atom). Killing only the local adb client does not reliably deliver a signal to the
			// remote process, and an unfinalized recording is unplayable.
			try {
				execFileSync(getAdbPath(), ["-s", device, "shell", "killall", "-INT", "screenrecord"], {
					timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
				});
			} catch {
				// Recorder already exited (time limit) — the file is finalized either way.
			}

			// Finalization is only done when the device-side process is gone; pulling on a fixed
			// sleep raced it and produced headers with no moov atom.
			for (let attempt = 0; attempt < 20; attempt++) {
				try {
					const alive = execFileSync(getAdbPath(), ["-s", device, "shell", "pidof", "screenrecord"], {
						timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
					}).toString().trim();
					if (!alive) {
						break;
					}
				} catch {
					break; // pidof exits non-zero when no process matches
				}
				await new Promise(resolve => setTimeout(resolve, 300));
			}

			if (child.exitCode === null) {
				child.kill("SIGINT");
				await new Promise<void>(resolve => {
					const timeout = setTimeout(() => {
						child.kill("SIGKILL");
						resolve();
					}, 10_000);

					child.on("close", () => {
						clearTimeout(timeout);
						resolve();
					});
				});
			}

			const durationSeconds = Math.round((Date.now() - startedAt) / 1000);

			try {
				execFileSync(getAdbPath(), ["-s", device, "pull", remotePath, outputPath], { timeout: 120_000 });
			} catch (err: any) {
				const detail = (err.stderr?.toString() || err.message || "").split("\n")[0];
				return `Recording stopped after ~${durationSeconds}s but pulling it failed: ${detail}. The file may still be on the device at ${remotePath}.`;
			}
			try {
				execFileSync(getAdbPath(), ["-s", device, "shell", "rm", remotePath], { timeout: 10_000 });
			} catch {
				// Leftover device file is harmless; do not fail the pull over cleanup.
			}

			if (!fs.existsSync(outputPath)) {
				return `Recording stopped after ~${durationSeconds}s but the output file was not found at: ${outputPath}`;
			}

			const stats = fs.statSync(outputPath);
			const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

			return `Recording stopped. File: ${outputPath} (${fileSizeMB} MB, ~${durationSeconds}s)`;
		}
	);

	tool(
		"mobile_list_crashes",
		"List Crash Reports",
		"List crash, ANR, native-crash and WTF entries from the device's DropBox, most recent last. Each entry is `<date> <time> <tag>`; pass the tag (optionally with the timestamp) to mobile_get_crash. Fast: reads the index, not the reports.",
		{
			device: deviceParam(),
			limit: z.coerce.number().min(1).max(200).optional().describe("Most recent N entries. Default 20."),
		},
		{ readOnlyHint: true },
		async ({ device, limit }) => {
			// The index listing (no --print) is ~50ms; printing every report to grep the output was
			// tens of megabytes and seconds of work to answer "what crashed lately".
			const out = execFileSync(getAdbPath(), ["-s", device, "shell", "dumpsys", "dropbox"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
			const entries = out.split("\n")
				.map(l => l.trim())
				.filter(l => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(l))
				.filter(l => /crash|anr|watchdog|wtf/i.test(l));
			const kept = entries.slice(Math.max(0, entries.length - (limit ?? 20)));
			return JSON.stringify({ count: kept.length, totalMatching: entries.length, entries: kept });
		}
	);

	tool(
		"mobile_get_crash",
		"Get Crash Report",
		"Get the content of a crash/ANR report by its DropBox tag, e.g. data_app_crash or data_app_anr — optionally preceded by the `YYYY-mm-dd HH:MM:SS` timestamp from mobile_list_crashes to select one specific entry. Output is tail-capped; the stack trace lives at the end, which is the part that survives.",
		{
			device: deviceParam(),
			id: z.string().describe("DropBox tag, optionally prefixed with the entry's date and time"),
			maxBytes: z.coerce.number().min(1024).max(262144).optional().describe("Keep at most this many bytes from the end. Default 16384."),
		},
		{ readOnlyHint: true },
		async ({ device, id, maxBytes }) => {
			const parts = id.trim().split(/\s+/);
			const content = execFileSync(getAdbPath(), ["-s", device, "shell", "dumpsys", "dropbox", "--print", ...parts], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
			const cap = maxBytes ?? 16384;
			if (content.length <= cap) {
				return content;
			}
			return `[truncated ${content.length - cap} bytes from the start — the stack trace is at the end]\n`
				+ content.slice(content.length - cap);
		}
	);


	const selectorFrom = (id?: string, idPrefix?: string, text?: string): ElementSelector => {
		if (!id && !idPrefix && !text) {
			throw new ActionableError("Provide one of: id, idPrefix, or text.");
		}
		return { id, idPrefix, text };
	};

	tool(
		"mobile_tap_on_element",
		"Tap Element",
		"Tap (or long-press) an element by its Compose test tag or by its visible text. Prefer this over tapping coordinates: a tag survives relayout, scrolling and translation, whereas coordinates do not. Text matching ignores Arabic diacritics, bidi isolates and Uzbek apostrophe variants, and never resolves to the soft keyboard's own keys.",
		{
			device: deviceParam(),
			id: z.string().optional().describe("Exact test tag / resource-id, e.g. shell.dock.library"),
			idPrefix: z.string().optional().describe("Test tag prefix — taps the best (visible-first) member of a family, e.g. dictionary.search.result. for the first search result"),
			text: z.string().optional().describe("Visible text or accessibility label. Matched leniently."),
			longPress: z.boolean().optional().describe("Long-press instead of tapping — context menus, drag-mode entry, word selection."),
		},
		{ destructiveHint: true },
		async ({ device, id, idPrefix, text, longPress }) => {
			const robot = getRobot(device);
			const selector = selectorFrom(id, idPrefix, text);
			const element = longPress
				? await robot.longPressOnElement(selector)
				: await robot.tapOnElement(selector);
			const name = element.identifier || element.text || element.label;
			const verb = longPress ? "Long-pressed" : "Tapped";
			// Report how it was tapped. Through the agent the node itself receives the action and no
			// coordinate is involved, so printing one would misdescribe what happened and send anyone
			// debugging a missed tap looking at the wrong layer.
			if (await robot.transport() === "agent") {
				return `${verb} ${name} directly (agent, no coordinates)`;
			}
			const x = Math.round(element.rect.x + element.rect.width / 2);
			const y = Math.round(element.rect.y + element.rect.height / 2);
			return `${verb} ${name} at ${x},${y} (adb coordinates)`;
		}
	);

	tool(
		"mobile_find_elements",
		"Find Elements",
		"Find elements by test tag, tag prefix, or lenient text match, without tapping. Returns the matches most-specific first. Use idPrefix to enumerate a family such as shell.dock. — useful for discovering what a screen exposes.",
		{
			device: deviceParam(),
			id: z.string().optional().describe("Exact test tag / resource-id"),
			idPrefix: z.string().optional().describe("Test tag prefix, e.g. shell.dock."),
			text: z.string().optional().describe("Visible text or accessibility label. Matched leniently."),
		},
		{ readOnlyHint: true },
		async ({ device, id, idPrefix, text }) => {
			const robot = getRobot(device);
			const matches = await robot.findElements(selectorFrom(id, idPrefix, text));
			return JSON.stringify(await robot.envelope({
				query: describeSelector(selectorFrom(id, idPrefix, text)),
				count: matches.length,
				elements: matches,
			}));
		}
	);

	tool(
		"mobile_wait_for_stable",
		"Wait For Stable UI",
		"Block until the screen stops changing. Use after a tap, launch or navigation instead of sleeping. A sample costs ~120ms through the in-process agent and ~2s over the adb fallback; either way one call here beats repeated polling. Returns stable:false on timeout rather than failing, since some surfaces animate forever.",
		{
			device: deviceParam(),
			timeoutMs: z.coerce.number().optional().describe("Give up after this long. Default 20000."),
			settleSamples: z.coerce.number().optional().describe("Consecutive identical dumps required. Default 2."),
		},
		{ readOnlyHint: true },
		async ({ device, timeoutMs, settleSamples }) => {
			const robot = getRobot(device);
			return JSON.stringify(await robot.envelope(await robot.waitForStable({ timeoutMs, settleSamples })));
		}
	);

	tool(
		"mobile_run_steps",
		"Run Step Sequence",
		"Run a whole journey in one call, settling between steps: launch, tap, long-press, set Unicode text, scroll to an element, assert, press buttons, swipe. Stops at the first failing step with per-step timings, so one call replaces five round trips and the log says exactly where and why it stopped. Set snapshot:true to receive the final screen's compact element tree in the same result — saving the follow-up list call.",
		{
			device: deviceParam(),
			steps: z.array(z.object({
				launch: z.string().optional().describe("Launch this package and wait for it to be foreground"),
				relaunch: z.string().optional().describe("Force-stop, then launch — a deterministic cold-ish start that discards restored navigation state. Use as step 0 of a repeatable journey."),
				tapId: z.string().optional().describe("Tap the element with this test tag"),
				tapIdPrefix: z.string().optional().describe("Tap the best member of a tag family, e.g. dictionary.search.result."),
				tapText: z.string().optional().describe("Tap the element matching this text"),
				longPress: z.boolean().optional().describe("With tapId/tapIdPrefix/tapText: long-press instead of tap"),
				setText: z.object({
					id: z.string().optional().describe("Field test tag"),
					text: z.string().optional().describe("Field label/text"),
					value: z.string().describe("Text to write; Unicode-safe. Empty clears."),
				}).optional().describe("Write a field's contents directly (agent; Arabic/Cyrillic safe)"),
				type: z.string().optional().describe("Type into the focused field, appending at the cursor (Unicode via agent, ASCII over adb)"),
				button: z.string().optional().describe("Press a button: BACK, HOME, ENTER... or any KEYCODE_*"),
				swipe: z.enum(["up", "down", "left", "right"]).optional().describe("Swipe the screen (finger direction)"),
				scrollToId: z.string().optional().describe("Scroll until the element with this tag is visible"),
				scrollToText: z.string().optional().describe("Scroll until this text is visible"),
				assert: z.object({
					id: z.string().optional(),
					idPrefix: z.string().optional(),
					text: z.string().optional(),
					exists: z.boolean().optional(),
					visible: z.boolean().optional(),
					textEquals: z.string().optional(),
					minCount: z.coerce.number().optional(),
					foregroundPackage: z.string().optional(),
					timeoutMs: z.coerce.number().optional(),
				}).optional().describe("Assert screen state, waiting up to timeoutMs (default 4000) for it to come true; a failed assertion stops the sequence with evidence"),
			})).describe("Steps, executed in order"),
			settle: z.boolean().optional().describe("Wait for the UI to settle between steps. Default true."),
			snapshot: z.boolean().optional().describe("Append the final screen's compact element tree to the result. Default false."),
		},
		{ destructiveHint: true },
		async ({ device, steps, settle, snapshot }) => {
			const robot = getRobot(device);
			const shouldSettle = settle !== false;
			const log: string[] = [];

			const finish = async (completed: number): Promise<string> => {
				const result: any = { completed, total: steps.length, log };
				const payload = JSON.stringify(await robot.envelope(result));
				if (!snapshot) {
					return payload;
				}
				const elements = await robot.getElementsOnScreen();
				const lines = formatCompactElementLines(elements);
				robot.lastCompactLines = lines;
				return `${payload}\n${lines.join("\n")}`;
			};

			for (let i = 0; i < steps.length; i++) {
				const step = steps[i];
				const startedAt = Date.now();
				const took = () => `${Date.now() - startedAt}ms`;
				try {
					if (step.launch || step.relaunch) {
						const pkg = (step.launch ?? step.relaunch) as string;
						if (step.relaunch) {
							await robot.terminateApp(pkg);
						}
						await robot.launchApp(pkg);
						const confirmed = await robot.waitForForeground(pkg, 15000);
						const verb = step.relaunch ? "relaunched" : "launched";
						log.push(`${i}: ${verb} ${pkg}${confirmed ? "" : " (foreground NOT confirmed)"} ${took()}`);
					} else if (step.tapId || step.tapIdPrefix || step.tapText) {
						const selector = { id: step.tapId, idPrefix: step.tapIdPrefix, text: step.tapText };
						const element = step.longPress
							? await robot.longPressOnElement(selector)
							: await robot.tapOnElement(selector);
						const verb = step.longPress ? "long-pressed" : "tapped";
						log.push(`${i}: ${verb} ${element.identifier || element.text || element.label} ${took()}`);
					} else if (step.setText) {
						const target = await robot.setTextOn({ id: step.setText.id, text: step.setText.text }, step.setText.value);
						log.push(`${i}: set ${target.identifier || target.label || "field"} ${took()}`);
					} else if (step.type !== undefined) {
						await robot.sendKeys(step.type);
						log.push(`${i}: typed ${took()}`);
					} else if (step.button) {
						await robot.pressButton(step.button as any);
						log.push(`${i}: pressed ${step.button} ${took()}`);
					} else if (step.swipe) {
						await robot.swipe(step.swipe);
						log.push(`${i}: swiped ${step.swipe} ${took()}`);
					} else if (step.scrollToId || step.scrollToText) {
						const target = await robot.scrollIntoView({ id: step.scrollToId, text: step.scrollToText });
						log.push(`${i}: scrolled to ${target.identifier || target.text || target.label} ${took()}`);
					} else if (step.assert) {
						const { id, idPrefix, text, timeoutMs, ...expected } = step.assert;
						const result = await robot.assertScreen(selectorFrom(id, idPrefix, text), expected, timeoutMs);
						if (!result.passed) {
							log.push(`${i}: ASSERTION FAILED ${JSON.stringify(result.checks.filter(c => !c.passed))} ${took()}`);
							return await finish(i);
						}
						log.push(`${i}: asserted ${result.selector} ${took()}`);
					} else {
						throw new ActionableError("Step has no action.");
					}
				} catch (err: any) {
					log.push(`${i}: FAILED - ${err.message} ${took()}`);
					return await finish(i);
				}

				// Assertions read; they do not move the screen, so settling after one wastes a sample.
				if (shouldSettle && !step.assert) {
					const stability = await robot.waitForStable({ timeoutMs: 15000 });
					if (!stability.stable) {
						log.push(`${i}: (did not fully settle)`);
					}
				}
			}

			return await finish(steps.length);
		}
	);


	tool(
		"mobile_set_text",
		"Set Field Text",
		"Replace a named field's contents. Unicode-safe: handles Arabic, Cyrillic and Uzbek U+02BB with no keyboard installed, which adb text entry cannot do. Empty string clears the field. To append at the cursor instead, use mobile_type_keys. Requires the in-process agent; mobile_agent_status reports whether it is running.",
		{
			device: deviceParam(),
			id: z.string().optional().describe("Test tag / resource-id of the field"),
			text: z.string().optional().describe("Visible text or label identifying the field"),
			value: z.string().describe("Text to write. Empty string clears the field."),
		},
		{ destructiveHint: true },
		async ({ device, id, text, value }) => {
			const robot = getRobot(device);
			const target = await robot.setTextOn(selectorFrom(id, undefined, text), value);
			return `Set ${target.identifier || target.label || "field"} to ${JSON.stringify(value)}`;
		}
	);

	tool(
		"mobile_device_state",
		"Get Or Set Device State",
		"Read or change the device-state matrix in one call: display (font scale, dark mode, animations, density), connectivity (airplane mode, wifi, mobile data) and orientation. Call with no arguments to read everything. Name any subset to change it; the full post-change snapshot is returned. This is the matrix a visible change must survive — font scale for Dynamic Type, night mode for dark theme, animations off for deterministic screenshots, airplane mode for the offline release gates. Values persist on the device, so reset what you change, and always restore connectivity when an offline check is done.",
		{
			device: deviceParam(),
			fontScale: z.coerce.number().optional().describe("System font scale, e.g. 0.85, 1.0, 1.3, 2.0. A common release gate is that text stays readable at the largest scales."),
			nightMode: z.enum(["yes", "no", "auto"]).optional().describe("Dark theme."),
			animations: z.boolean().optional().describe("false zeroes window, transition and animator scales together — use before screenshot comparison. true sets all three to 1.0, which is a normalization, not a restore: read the state first if the device had non-default scales."),
			density: z.union([z.coerce.number(), z.literal("reset")]).optional().describe("Screen density in dpi, or \"reset\" to restore the physical value. Changing this re-creates activities."),
			airplaneMode: z.boolean().optional().describe("Enter or leave airplane mode."),
			wifi: z.boolean().optional().describe("Turn wifi on/off."),
			mobileData: z.boolean().optional().describe("Turn mobile data on/off."),
			orientation: z.enum(["portrait", "landscape"]).optional().describe("Rotate the display (verified: the call blocks until the display actually turns)."),
		},
		{ destructiveHint: true },
		async ({ device, fontScale, nightMode, animations, density, airplaneMode, wifi, mobileData, orientation }) => {
			const robot = getRobot(device);
			const wantsDisplayChange = fontScale !== undefined || nightMode !== undefined
				|| animations !== undefined || density !== undefined;
			const wantsNetworkChange = airplaneMode !== undefined || wifi !== undefined || mobileData !== undefined;
			const changed = wantsDisplayChange || wantsNetworkChange || orientation !== undefined;

			if (wantsDisplayChange) {
				robot.setDisplayState({ fontScale, nightMode, animations, density });
			}
			if (airplaneMode !== undefined) {
				robot.setAirplaneMode(airplaneMode);
			}
			if (wifi !== undefined || mobileData !== undefined) {
				robot.setNetworkState({ wifi, mobileData });
			}
			if (orientation !== undefined) {
				await robot.setOrientation(orientation);
			}

			const snapshot = {
				display: robot.getDisplayState(),
				network: robot.getNetworkState(),
				orientation: await robot.getOrientation(),
				changed,
			};
			return JSON.stringify(await robot.envelope(snapshot));
		}
	);

	tool(
		"mobile_assert",
		"Assert Screen State",
		"Assert something about the screen, waiting up to timeoutMs for it to come true — an assertion is a wait, so debounces, list population and transitions are absorbed instead of raced. Prefer this over listing elements and eyeballing them: it states the expectation, reports what was actually found, and turns a three-call inspect-and-compare loop into one call. Checks are ANDed; omitted checks are not evaluated.",
		{
			device: deviceParam(),
			id: z.string().optional().describe("Exact test tag / resource-id"),
			idPrefix: z.string().optional().describe("Test tag prefix, e.g. shell.dock."),
			text: z.string().optional().describe("Visible text or accessibility label. Matched leniently."),
			exists: z.boolean().optional().describe("Whether the selector should match anything at all. Defaults to true."),
			visible: z.boolean().optional().describe("Whether a match must be actually visible to the user (isVisibleToUser via the agent), not merely present in the tree. Reported as unknown over the adb transport."),
			textEquals: z.string().optional().describe("Exact expected text on the best match, compared leniently (diacritics and bidi marks folded)."),
			minCount: z.coerce.number().optional().describe("Minimum number of matches."),
			foregroundPackage: z.string().optional().describe("Package that must own the foreground window. Guards against asserting on the wrong app."),
			timeoutMs: z.coerce.number().min(0).max(30000).optional().describe("How long to keep re-checking before declaring failure. Default 4000. 0 = single immediate check."),
		},
		{ readOnlyHint: true },
		async ({ device, id, idPrefix, text, exists, visible, textEquals, minCount, foregroundPackage, timeoutMs }) => {
			const robot = getRobot(device);
			const result = await robot.assertScreen(
				selectorFrom(id, idPrefix, text),
				{ exists, visible, textEquals, minCount, foregroundPackage },
				timeoutMs,
			);
			const payload = JSON.stringify(await robot.envelope(result));
			// Lead with the verdict. A failed assertion is not a "retry and it may work" condition —
			// it means the screen or the expectation is wrong — so it must not be phrased like the
			// server's recoverable errors, and it must be impossible to skim past.
			return result.passed ? `ASSERTION PASSED ${payload}` : `ASSERTION FAILED ${payload}`;
		}
	);

	tool(
		"mobile_list_windows",
		"List Windows",
		"List every application and IME window, topmost first, with the package that owns each and which one is in the foreground. Use this when a dump looks like it belongs to the wrong app, when a dialog or bottom sheet may be covering the screen, or before asserting that the app under test is actually in front. Requires the in-process agent.",
		{
			device: deviceParam(),
		},
		{ readOnlyHint: true },
		async ({ device }) => {
			const robot = getRobot(device);
			const stack = await robot.windowStack();
			return JSON.stringify(await robot.envelope(stack));
		}
	);

	tool(
		"mobile_scroll_into_view",
		"Scroll To Element",
		"Scroll a named element into view through its nearest scrollable container, then return it. Use this instead of repeated swipe-and-screenshot loops: it stops as soon as the element is visible and reports when the container has run out of content. Requires the in-process agent.",
		{
			device: deviceParam(),
			id: z.string().optional().describe("Exact test tag / resource-id"),
			idPrefix: z.string().optional().describe("Test tag prefix, e.g. shell.dock."),
			text: z.string().optional().describe("Visible text or accessibility label. Matched leniently."),
			maxScrolls: z.coerce.number().optional().describe("Give up after this many scrolls. Default 12."),
		},
		{ readOnlyHint: false },
		async ({ device, id, idPrefix, text, maxScrolls }) => {
			const robot = getRobot(device);
			const target = await robot.scrollIntoView(selectorFrom(id, idPrefix, text), maxScrolls);
			return JSON.stringify(await robot.envelope({ target }));
		}
	);

	tool(
		"mobile_gesture",
		"Gesture Path",
		"Drive one finger through a timed path in device pixels: drags, curves, reorder-by-drag. holdMs long-presses before the first move, which is how drag-and-drop starts. Injected as a real MotionEvent stream via the in-process agent; without the agent only a plain 2-point line is possible. NOTE: a path starting within ~50px of a screen edge triggers the system edge gesture (back/home/notification shade) — start further in to drag content.",
		{
			device: deviceParam(),
			points: z.array(z.object({
				x: z.coerce.number().describe("Device pixels"),
				y: z.coerce.number().describe("Device pixels"),
				dtMs: z.coerce.number().optional().describe("Milliseconds after the previous point. Default 12."),
			})).min(2).describe("The path, first point = touch down, last point = lift"),
			holdMs: z.coerce.number().min(0).max(10000).optional().describe("Hold at the first point before moving — 600+ enters drag mode in most lists"),
		},
		{ destructiveHint: true },
		async ({ device, points, holdMs }) => {
			const robot = getRobot(device);
			await robot.gesturePath(points, holdMs);
			const from = points[0];
			const to = points[points.length - 1];
			return `Gestured ${points.length} points from ${Math.round(from.x)},${Math.round(from.y)} to ${Math.round(to.x)},${Math.round(to.y)}${holdMs ? ` after a ${holdMs}ms hold` : ""}`;
		}
	);

	tool(
		"mobile_pinch",
		"Pinch / Zoom",
		"Two-finger pinch about a centre point — zoom maps, images, readers. Requires the in-process agent (adb cannot inject a second finger). Spreads are finger-to-finger distances in pixels: endSpread > startSpread zooms in.",
		{
			device: deviceParam(),
			mode: z.enum(["open", "close"]).optional().describe("Convenience preset: open = zoom in (200→800px), close = zoom out (800→200px), centred on screen unless overridden"),
			centerX: z.coerce.number().optional().describe("Centre X in device pixels. Default: screen centre."),
			centerY: z.coerce.number().optional().describe("Centre Y in device pixels. Default: screen centre."),
			startSpread: z.coerce.number().min(0).optional().describe("Finger distance at start, pixels"),
			endSpread: z.coerce.number().min(0).optional().describe("Finger distance at end, pixels"),
			durationMs: z.coerce.number().min(50).max(10000).optional().describe("Default 400"),
			angleDeg: z.coerce.number().optional().describe("Finger axis; 0 = horizontal. Default 0."),
		},
		{ destructiveHint: true },
		async ({ device, mode, centerX, centerY, startSpread, endSpread, durationMs, angleDeg }) => {
			const robot = getRobot(device);
			if (!mode && (startSpread === undefined || endSpread === undefined)) {
				throw new ActionableError("Provide either mode (open/close) or both startSpread and endSpread.");
			}
			const screen = await robot.getScreenSize();
			const request = {
				centerX: centerX ?? Math.round(screen.width / 2),
				centerY: centerY ?? Math.round(screen.height / 2),
				startSpread: startSpread ?? (mode === "open" ? 200 : 800),
				endSpread: endSpread ?? (mode === "open" ? 800 : 200),
				durationMs,
				angleDeg,
			};
			await robot.pinchGesture(request);
			return `Pinched ${request.startSpread}px -> ${request.endSpread}px at ${request.centerX},${request.centerY}`;
		}
	);

	// Log markers per device, so "everything since my last mark" is one call with no state on the
	// caller's side. Lives for the server process, exactly like the robots that produce them.
	const logcatMarks = new Map<string, string>();

	tool(
		"mobile_logcat",
		"Read Device Log",
		"Read logcat, scoped to stay quotable: by app (pid-filtered), priority, tag, and line cap; includes the crash buffer by default. mark:true stamps the current device time and returns immediately — a later call with sinceMark:true returns only what happened after the stamp, which is the right way to capture 'the log of this one action'.",
		{
			device: deviceParam(),
			packageName: z.string().optional().describe("Only lines from this app's process. The app must be running (pid filter)."),
			priority: z.enum(["V", "D", "I", "W", "E", "F"]).optional().describe("Minimum priority. Default I."),
			tag: z.string().optional().describe("Only this log tag (exact), silencing everything else"),
			lines: z.coerce.number().min(1).max(2000).optional().describe("Tail cap. Default 200."),
			mark: z.boolean().optional().describe("Stamp now as the mark for sinceMark and return without reading"),
			sinceMark: z.boolean().optional().describe("Only lines after the last mark for this device"),
		},
		{ readOnlyHint: true },
		async ({ device, packageName, priority, tag, lines, mark, sinceMark }) => {
			const robot = getRobot(device);
			if (mark) {
				const stamp = robot.deviceLogTime();
				logcatMarks.set(device, stamp);
				return JSON.stringify({ marked: stamp });
			}
			let sinceDeviceTime: string | undefined;
			if (sinceMark) {
				sinceDeviceTime = logcatMarks.get(device);
				if (!sinceDeviceTime) {
					throw new ActionableError("No mark set for this device. Call with mark:true first, then act, then read with sinceMark:true.");
				}
			}
			const result = robot.readLogcat({ packageName, priority, tag, lines, sinceDeviceTime });
			const header = JSON.stringify({
				pid: result.pid,
				pidFiltered: result.pid !== null,
				truncated: result.truncated,
				...(packageName && result.pid === null
					? { warning: `${packageName} has no running process; showing unfiltered log. Launch the app first for a per-app view.` }
					: {}),
			});
			return `${header}\n${result.text || "(no matching log lines)"}`;
		}
	);

	tool(
		"mobile_app_state",
		"App State",
		"Inspect or reset one app's environment. action info: version, running state and pid — verify what you are actually testing. clear: erase the app's data and stop it, the reset-to-first-launch primitive (signs the user out; irreversible). locale: read or set the app's own locale without touching device language (API 33+) — pass locales to set (e.g. \"ar\" or \"ru-RU,en\"; empty string resets), omit to read; the app recreates its activities immediately. permissions: list, grant or revoke runtime permissions via permissionAction + permissions (short names are expanded, CAMERA -> android.permission.CAMERA; revoking a permission in use kills the process, exactly as the OS does).",
		{
			device: deviceParam(),
			packageName: z.string().describe("The app package"),
			action: z.enum(["info", "clear", "locale", "permissions"]).describe("What to do"),
			locales: z.string().optional().describe("For action locale: comma-separated BCP 47 tags to set. Empty string resets. Omit to read."),
			permissionAction: z.enum(["list", "grant", "revoke"]).optional().describe("For action permissions. Default list."),
			permissions: z.array(z.string()).optional().describe("For grant/revoke: permission names, short or fully qualified"),
		},
		{ destructiveHint: true },
		async ({ device, packageName, action, locales, permissionAction, permissions }) => {
			const robot = getRobot(device);
			if (action === "info") {
				return JSON.stringify(robot.appInfo(packageName));
			}
			if (action === "clear") {
				robot.clearAppData(packageName);
				// Clearing the app the instrumentation runs inside kills the agent with it; drop the
				// launch cooldown so the next call relaunches instead of silently degrading to adb.
				if (packageName === AGENT_IDENTITY.targetPackage || packageName === AGENT_IDENTITY.testPackage) {
					robot.invalidateAgent();
				}
				return JSON.stringify({ cleared: true, ...robot.appInfo(packageName) });
			}
			if (action === "locale") {
				if (locales === undefined) {
					return JSON.stringify({ packageName, locales: robot.getAppLocale(packageName) });
				}
				return JSON.stringify(robot.setAppLocale(packageName, locales));
			}
			// permissions
			const permAction = permissionAction ?? "list";
			if (permAction === "list") {
				const granted = robot.listPermissions(packageName);
				return JSON.stringify({ packageName, runtimePermissions: granted });
			}
			if (!permissions || permissions.length === 0) {
				throw new ActionableError(`${permAction} needs at least one permission name.`);
			}
			const qualified = permissions.map((p: string) => p.includes(".") ? p : `android.permission.${p}`);
			const results: string[] = [];
			for (const permission of qualified) {
				try {
					if (permAction === "grant") {
						robot.grantPermission(packageName, permission);
					} else {
						robot.revokePermission(packageName, permission);
					}
					results.push(`${permission}: ${permAction}ed`);
				} catch (err: any) {
					const detail = (err.stderr?.toString() || err.message || "").split("\n")[0];
					results.push(`${permission}: FAILED - ${detail}`);
				}
			}
			return JSON.stringify({ packageName, results });
		}
	);

	tool(
		"mobile_emulator",
		"Emulator Controls",
		"Emulator-only controls a stock physical device cannot offer, via the emulator console: network shaping (bandwidth profile and latency — the slow-network half of the offline release gates), battery level and AC simulation, and fold/unfold or posture for foldable AVDs. Name any subset; each command's console reply is reported. Restore shaping to full/none when the check is done. Fails on a physical device.",
		{
			device: deviceParam(),
			networkSpeed: z.string().optional().describe("Bandwidth profile: full, gsm, edge, 3g, lte, hsdpa, umts, or min:max in kbps (e.g. 128:256)"),
			networkDelay: z.string().optional().describe("Latency profile: none, gprs, edge, umts, or min:max in ms (e.g. 300:400)"),
			batteryLevel: z.coerce.number().min(0).max(100).optional().describe("Simulated battery percentage"),
			ac: z.boolean().optional().describe("Simulated charger connected"),
			fold: z.boolean().optional().describe("true folds, false unfolds (foldable AVDs only)"),
			posture: z.coerce.number().optional().describe("Posture id for foldable AVDs (see `adb emu posture` docs)"),
			status: z.boolean().optional().describe("Include `network status` output in the result"),
		},
		{ destructiveHint: true },
		async ({ device, networkSpeed, networkDelay, batteryLevel, ac, fold, posture, status }) => {
			if (!isEmulator(device)) {
				throw new ActionableError(`Device "${device}" is not an emulator. Network shaping, battery simulation and posture need the emulator console; a stock physical device cannot do them.`);
			}
			const results: Record<string, string> = {};
			const emu = (label: string, ...command: string[]) => {
				try {
					const out = execFileSync(getAdbPath(), ["-s", device, "emu", ...command], { timeout: 10000 })
						.toString().trim();
					results[label] = out || "OK";
				} catch (err: any) {
					results[label] = `FAILED - ${(err.stderr?.toString() || err.message || "").split("\n")[0]}`;
				}
			};

			if (networkSpeed !== undefined) {
				emu("networkSpeed", "network", "speed", networkSpeed);
			}
			if (networkDelay !== undefined) {
				emu("networkDelay", "network", "delay", networkDelay);
			}
			if (batteryLevel !== undefined) {
				emu("batteryLevel", "power", "capacity", String(batteryLevel));
			}
			if (ac !== undefined) {
				emu("ac", "power", "ac", ac ? "on" : "off");
			}
			if (fold !== undefined) {
				emu("fold", fold ? "fold" : "unfold");
			}
			if (posture !== undefined) {
				emu("posture", "posture", String(posture));
			}
			if (status || Object.keys(results).length === 0) {
				emu("networkStatus", "network", "status");
			}
			return JSON.stringify({ device, results });
		}
	);

	tool(
		"mobile_watch",
		"Watch Device (scrcpy)",
		"Open or close a live mirror window of the device on this Mac via scrcpy, so a human can watch the automation as it happens — the Android counterpart of the iOS simulator panel. Mainly for physical devices; an emulator usually already shows its own window. Requires scrcpy (brew install scrcpy). The window closes when this server exits.",
		{
			device: deviceParam(),
			action: z.enum(["start", "stop", "status"]).describe("start opens the mirror window, stop closes it, status reports"),
		},
		{ readOnlyHint: true },
		async ({ device, action }) => {
			const existing = watchers.get(device);
			if (action === "status") {
				return JSON.stringify({ device, watching: Boolean(existing && existing.exitCode === null) });
			}
			if (action === "stop") {
				if (!existing || existing.exitCode !== null) {
					watchers.delete(device);
					return JSON.stringify({ device, watching: false, note: "No live view was open." });
				}
				existing.kill("SIGTERM");
				watchers.delete(device);
				return JSON.stringify({ device, watching: false });
			}
			// start
			if (existing && existing.exitCode === null) {
				return JSON.stringify({ device, watching: true, note: "Live view already open." });
			}
			const candidates = ["/opt/homebrew/bin/scrcpy", "/usr/local/bin/scrcpy", "scrcpy"];
			const scrcpyPath = candidates.find(candidate => {
				try {
					execFileSync(candidate, ["--version"], { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
					return true;
				} catch {
					return false;
				}
			});
			if (!scrcpyPath) {
				throw new ActionableError("scrcpy is not installed on this Mac. Install it with: brew install scrcpy");
			}
			const child = spawn(scrcpyPath, ["-s", device, "--window-title", `android-agent-mcp — ${device}`, "--stay-awake"], {
				stdio: "ignore",
			});
			child.on("exit", () => {
				if (watchers.get(device) === child) {
					watchers.delete(device);
				}
			});
			watchers.set(device, child);
			return JSON.stringify({ device, watching: true, window: `android-agent-mcp — ${device}` });
		}
	);

	tool(
		"mobile_agent_status",
		"Agent Status",
		"Report which transport is in use, and — when the agent is absent — exactly why and how to fix it. The on-device agent reads the live accessibility tree (~10-20x faster), acts on nodes instead of coordinates so nothing can be mis-tapped through the keyboard, reports real per-node visibility, and supports Unicode text entry. Without it everything still works over adb, minus those four things.",
		{ device: deviceParam() },
		{ readOnlyHint: true },
		async ({ device }) => {
			const robot = getRobot(device);
			const transport = await robot.transport();
			const agent = transport === "agent";
			return JSON.stringify({
				transport,
				// Naming the configured identity turns "the agent is not running" from a dead end
				// into something a caller can check: is this the instrumentation you meant?
				agentPackage: AGENT_IDENTITY.testPackage,
				agentClass: AGENT_IDENTITY.className,
				mode: AGENT_IDENTITY.mode,
				coordinateFreeTaps: agent,
				visibilityReporting: agent,
				unicodeTextEntry: agent,
				...(agent ? {} : {
					installedInstrumentations: robot.installedInstrumentations(),
					startCommand: agentStartHint(device),
				}),
			});
		}
	);

	return server;
};
