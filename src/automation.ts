import { createHash } from "node:crypto";

import { AndroidRobot } from "./android";
import { parseInstrumentations } from "./config";
import { AGENT_IDENTITY, AgentClient, AgentTimeoutError, GesturePoint, PinchRequest, agentStartHint, toScreenElement } from "./agent";
import { ActionableError, ScreenElement } from "./robot";

/**
 * Agent-backed automation layer.
 *
 * Kept in its own module so the forked upstream files stay close to their original shape and
 * remain cheap to diff against `mobile-mcp`.
 *
 * Three things upstream does not give us:
 *   1. Addressing an element by its Compose test tag instead of by screen coordinate.
 *   2. Knowing when the UI has actually settled, rather than sleeping and hoping.
 *   3. Matching Arabic, Uzbek and Russian text the way a learner sees it, not the way the
 *      accessibility tree encodes it.
 */

// ---------------------------------------------------------------------------
// Text folding
// ---------------------------------------------------------------------------

/**
 * Unicode bidirectional formatting characters.
 *
 * Apps that render mixed-direction content wrap it in isolates, so an Arabic word arrives from the
 * accessibility tree as `⁧…⁩` and a Latin gloss as `⁦…⁩`. A caller searching
 * for "كتاب" is searching for the word, not the isolate, so these are removed before comparing.
 */
const BIDI_CONTROLS = /[‎‏؜⁦-⁩‪-‮]/g;

/** Arabic short vowels, sukun, shadda, superscript alef, and tatweel padding. */
const ARABIC_DIACRITICS = /[ً-ْٰـ]/g;

/**
 * Every apostrophe that appears in Uzbek Latin across the codebase.
 *
 * `oʻqish` is canonically written with U+02BB, but content and OS keyboards produce U+02BC, the
 * curly quotes, and plain ASCII. Folding them to one sentinel means a selector written either way
 * matches either rendering.
 */
const UZBEK_APOSTROPHES = /[ʻʼ‘’']/g;

/** Strip bidi isolates/marks. Safe for any script. */
export const stripBidi = (value: string): string => value.replace(BIDI_CONTROLS, "");

/**
 * Fold one string into a form suitable for *matching only*.
 *
 * This is deliberately lossy and must never be used to produce text shown to a learner or written
 * back to the app. Vocalized and unvocalized Arabic fold together on purpose: a selector should
 * not have to reproduce tashkeel exactly to find `كِتَاب`.
 */
export const foldForMatch = (value: string): string =>
	stripBidi(value)
		.replace(ARABIC_DIACRITICS, "")
		.replace(/[أإآٱ]/g, "ا") // hamza-carrying alef forms -> bare alef
		.replace(/ى/g, "ي")                      // alef maqsura -> yeh
		.replace(UZBEK_APOSTROPHES, "'")
		.toLocaleLowerCase()
		.replace(/\s+/g, " ")
		.trim();

// ---------------------------------------------------------------------------
// Element selection
// ---------------------------------------------------------------------------

export interface ElementSelector {
	/** Exact Compose test tag / resource-id, e.g. `shell.dock.library`. */
	id?: string;
	/** Test tag prefix, e.g. `shell.dock.` to enumerate a family. */
	idPrefix?: string;
	/** Visible text or accessibility label; folded before comparison. */
	text?: string;
}

export interface AssertionCheck {
	check: string;
	expected: unknown;
	actual: unknown;
	passed: boolean;
}

export interface AssertionResult {
	passed: boolean;
	selector: string | null;
	matchCount: number;
	best: ScreenElement | null;
	checks: AssertionCheck[];
}

export interface DisplayState {
	fontScale: number;
	nightMode: "yes" | "no" | "auto";
	windowAnimationScale: number;
	transitionAnimationScale: number;
	animatorDurationScale: number;
	density: number;
}

export interface DisplayStateRequest {
	fontScale: number;
	nightMode: "yes" | "no" | "auto";
	animations: boolean;
	density: number | "reset";
}

export const describeSelector = (selector: ElementSelector): string =>
	selector.id ? `id="${selector.id}"`
		: selector.idPrefix ? `idPrefix="${selector.idPrefix}"`
			: selector.text ? `text="${selector.text}"`
				: "<empty selector>";

const area = (element: ScreenElement): number => element.rect.width * element.rect.height;

const boundsKey = (element: ScreenElement): string =>
	`${element.rect.x},${element.rect.y},${element.rect.width},${element.rect.height}`;

/**
 * Fuse nodes that occupy exactly the same rectangle into a single element.
 *
 * Compose routinely splits one visual row across sibling accessibility nodes: the test tag lands
 * on one, the content description on another, and both report identical bounds. Left unmerged, a
 * dictionary result appears twice — once as `dictionary.search.result.<uuid>` with no text, and
 * once as readable text with no id — so a caller cannot tell which uuid is which word without
 * correlating rectangles by hand.
 *
 * Merging makes each row addressable and legible at the same time.
 */
export const mergeColocated = (elements: ScreenElement[]): ScreenElement[] => {
	const groups = new Map<string, ScreenElement[]>();
	for (const element of elements) {
		const key = boundsKey(element);
		const group = groups.get(key);
		if (group) {
			group.push(element);
		} else {
			groups.set(key, [element]);
		}
	}

	const firstNonEmpty = (group: ScreenElement[], pick: (e: ScreenElement) => string | undefined): string | undefined =>
		group.map(pick).find(value => value !== undefined && value !== "");

	return Array.from(groups.values()).map(group => {
		if (group.length === 1) {
			return group[0];
		}
		const merged: ScreenElement = {
			// Prefer a concrete widget class over a bare container when both describe the same box.
			type: group.find(e => e.type && e.type !== "android.view.View")?.type || group[0].type,
			rect: group[0].rect,
		};
		const identifier = firstNonEmpty(group, e => e.identifier);
		const text = firstNonEmpty(group, e => e.text);
		const label = firstNonEmpty(group, e => e.label);
		if (identifier !== undefined) {
			merged.identifier = identifier;
		}
		if (text !== undefined) {
			merged.text = text;
		}
		if (label !== undefined) {
			merged.label = label;
		}
		if (group.some(e => e.clickable)) {
			merged.clickable = true;
		}
		if (group.some(e => e.focused)) {
			merged.focused = true;
		}
		if (group.some(e => e.scrollable)) {
			merged.scrollable = true;
		}
		// Same rectangle, so visibility agrees; carry it when any member knows it.
		const knowsVisibility = group.filter(e => e.visible !== undefined);
		if (knowsVisibility.length > 0) {
			merged.visible = knowsVisibility.some(e => e.visible);
		}
		return merged;
	});
};

/**
 * Find every element matching a selector, best candidate first.
 *
 * Ranking is clickable-first, then smallest box. Clickability only RANKS and never filters: a
 * selected Material tab reports `clickable=false` because `Role.Tab` plus a selected state maps
 * differently into AccessibilityNodeInfo, so filtering would make the currently-active
 * destination unaddressable — exactly when a caller is most likely to reach for it.
 *
 * Smallest-box-first alone is wrong for tapping. A dictionary result row carries its word in a
 * small inner TextView and its tap handler on the large outer row; the inner node wins on area but
 * is not the thing to touch.
 */
export const selectElements = (elements: ScreenElement[], selector: ElementSelector): ScreenElement[] => {
	let matches: ScreenElement[];

	if (selector.id) {
		matches = elements.filter(e => e.identifier === selector.id);
	} else if (selector.idPrefix) {
		matches = elements.filter(e => (e.identifier || "").startsWith(selector.idPrefix!));
	} else if (selector.text) {
		const needle = foldForMatch(selector.text);
		matches = elements.filter(e => {
			const haystacks = [e.text, e.label, e.name, e.value].filter(Boolean) as string[];
			return haystacks.some(h => foldForMatch(h).includes(needle));
		});
	} else {
		throw new ActionableError("A selector needs one of: id, idPrefix, or text.");
	}

	return matches.slice().sort((a, b) => {
		// Visible beats hidden before anything else: a lazy list keeps offscreen rows attached,
		// and acting on an attached-but-covered match is always wrong. `undefined` (adb transport)
		// ranks with visible — unknown is not evidence of covering.
		const aHidden = a.visible === false;
		const bHidden = b.visible === false;
		if (aHidden !== bHidden) {
			return aHidden ? 1 : -1;
		}
		if (Boolean(a.clickable) !== Boolean(b.clickable)) {
			return a.clickable ? -1 : 1;
		}
		return area(a) - area(b);
	});
};

const contains = (outer: ScreenElement, inner: ScreenElement): boolean =>
	outer.rect.x <= inner.rect.x
	&& outer.rect.y <= inner.rect.y
	&& outer.rect.x + outer.rect.width >= inner.rect.x + inner.rect.width
	&& outer.rect.y + outer.rect.height >= inner.rect.y + inner.rect.height;

/**
 * Retarget a match onto the smallest tappable element enclosing it.
 *
 * Untagged Compose surfaces routinely put the label in a child whose bounds are inset from the row
 * that actually carries the click handler, so `mergeColocated` cannot fuse them and the text match
 * lands on something inert. Walking outward to the nearest clickable ancestor is the same rule the
 * repo's own `DictionaryUnicodeSearchConnectedTest` applies via
 * `generateSequence(node) { it.parent }.firstOrNull { it.isClickable }`.
 *
 * Falls back to the original element when nothing encloses it — tapping the label's centre is
 * still usually inside the row, and a wrong tap beats a hard failure here.
 */
export const clickableAncestor = (elements: ScreenElement[], element: ScreenElement): ScreenElement => {
	if (element.clickable) {
		return element;
	}
	const enclosing = elements
		.filter(candidate => candidate.clickable && contains(candidate, element))
		.sort((a, b) => area(a) - area(b));
	return enclosing[0] ?? element;
};

export interface StabilityResult {
	stable: boolean;
	waitedMs: number;
	/** How many accessibility-tree dumps were taken. Each costs roughly two seconds. */
	samples: number;
}

// ---------------------------------------------------------------------------
// Compact tree rendering
// ---------------------------------------------------------------------------

/** Class names whose widget kind actually informs an action decision. Everything else is noise. */
const INFORMATIVE_TYPES = /(EditText|Button|Switch|CheckBox|RadioButton|SeekBar|Slider|ImageView|WebView|ProgressBar|Spinner)$/;

/**
 * One element per line, everything empty omitted.
 *
 * The JSON shape spends most of its bytes on structure: braces, key names, and a nested
 * `coordinates` object per element — on a real app screen that is roughly two thirds of the
 * payload. A line format keeps the same facts (identity, text, geometry, interactivity) at about
 * a third of the tokens, which matters because the tree is the result an agent reads after almost
 * every action. Geometry stays present so coordinate-based tools remain usable from this output.
 *
 * Format, per line:
 *   `#<id> "<text>" (desc) <Type> @x,y wxh clickable focused scrollable hidden`
 * where only the segments that exist appear, and Type only when it is informative
 * (an EditText tells the caller something; `android.view.View` does not). `hidden` marks a node
 * the agent reports as not visible to the user — present in the tree but covered or offscreen —
 * so the model never plans a tap on something the learner cannot see.
 */
export const formatCompactElementLines = (elements: ScreenElement[]): string[] =>
	elements.map(element => {
		const parts: string[] = [];
		if (element.identifier) {
			parts.push(`#${element.identifier}`);
		}
		if (element.text) {
			parts.push(JSON.stringify(element.text));
		}
		if (element.label && element.label !== element.text) {
			parts.push(`(${element.label})`);
		}
		const type = element.type?.match(INFORMATIVE_TYPES)?.[1];
		if (type) {
			parts.push(type);
		}
		parts.push(`@${element.rect.x},${element.rect.y} ${element.rect.width}x${element.rect.height}`);
		if (element.clickable) {
			parts.push("clickable");
		}
		if (element.focused) {
			parts.push("focused");
		}
		if (element.scrollable) {
			parts.push("scrollable");
		}
		if (element.visible === false) {
			parts.push("hidden");
		}
		return parts.join(" ");
	});

export const formatCompactElements = (elements: ScreenElement[]): string =>
	formatCompactElementLines(elements).join("\n");

export interface CompactDiff {
	added: string[];
	removed: string[];
	unchanged: number;
}

/**
 * Multiset difference between two compact renderings of the screen.
 *
 * The full tree costs ~400 tokens on a real app screen and is re-read after almost every
 * action; when only a badge or one row changed, the delta is a few lines. Multiset rather than
 * set: two identical rows (repeated list items) must not cancel a third.
 */
export const computeCompactDiff = (previous: string[], current: string[]): CompactDiff => {
	const counts = new Map<string, number>();
	for (const line of previous) {
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	const added: string[] = [];
	let unchanged = 0;
	for (const line of current) {
		const remaining = counts.get(line) ?? 0;
		if (remaining > 0) {
			counts.set(line, remaining - 1);
			unchanged++;
		} else {
			added.push(line);
		}
	}
	const removed: string[] = [];
	for (const [line, count] of counts) {
		for (let i = 0; i < count; i++) {
			removed.push(line);
		}
	}
	return { added, removed, unchanged };
};

/** How long a liveness answer is trusted before re-probing. */
const AGENT_LIVENESS_TTL_MS = 15_000;

/** Minimum spacing between stability samples, so a fast transport does not spin the device. */
const MIN_SAMPLE_INTERVAL_MS = 60;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Robot
// ---------------------------------------------------------------------------

export class AgentAndroidRobot extends AndroidRobot {

	/**
	 * Last known tree, or null if it may be out of date.
	 *
	 * One dump costs roughly two seconds and dominates every operation, so a tap that immediately
	 * follows a settle should not pay for the tree twice. Any action that could change the screen
	 * drops this, so a stale tree is never used to resolve a selector.
	 */
	private cachedElements: ScreenElement[] | null = null;

	/**
	 * The compact lines last RETURNED by the list tool, for `diff:true`.
	 *
	 * Deliberately not cleared by [invalidate]: the baseline is "what the caller last saw", which
	 * survives the actions between two list calls — that surviving is the entire point of a diff.
	 */
	public lastCompactLines: string[] | null = null;

	private readonly agent = new AgentClient(this.deviceId);

	private agentReady: boolean | null = null;
	private agentCheckedAt = 0;

	/**
	 * Whether the in-process agent is usable right now.
	 *
	 * Deliberately re-checked rather than cached for the process lifetime. The agent dies on every
	 * `adb install -r`, so "probe once at startup" is wrong in exactly the situation that matters:
	 * a long-lived MCP server outlives many installs, and would either keep calling a dead agent or
	 * never notice a live one. The probe costs ~20ms when the agent is absent, which is cheap enough
	 * to repeat on a short interval.
	 */
	public async useAgent(): Promise<boolean> {
		// Escape hatch for measurement and debugging: force the adb path on unchanged code.
		// Without it, auto-start makes an honest agent-vs-adb comparison impossible.
		if (process.env.ANDROID_AGENT_DISABLE === "1") {
			return false;
		}
		const now = Date.now();
		if (this.agentReady !== null && now - this.agentCheckedAt < AGENT_LIVENESS_TTL_MS) {
			return this.agentReady;
		}
		this.agentCheckedAt = now;
		this.agentReady = await this.agent.ensureRunning();
		return this.agentReady;
	}

	/**
	 * Give up on the agent for this call and fall back.
	 *
	 * Called when an agent request throws mid-operation — the process died between the probe and
	 * the call, which is common right after an install.
	 *
	 * Stopping the instrumentation is not cleanup, it is what makes the fallback possible. A device
	 * has exactly one `UiAutomation` connection: while the agent holds it, host-side
	 * `uiautomator dump` is killed on sight. Demoting to adb without releasing it therefore falls
	 * back to a path that is guaranteed to fail, which is worse than the original error. If the
	 * agent was merely wedged rather than dead, `useAgent()` relaunches it on the next call.
	 */
	private demoteAgent(): void {
		this.agentReady = false;
		this.agentCheckedAt = Date.now();
		this.agent.stop();
	}

	/**
	 * React to a failed agent request in proportion to what the failure proves.
	 *
	 * A connection error proves the agent is gone: demote hard, releasing UiAutomation so the adb
	 * path can work. A TIMEOUT proves nothing of the sort — the agent may simply be mid-operation —
	 * and the instrumentation shares the app's process, so force-stopping it on a timeout kills the
	 * learner session this server exists to preserve. Timeouts therefore only drop the cached
	 * liveness answer; the next call re-probes, and if the agent really is wedged while holding
	 * UiAutomation, the killed-dump recovery in [dumpElements] surfaces an actionable error naming
	 * the force-stop command instead of firing it blind.
	 */
	private handleAgentFailure(error: unknown): void {
		if (error instanceof AgentTimeoutError) {
			this.agentReady = false;
			this.agentCheckedAt = Date.now();
			return;
		}
		this.demoteAgent();
	}

	/** Which transport is in play, for reporting. */
	public async transport(): Promise<"agent" | "adb"> {
		return await this.useAgent() ? "agent" : "adb";
	}

	/**
	 * Package owning the topmost application window, or null when it cannot be determined.
	 *
	 * Present on every element-returning result. The single most expensive failure this fork had
	 * was a caller believing a tree belonged to the app under test when it was the launcher's, so
	 * the answer travels with the data rather than sitting behind a separate call nobody makes.
	 */
	public async foregroundPackage(): Promise<string | null> {
		if (await this.useAgent()) {
			try {
				return await this.agent.foreground();
			} catch (error) {
				this.handleAgentFailure(error);
			}
		}
		return this.foregroundPackageViaAdb();
	}

	/** Last foreground seen during a dump, so reporting costs no extra device round trip. */
	private lastForeground: string | null = null;

	/**
	 * Foreground package without the agent.
	 *
	 * `dumpsys activity activities` names the resumed activity, which is the only host-side source
	 * that does not race the window transition the way a tree dump does.
	 */
	private foregroundPackageViaAdb(): string | null {
		try {
			const output = this.adb("shell", "dumpsys", "activity", "activities").toString();
			const match = output.match(/(?:mResumedActivity|topResumedActivity)[^\n]*?\s([\w.]+)\//);
			return match?.[1] ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Report the transport and foreground alongside any payload.
	 *
	 * Every read tool routes its result through here, so degradation is never silent: a caller that
	 * has quietly lost the agent sees `transport:"adb"` on the very next result.
	 */
	public async envelope<T extends object>(payload: T): Promise<T & { transport: string; foreground: string | null; agentProtocolMismatch?: number }> {
		const transport = await this.transport();
		const foreground = transport === "agent"
			? this.lastForeground ?? await this.foregroundPackage()
			: this.foregroundPackageViaAdb();
		const envelope = { ...payload, transport, foreground } as T & {
			transport: string;
			foreground: string | null;
			agentProtocolMismatch?: number;
		};
		if (this.agent.protocolMismatch !== null) {
			envelope.agentProtocolMismatch = this.agent.protocolMismatch;
		}
		return envelope;
	}

	/**
	 * Block until `packageName` owns the topmost application window.
	 *
	 * Falls back to polling the resumed activity when the agent is absent, so the guarantee holds on
	 * both transports rather than only the fast one.
	 */
	public async waitForForeground(packageName: string, timeoutMs = 10000): Promise<boolean> {
		if (await this.useAgent()) {
			try {
				const visible = await this.agent.waitForPackage(packageName, timeoutMs);
				if (visible) {
					this.lastForeground = packageName;
				}
				return visible;
			} catch (error) {
				this.handleAgentFailure(error);
			}
		}
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.foregroundPackageViaAdb() === packageName) {
				return true;
			}
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		return false;
	}

	/**
	 * Screenshot, scaled and compressed as close to the pixels as possible.
	 *
	 * Through the agent the device itself scales and JPEG-encodes, so the wire carries tens of
	 * kilobytes and the host needs no image tooling. Over adb the buffer is `screencap`'s native
	 * PNG and the server does the scaling. Both paths report the returned image's dimensions AND
	 * the native display dimensions, so a caller never infers a scale factor.
	 */
	public async screenshotWithSize(options: { maxWidth?: number; quality?: number; format?: "jpeg" | "png" } = {}): Promise<{
		buffer: Buffer;
		width: number;
		height: number;
		deviceWidth: number;
		deviceHeight: number;
		format: "jpeg" | "png";
	}> {
		if (await this.useAgent()) {
			try {
				const shot = await this.agent.screenshot({ maxWidth: options.maxWidth, quality: options.quality, format: options.format });
				return {
					buffer: Buffer.from(shot.data, "base64"),
					width: shot.width,
					height: shot.height,
					deviceWidth: shot.deviceWidth,
					deviceHeight: shot.deviceHeight,
					format: shot.format === "png" ? "png" : "jpeg",
				};
			} catch (error) {
				this.handleAgentFailure(error);
			}
		}
		const buffer = await this.getScreenshot();
		const size = await this.getScreenSize();
		return { buffer, width: size.width, height: size.height, deviceWidth: size.width, deviceHeight: size.height, format: "png" };
	}

	/** Bring a node on screen through its scrollable ancestor, instead of blind swipes. */
	public async scrollIntoView(selector: ElementSelector, maxScrolls?: number): Promise<ScreenElement> {
		if (!await this.useAgent()) {
			throw new ActionableError(
				"Scrolling to an element needs the in-process agent, which is not running. "
				+ `Start it with: ${agentStartHint(this.deviceId)}`
			);
		}
		const target = await this.agent.scrollIntoView(
			{ id: selector.id, idPrefix: selector.idPrefix, text: selector.text },
			maxScrolls,
		);
		this.invalidate();
		return target ? toScreenElement(target) : await this.requireElement(selector);
	}

	/** Every application and IME window, topmost first. */
	public async windowStack(): Promise<{ windows: unknown[]; foreground: string | null }> {
		if (!await this.useAgent()) {
			throw new ActionableError(
				"Window enumeration needs the in-process agent, which is not running. "
				+ `Start it with: ${agentStartHint(this.deviceId)}`
			);
		}
		return await this.agent.windows();
	}

	/**
	 * Evaluate expectations about the screen, waiting for them to come true.
	 *
	 * An assertion is a wait, not a snapshot. The screen an assertion follows is usually still in
	 * flight — a search debounce, a list population, a navigation transition — and a one-shot check
	 * loses that race by design. Polling until the deadline turns "flaky unless you slept first"
	 * into "passes the moment it is true, fails only when it stayed false".
	 *
	 * Never throws for a failed expectation — the caller needs the evidence, and an exception
	 * carries only a message. `passed` is the verdict; `checks` says which clause decided it.
	 */
	public async assertScreen(
		selector: ElementSelector | undefined,
		expected: {
			exists?: boolean;
			visible?: boolean;
			textEquals?: string;
			minCount?: number;
			foregroundPackage?: string;
		},
		timeoutMs = 4000,
	): Promise<AssertionResult & { waitedMs: number }> {
		const started = Date.now();
		for (;;) {
			this.invalidate();
			const result = await this.assertScreenOnce(selector, expected);
			const waitedMs = Date.now() - started;
			if (result.passed || waitedMs >= timeoutMs) {
				return { ...result, waitedMs };
			}
			// Sampling cadence follows the transport: through the agent a dump costs ~10-100ms so a
			// short pause between polls is right; over adb the ~2s dump IS the pause.
			if (await this.useAgent()) {
				await sleep(150);
			}
		}
	}

	private async assertScreenOnce(
		selector: ElementSelector | undefined,
		expected: {
			exists?: boolean;
			visible?: boolean;
			textEquals?: string;
			minCount?: number;
			foregroundPackage?: string;
		},
	): Promise<AssertionResult> {
		const checks: AssertionCheck[] = [];
		const foreground = await this.foregroundPackage();

		if (expected.foregroundPackage !== undefined) {
			checks.push({
				check: "foregroundPackage",
				expected: expected.foregroundPackage,
				actual: foreground,
				passed: foreground === expected.foregroundPackage,
			});
		}

		const matches = selector ? await this.findElements(selector) : [];
		const best = matches[0];

		if (selector) {
			const shouldExist = expected.exists ?? true;
			checks.push({
				check: "exists",
				expected: shouldExist,
				actual: matches.length > 0,
				passed: (matches.length > 0) === shouldExist,
			});
		}

		if (expected.minCount !== undefined) {
			checks.push({
				check: "minCount",
				expected: expected.minCount,
				actual: matches.length,
				passed: matches.length >= expected.minCount,
			});
		}

		if (expected.visible !== undefined) {
			// The agent reports isVisibleToUser per node and selection ranks visible matches first,
			// so `best.visible` is "does a visible match exist". Over adb visibility is unknowable
			// and the honest answer is to say so rather than guess.
			const transport = await this.transport();
			const bestVisible = Boolean(best && best.visible !== false);
			checks.push({
				check: "visible",
				expected: expected.visible,
				actual: transport === "agent" ? bestVisible : "unknown (adb transport cannot report visibility)",
				passed: transport === "agent" ? bestVisible === expected.visible : false,
			});
		}

		if (expected.textEquals !== undefined) {
			const actual = best ? (best.text ?? best.label ?? "") : null;
			checks.push({
				check: "textEquals",
				expected: expected.textEquals,
				actual,
				passed: actual !== null && foldForMatch(actual) === foldForMatch(expected.textEquals),
			});
		}

		return {
			passed: checks.every(check => check.passed),
			selector: selector ? describeSelector(selector) : null,
			matchCount: matches.length,
			best: best ?? null,
			checks,
		};
	}

	// -------------------------------------------------------------------------
	// Device state
	//
	// A localized app's release gate is a matrix a visible change must survive: Arabic and
	// RTL, Dynamic Type, reduced motion, dark mode, and launching in airplane mode. None of that was
	// reachable from this server, so every one of those passes was done by hand with raw adb and was
	// therefore usually skipped.
	// -------------------------------------------------------------------------

	public getDisplayState(): DisplayState {
		const setting = (namespace: string, key: string): string =>
			this.adb("shell", "settings", "get", namespace, key).toString().trim();
		const night = this.adb("shell", "cmd", "uimode", "night").toString().trim();
		return {
			fontScale: Number(setting("system", "font_scale")) || 1,
			nightMode: night.toLowerCase().includes("yes") ? "yes" : night.toLowerCase().includes("auto") ? "auto" : "no",
			windowAnimationScale: Number(setting("global", "window_animation_scale")) || 0,
			transitionAnimationScale: Number(setting("global", "transition_animation_scale")) || 0,
			animatorDurationScale: Number(setting("global", "animator_duration_scale")) || 0,
			density: Number(
				this.adb("shell", "wm", "density").toString().match(/density:\s*(\d+)/)?.[1] ?? 0,
			),
		};
	}

	/**
	 * Apply display state, omitting anything not named.
	 *
	 * Animation scale is set across all three keys together: leaving one at 1 while zeroing the
	 * others still produces non-deterministic screenshots, which is the usual reason for setting it.
	 */
	public setDisplayState(state: Partial<DisplayStateRequest>): DisplayState {
		if (state.fontScale !== undefined) {
			this.adb("shell", "settings", "put", "system", "font_scale", String(state.fontScale));
		}
		if (state.nightMode !== undefined) {
			this.adb("shell", "cmd", "uimode", "night", state.nightMode);
		}
		if (state.animations !== undefined) {
			// Deliberately a normalization rather than a restore: this does not remember what the
			// device had. Read `getDisplayState()` first if the original scales matter — a developer
			// who runs animations off system-wide will otherwise find them switched back on.
			const scale = state.animations ? "1.0" : "0.0";
			for (const key of ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]) {
				this.adb("shell", "settings", "put", "global", key, scale);
			}
		}
		if (state.density !== undefined) {
			if (state.density === "reset") {
				this.adb("shell", "wm", "density", "reset");
			} else {
				this.adb("shell", "wm", "density", String(state.density));
			}
			this.invalidateScreenSize();
		}
		return this.getDisplayState();
	}

	/**
	 * Airplane mode, for the offline contract that is a release gate rather than a nice-to-have.
	 *
	 * Uses `cmd connectivity`, which applies immediately; the older path wrote a setting and then
	 * broadcast an intent, which needs privileges a normal shell no longer has.
	 */
	public setAirplaneMode(enabled: boolean): { airplaneMode: boolean } {
		this.adb("shell", "cmd", "connectivity", "airplane-mode", enabled ? "enable" : "disable");
		return { airplaneMode: this.getAirplaneMode() };
	}

	public getAirplaneMode(): boolean {
		return this.adb("shell", "cmd", "connectivity", "airplane-mode").toString().trim().includes("enabled");
	}

	/** Drop the agent cooldown after an install, which is what kills it in the first place. */
	public invalidateAgent(): void {
		this.agent.invalidate();
		this.agentReady = null;
		this.agentCheckedAt = 0;
	}

	/**
	 * Launch, arming the fast transport on the way in.
	 *
	 * In **embedded** mode, launching the instrumented app is the one moment an agent restart is
	 * free: the process is being (re)started anyway, so instrument it first and the whole session
	 * runs on the fast path from its first frame. Auto-start at any other time would kill a live
	 * session — see `AgentClient.ensureRunning` — which is why this hook exists at all.
	 *
	 * In **standalone** mode there is no such coupling: the agent lives in its own process, so any
	 * launch is a fine moment to bring it up, whichever app is being launched.
	 */
	public async launchApp(packageName: string, locale?: string): Promise<void> {
		const armsAgent = AGENT_IDENTITY.mode === "standalone" || packageName === AGENT_IDENTITY.targetPackage;
		if (armsAgent && process.env.ANDROID_AGENT_DISABLE !== "1") {
			this.agentReady = await this.agent.ensureRunning({ allowAppRestart: true });
			this.agentCheckedAt = Date.now();
		}
		this.invalidate();
		await super.launchApp(packageName, locale);
	}

	/**
	 * Every instrumentation the device has installed.
	 *
	 * Reported by `mobile_agent_status` when the agent is absent, because the overwhelmingly common
	 * cause is that the driver was never installed — or was installed under a different package
	 * than the one configured. Both are invisible otherwise: the server simply runs slower on adb
	 * and says nothing. Showing the caller what IS installed next to what was EXPECTED makes the
	 * mismatch obvious without a round of debugging.
	 */
	public installedInstrumentations(): { testPackage: string; targetPackage: string }[] {
		try {
			return parseInstrumentations(this.adb("shell", "pm", "list", "instrumentation").toString())
				.map(({ testPackage, targetPackage }) => ({ testPackage, targetPackage }));
		} catch {
			// A device that cannot answer this is a device that cannot run the agent either; the
			// caller already has that news from `transport`.
			return [];
		}
	}

	/**
	 * Force-stopping the package the instrumentation lives in tears the agent down with it. Record
	 * the death instead of discovering it one failed socket call at a time.
	 *
	 * In standalone mode this only fires if a caller force-stops the driver itself, which is a
	 * legitimate way to release the device's single UiAutomation connection.
	 */
	public async terminateApp(packageName: string): Promise<void> {
		this.invalidate();
		await super.terminateApp(packageName);
		if (packageName === AGENT_IDENTITY.targetPackage || packageName === AGENT_IDENTITY.testPackage) {
			this.agentReady = false;
			this.agentCheckedAt = Date.now();
		}
	}

	/**
	 * Dump, merge co-located nodes, and refresh the cache. Always hits the device.
	 *
	 * The agent reads the live tree in-process (~110ms) instead of writing XML to /sdcard and
	 * pulling it (~2300ms), and its nodes already carry distinct identity, so no merge is needed.
	 */
	private async dumpElements(): Promise<ScreenElement[]> {
		let elements: ScreenElement[] | null = null;
		if (await this.useAgent()) {
			try {
				const dumped = await this.agent.dump();
				elements = dumped.elements.map(toScreenElement);
				this.lastForeground = dumped.foreground;
			} catch (error) {
				// The agent died between the liveness probe and this call — routine right after an
				// install. Drop to adb rather than failing the caller. (Timeouts demote softly:
				// the agent may just be busy, and stopping it would kill the app's process.)
				this.handleAgentFailure(error);
			}
		}
		if (elements === null) {
			try {
				elements = mergeColocated(await super.getElementsOnScreen());
			} catch (error: any) {
				// A killed dump means something else holds the device's single UiAutomation
				// connection, and that something is almost always the agent arriving late — the
				// start poll gave up, we degraded to adb, and the instrumentation bound a moment
				// afterwards. Slower hardware makes this routine: measured on the tablet emulator,
				// where launching takes longer than the poll window. The error is therefore
				// evidence the fast path is available, so re-probe and use it instead of failing a
				// caller whose device is working perfectly well.
				if (!/holds this device's single UiAutomation/.test(error?.message ?? "")) {
					throw error;
				}
				// Drop only the cached liveness answer. `invalidateAgent()` would force-stop the
				// instrumentation, which is exactly the agent we just discovered is alive.
				this.agentReady = null;
				this.agentCheckedAt = 0;
				if (!await this.useAgent()) {
					throw error;
				}
				const dumped = await this.agent.dump();
				elements = dumped.elements.map(toScreenElement);
				this.lastForeground = dumped.foreground;
			}
		}
		this.cachedElements = elements;
		return elements;
	}

	/** Invalidate after anything that can move the screen. */
	private invalidate(): void {
		this.cachedElements = null;
		this.lastForeground = null;
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		return this.cachedElements ?? await this.dumpElements();
	}

	public async tap(x: number, y: number): Promise<void> {
		this.invalidate();
		return super.tap(x, y);
	}

	public async longPress(x: number, y: number, duration: number): Promise<void> {
		this.invalidate();
		return super.longPress(x, y, duration);
	}

	/**
	 * Double-tap through the agent's injector when it is up.
	 *
	 * The adb fallback's two `input tap` spawns land 400-600ms apart — outside the platform's
	 * ~300ms double-tap window — so on that path the taps may register as two singles.
	 */
	public async doubleTap(x: number, y: number): Promise<void> {
		this.invalidate();
		if (await this.useAgent()) {
			try {
				await this.agent.doubleTap(x, y);
				return;
			} catch (error) {
				this.handleAgentFailure(error);
			}
		}
		return super.doubleTap(x, y);
	}

	public async swipe(direction: Parameters<AndroidRobot["swipe"]>[0]): Promise<void> {
		this.invalidate();
		return super.swipe(direction);
	}

	public async pressButton(button: Parameters<AndroidRobot["pressButton"]>[0]): Promise<void> {
		this.invalidate();
		return super.pressButton(button);
	}

	/**
	 * Rotation relays out every element, so a tree cached before it describes coordinates that no
	 * longer exist. Missing this override is invisible on a phone that is rarely rotated and
	 * immediate on a tablet, where rotation is a normal part of the adaptive-layout matrix.
	 */
	public async setOrientation(orientation: Parameters<AndroidRobot["setOrientation"]>[0]): Promise<void> {
		this.invalidate();
		return super.setOrientation(orientation);
	}

	/** Stable signature of what is currently on screen. Always samples fresh. */
	private async screenSignature(): Promise<string> {
		const elements = await this.dumpElements();
		return createHash("sha1").update(JSON.stringify(elements)).digest("hex");
	}

	/**
	 * Block until the UI stops changing, or the timeout expires.
	 *
	 * The host-side counterpart to UiAutomator 2.4's `waitForStableInActiveWindow`, which is only
	 * callable from instrumentation. We approximate it by hashing the accessibility tree until
	 * consecutive dumps agree. That covers the cases that actually make device automation flaky
	 * here: a navigation transition still animating, and a list that has laid out but not yet
	 * populated.
	 *
	 * Sample-based rather than duration-based on purpose: one dump of the tree costs roughly two
	 * seconds on this hardware, so "quiet for 600ms" is not a quantity this transport can express.
	 * Stability means N consecutive identical dumps, default two.
	 *
	 * Returns rather than throws on timeout — a caller may legitimately want to act on a surface
	 * that never fully settles, such as one with a looping animation.
	 */
	public async waitForStable(options: { timeoutMs?: number; settleSamples?: number; quietMs?: number; pollMs?: number } = {}): Promise<StabilityResult> {
		const timeoutMs = options.timeoutMs ?? 20000;
		const settleSamples = Math.max(2, options.settleSamples ?? 2);
		const quietMs = options.quietMs ?? 400;
		const pollMs = options.pollMs ?? 0;

		// The on-device loop samples a structural fingerprint at a fixed 120ms cadence with no
		// serialization or socket round trip per sample — the same certainty as the host loop's
		// quiet window at roughly half the wall time. The cache is only invalidated, not re-filled:
		// the next element resolve pays one ~110ms dump if and only if it needs the tree.
		if (await this.useAgent()) {
			try {
				const started = Date.now();
				const stable = await this.agent.waitStable({ timeoutMs, settleSamples });
				this.invalidate();
				return { stable, waitedMs: Date.now() - started, samples: settleSamples };
			} catch (error) {
				this.handleAgentFailure(error);
			}
		}

		const started = Date.now();
		let previous = "";
		let consecutive = 1;
		let unchangedSince = 0;
		let samples = 0;

		for (;;) {
			const sampleStarted = Date.now();
			const signature = await this.screenSignature();
			const sampleCost = Date.now() - sampleStarted;
			samples++;

			if (signature === previous) {
				consecutive++;
				if (unchangedSince === 0) {
					unchangedSince = Date.now();
				}
				// Both conditions, because each alone is wrong on one transport. Over adb a sample
				// costs ~2.3s, so a quiet window is satisfied trivially and only the sample count
				// carries information. Through the agent a sample costs ~90ms, so two identical
				// samples can complete before a tap has even begun to animate — there the elapsed
				// quiet window is what proves the screen actually stopped moving.
				if (consecutive >= settleSamples && Date.now() - unchangedSince >= quietMs) {
					return { stable: true, waitedMs: Date.now() - started, samples };
				}
			} else {
				previous = signature;
				consecutive = 1;
				unchangedSince = 0;
			}

			// Checked after sampling, not before: one sample costs about two seconds, so a
			// pre-check would routinely overshoot the caller's timeout by a whole sample.
			if (Date.now() - started >= timeoutMs) {
				return { stable: false, waitedMs: Date.now() - started, samples };
			}

			// Floor the interval by how long the sample actually took. Over adb a sample costs ~2.3s
			// and this is a no-op; through the agent it costs ~10ms, and without a floor the loop
			// took 50 dumps in 477ms — pointless device CPU for no extra certainty.
			const wait = Math.max(pollMs, MIN_SAMPLE_INTERVAL_MS - sampleCost);
			if (wait > 0) {
				await sleep(wait);
			}
		}
	}

	public async findElements(selector: ElementSelector): Promise<ScreenElement[]> {
		return selectElements(await this.getElementsOnScreen(), selector);
	}

	/**
	 * Resolve exactly one element, or fail with something a caller can act on.
	 *
	 * The failure path lists what *is* addressable. A bare "not found" forces the caller to dump
	 * the whole tree to make progress, which is the slowest possible next step.
	 */
	public async requireElement(selector: ElementSelector): Promise<ScreenElement> {
		const elements = await this.getElementsOnScreen();
		const matches = selectElements(elements, selector);
		if (matches.length > 0) {
			return matches[0];
		}

		const addressable = elements
			.map(e => e.identifier)
			.filter((id): id is string => typeof id === "string" && id.length > 0)
			.filter(id => !id.startsWith("android:") && !id.includes(":id/"));

		throw new ActionableError(
			`No element matched ${describeSelector(selector)}. `
			+ (addressable.length > 0
				? `Addressable test tags on screen: ${addressable.join(", ")}.`
				: "No test tags are present on this screen — it may still be loading, or the surface is untagged.")
			+ " Use mobile_list_elements_on_screen for the full tree."
		);
	}

	/** Whether the soft keyboard is currently on screen. */
	public isKeyboardShown(): boolean {
		try {
			return this.adb("shell", "dumpsys", "input_method").toString().includes("mInputShown=true");
		} catch {
			return false;
		}
	}

	/**
	 * Dismiss the soft keyboard and wait for it to actually leave.
	 *
	 * Returns whether anything was dismissed, so callers can report the side effect rather than
	 * silently reshaping the screen.
	 */
	public async dismissKeyboard(): Promise<boolean> {
		if (!this.isKeyboardShown()) {
			return false;
		}
		await this.pressButton("BACK");
		for (let attempt = 0; attempt < 10; attempt++) {
			if (!this.isKeyboardShown()) {
				break;
			}
			await sleep(150);
		}
		this.invalidate();
		return true;
	}

	/**
	 * Tap the centre of the element a selector resolves to.
	 *
	 * The soft keyboard is the single biggest source of phantom taps here. `uiautomator dump`
	 * reports every element in screen coordinates whether or not the IME is covering it, so a row
	 * that resolves cleanly at y=1318 can sit behind a keyboard that starts at y=1310 — the tap
	 * lands on a key and the screen does not change, with nothing in the tree to explain why.
	 *
	 * Rather than chase per-OEM IME geometry, dismiss the keyboard whenever the target is not the
	 * focused field, then re-resolve against the settled layout. That is what a person does, and it
	 * removes the failure mode instead of detecting it.
	 */
	public async tapOnElement(selector: ElementSelector, options: { dismissKeyboard?: boolean } = {}): Promise<ScreenElement> {
		// The agent dispatches ACTION_CLICK to the node itself. There is no tap point, so keyboard
		// occlusion, scroll offset and mid-animation relayout stop being able to misdirect a tap.
		if (await this.useAgent() && (selector.id || selector.idPrefix || selector.text)) {
			try {
				const target = await this.agent.click({ id: selector.id, idPrefix: selector.idPrefix, text: selector.text });
				this.invalidate();
				if (target) {
					return toScreenElement(target);
				}
				return await this.requireElement(selector);
			} catch (error: any) {
				if (/no node matched/i.test(error?.message ?? "")) {
					// The agent's bare message strands the caller. Fall through to the coordinate
					// path: its fresh dump either resolves the race (agent snapshot was momentarily
					// stale) and taps, or fails listing the addressable tags actually on screen —
					// the difference between one recovery step and a blind screenshot loop.
					this.invalidate();
				} else {
					this.handleAgentFailure(error);
				}
			}
		}

		let element = await this.requireElement(selector);

		if (options.dismissKeyboard !== false && !element.focused && this.isKeyboardShown()) {
			await this.dismissKeyboard();
			await this.waitForStable({ timeoutMs: 10000 });
			// Coordinates from the keyboard-up layout no longer apply.
			element = await this.requireElement(selector);
		}

		element = clickableAncestor(await this.getElementsOnScreen(), element);

		const x = Math.round(element.rect.x + element.rect.width / 2);
		const y = Math.round(element.rect.y + element.rect.height / 2);
		await this.tap(x, y);
		return element;
	}

	/**
	 * Reject non-ASCII entry with a usable explanation.
	 *
	 * `adb shell input text` maps characters onto key events and throws outside ASCII, so Arabic,
	 * Cyrillic and the Uzbek turned comma cannot be typed from the host. Upstream's answer is a
	 * third-party APK; we do not install one. The supported route is
	 * AccessibilityNodeInfo ACTION_SET_TEXT from instrumentation, which is Unicode-safe and needs
	 * no keyboard — see DictionaryUnicodeSearchConnectedTest in android-native.
	 */
	public async sendKeys(text: string): Promise<void> {
		if (text === "") {
			return;
		}
		// The agent pastes at the cursor's end (mode "append") — the semantics of *typing* into a
		// focused field, matching what `adb shell input text` does, so the two transports agree.
		// Unicode-safe with no keyboard installed.
		if (await this.useAgent()) {
			try {
				this.invalidate();
				await this.agent.setText({}, text, "append");
				return;
			} catch (error) {
				this.handleAgentFailure(error);
			}
		}

		if (text !== "" && !/^[\x00-\x7F]*$/.test(text)) {
			throw new ActionableError(
				`Cannot type "${text}" from the host: adb input text is ASCII-only, and this string is not. `
				+ "Non-ASCII entry needs AccessibilityNodeInfo ACTION_SET_TEXT, which the in-process agent "
				+ `provides but is not currently running. Start it with: ${agentStartHint(this.deviceId)}`
			);
		}
		this.invalidate();
		await super.sendKeys(text);
	}

	/** Set a named field's contents directly. Unicode-safe; requires the agent. */
	public async setTextOn(selector: ElementSelector, value: string): Promise<ScreenElement> {
		if (!await this.useAgent()) {
			throw new ActionableError(
				"Targeted text entry needs the in-process agent, which is not running. "
				+ `Start it with: ${agentStartHint(this.deviceId)}`
			);
		}
		try {
			const target = await this.agent.setText({ id: selector.id, text: selector.text }, value);
			this.invalidate();
			return target ? toScreenElement(target) : await this.requireElement(selector);
		} catch (error: any) {
			if (/no node matched/i.test(error?.message ?? "")) {
				this.invalidate();
				// Throws the rich addressable-tags error when the field truly is not there.
				await this.requireElement(selector);
			} else {
				this.handleAgentFailure(error);
			}
			throw error;
		}
	}

	/**
	 * Long-press the element a selector resolves to.
	 *
	 * Through the agent, ACTION_LONG_CLICK is dispatched to the node itself; the same
	 * verified-change-with-gesture-fallback contract as tapping applies. Over adb it degrades to a
	 * timed press at the element's centre.
	 */
	public async longPressOnElement(selector: ElementSelector, durationMs = 600): Promise<ScreenElement> {
		if (await this.useAgent() && (selector.id || selector.idPrefix || selector.text)) {
			try {
				const target = await this.agent.longClick({ id: selector.id, idPrefix: selector.idPrefix, text: selector.text });
				this.invalidate();
				if (target) {
					return toScreenElement(target);
				}
				return await this.requireElement(selector);
			} catch (error: any) {
				if (/no node matched/i.test(error?.message ?? "")) {
					// Same contract as tapOnElement: fall through to the coordinate path for either
					// a race-resolving press or a failure that names what is addressable.
					this.invalidate();
				} else {
					this.handleAgentFailure(error);
				}
			}
		}

		const element = clickableAncestor(await this.getElementsOnScreen(), await this.requireElement(selector));
		const x = Math.round(element.rect.x + element.rect.width / 2);
		const y = Math.round(element.rect.y + element.rect.height / 2);
		await this.longPress(x, y, durationMs);
		return element;
	}

	/**
	 * Drive one finger through a timed path — drags, curves, long-press-then-drag.
	 *
	 * `adb shell input swipe` can only express a straight line at constant speed, so anything
	 * path-shaped requires the agent's MotionEvent injection.
	 */
	public async gesturePath(points: GesturePoint[], holdMs?: number): Promise<void> {
		if (points.length < 2) {
			throw new ActionableError("A gesture needs at least 2 points.");
		}
		if (!await this.useAgent()) {
			// A plain two-point path with no hold is exactly what `input swipe` expresses; anything
			// richer has no adb encoding, so refuse with the fix rather than silently approximating.
			if (points.length === 2 && !holdMs) {
				const [from, to] = points;
				const duration = Math.max(to.dtMs ?? 300, 50);
				this.invalidate();
				this.adb("shell", "input", "swipe",
													String(Math.round(from.x)), String(Math.round(from.y)),
													String(Math.round(to.x)), String(Math.round(to.y)), String(duration));
				return;
			}
			throw new ActionableError(
				"Multi-point or hold-first gestures need the in-process agent, which is not running. "
				+ `Start it with: ${agentStartHint(this.deviceId)}`
			);
		}
		this.invalidate();
		await this.agent.gesture(points, holdMs);
	}

	/** Two-finger pinch. No adb fallback exists: a host shell cannot inject a second finger. */
	public async pinchGesture(request: PinchRequest): Promise<void> {
		if (!await this.useAgent()) {
			throw new ActionableError(
				"Pinch needs the in-process agent — adb cannot inject a second finger. "
				+ `Start it with: ${agentStartHint(this.deviceId)}`
			);
		}
		this.invalidate();
		await this.agent.pinch(request);
	}

	// -------------------------------------------------------------------------
	// App environment: locale, permissions, data, network, logs
	// -------------------------------------------------------------------------

	/** Per-app locales (API 33+). Empty string clears back to the system locale. */
	public getAppLocale(packageName: string): string {
		const output = this.adb("shell", "cmd", "locale", "get-app-locales", packageName).toString();
		// Output shape: "Locales for com.example.app for user 0 are [ar-SA]".
		return output.match(/\[([^\]]*)\]/)?.[1] ?? "";
	}

	public setAppLocale(packageName: string, locales: string): { packageName: string; locales: string } {
		this.adb("shell", "cmd", "locale", "set-app-locales", packageName, "--locales", locales);
		this.invalidate();
		return { packageName, locales: this.getAppLocale(packageName) };
	}

	/**
	 * Runtime permissions as the package manager reports them, name -> granted.
	 *
	 * Parsed from `dumpsys package`, whose "runtime permissions:" section is the truth the app
	 * actually experiences — `pm list permissions` only describes what exists, not what this app
	 * holds.
	 */
	public listPermissions(packageName: string): Record<string, boolean> {
		const output = this.adb("shell", "dumpsys", "package", packageName).toString();
		const granted: Record<string, boolean> = {};
		for (const match of output.matchAll(/^\s+([\w.]+): granted=(true|false)/gm)) {
			granted[match[1]] = match[2] === "true";
		}
		return granted;
	}

	public grantPermission(packageName: string, permission: string): void {
		this.adb("shell", "pm", "grant", packageName, permission);
	}

	public revokePermission(packageName: string, permission: string): void {
		this.adb("shell", "pm", "revoke", packageName, permission);
	}

	/**
	 * Erase an app's data — the reset-to-first-launch primitive deterministic flows start from.
	 * Also kills every process of the package, including instrumentation running inside it.
	 */
	public clearAppData(packageName: string): void {
		this.adb("shell", "pm", "clear", packageName);
		this.invalidate();
	}

	/** Version, install time and running state, so a caller can verify what it is testing. */
	public appInfo(packageName: string): { packageName: string; versionName: string | null; versionCode: string | null; running: boolean; pid: number | null } {
		const output = this.adb("shell", "dumpsys", "package", packageName).toString();
		const versionName = output.match(/versionName=([\S]+)/)?.[1] ?? null;
		const versionCode = output.match(/versionCode=(\d+)/)?.[1] ?? null;
		let pid: number | null = null;
		try {
			const raw = this.silentAdb("shell", "pidof", "-s", packageName).toString().trim();
			pid = raw ? Number(raw) : null;
		} catch {
			pid = null;
		}
		return { packageName, versionName, versionCode, running: pid !== null, pid };
	}

	/** Wifi and mobile-data state alongside airplane mode — the whole connectivity picture. */
	public getNetworkState(): { airplaneMode: boolean; wifi: boolean; mobileData: boolean } {
		const wifi = this.adb("shell", "cmd", "wifi", "status").toString().toLowerCase().includes("wifi is enabled");
		const data = this.adb("shell", "settings", "get", "global", "mobile_data").toString().trim() === "1";
		return { airplaneMode: this.getAirplaneMode(), wifi, mobileData: data };
	}

	public setNetworkState(state: { wifi?: boolean; mobileData?: boolean }): { airplaneMode: boolean; wifi: boolean; mobileData: boolean } {
		if (state.wifi !== undefined) {
			this.adb("shell", "cmd", "wifi", "set-wifi-enabled", state.wifi ? "enabled" : "disabled");
		}
		if (state.mobileData !== undefined) {
			this.adb("shell", "svc", "data", state.mobileData ? "enable" : "disable");
		}
		return this.getNetworkState();
	}

	/** Device time in the `MM-DD hh:mm:ss.mmm` shape `logcat -T` accepts. */
	public deviceLogTime(): string {
		// adb re-joins its argv with spaces before the device shell re-splits, so the format string
		// must carry its own quoting to survive as one argument.
		return this.adb("shell", "date", "'+%m-%d %H:%M:%S.000'").toString().trim();
	}

	/**
	 * Read the device log, scoped tightly enough to be quotable.
	 *
	 * An unfiltered logcat on a Samsung produces thousands of lines per minute, which as a tool
	 * result is pure noise. Scope by pid when a package is named (the only reliable per-app
	 * filter), by priority otherwise, and always cap the tail.
	 */
	public readLogcat(options: {
		packageName?: string;
		priority?: "V" | "D" | "I" | "W" | "E" | "F";
		tag?: string;
		lines?: number;
		sinceDeviceTime?: string;
		buffers?: string[];
	}): { text: string; pid: number | null; truncated: boolean } {
		const lines = Math.min(Math.max(options.lines ?? 200, 1), 2000);
		const args = ["logcat", "-d", "-v", "time"];

		if (options.buffers && options.buffers.length > 0) {
			for (const buffer of options.buffers) {
				args.push("-b", buffer);
			}
		} else {
			args.push("-b", "main", "-b", "crash");
		}

		if (options.sinceDeviceTime) {
			// Contains a space; must survive the device shell's re-split as one argument.
			args.push("-T", `'${options.sinceDeviceTime.replace(/[^0-9:. -]/g, "")}'`);
		} else {
			args.push("-t", String(lines));
		}

		let pid: number | null = null;
		if (options.packageName) {
			try {
				const raw = this.silentAdb("shell", "pidof", "-s", options.packageName).toString().trim();
				pid = raw ? Number(raw) : null;
			} catch {
				pid = null;
			}
			if (pid !== null) {
				args.push("--pid", String(pid));
			}
			// A package with no live process has no pid to filter by; the caller is told rather
			// than silently receiving the whole device's log.
		}

		const priority = options.priority ?? "I";
		const spec = options.tag ? `${options.tag}:${priority}` : `*:${priority}`;
		if (options.tag) {
			args.push("-s");
		}
		args.push(spec);

		const raw = this.adb("shell", ...args).toString();
		const allLines = raw.split("\n");
		const kept = allLines.slice(Math.max(0, allLines.length - lines));
		let text = kept.join("\n").trim();
		let truncated = allLines.length > kept.length;
		if (text.length > 64_000) {
			text = text.slice(text.length - 64_000);
			truncated = true;
		}
		return { text, pid, truncated };
	}
}
