import { test, expect } from "@playwright/test";

import { AgentAndroidRobot, compactForDisplay, isInteractive, computeCompactDiff, formatCompactElementLines, formatCompactElements, foldForMatch, mergeColocated, selectElements, summarizeTags } from "../src/automation";
import { ScreenElement } from "../src/robot";

const element = (partial: Partial<ScreenElement>): ScreenElement => ({
	type: "android.view.View",
	rect: { x: 0, y: 0, width: 100, height: 50 },
	...partial,
});

test.describe("formatCompactElements", () => {

	test("renders identity, text and geometry on one line", () => {
		const line = formatCompactElements([element({
			identifier: "shell.dock.home",
			text: "Path",
			clickable: true,
			rect: { x: 24, y: 2148, width: 96, height: 96 },
		})]);
		expect(line).toBe("#shell.dock.home \"Path\" @24,2148 96x96 clickable");
	});

	test("omits empty segments and duplicated labels", () => {
		const line = formatCompactElements([element({
			text: "Listen",
			label: "Listen",
			rect: { x: 1, y: 2, width: 3, height: 4 },
		})]);
		expect(line).toBe("\"Listen\" @1,2 3x4");
	});

	test("keeps a label distinct from the text", () => {
		const line = formatCompactElements([element({
			text: "0/7",
			label: "This week is still unwritten.",
		})]);
		expect(line).toContain("\"0/7\"");
		expect(line).toContain("(This week is still unwritten.)");
	});

	test("names only informative widget types", () => {
		const lines = formatCompactElements([
			element({ type: "android.widget.EditText", focused: true }),
			element({ type: "android.view.View", text: "plain" }),
		]).split("\n");
		expect(lines[0]).toContain("EditText");
		expect(lines[0]).toContain("focused");
		expect(lines[1]).not.toContain("View");
	});

	test("is a fraction of the verbose JSON payload", () => {
		const elements = Array.from({ length: 40 }, (_, i) => element({
			identifier: `dictionary.search.result.${i}`,
			text: `كِتَاب ${i}`,
			label: "result row",
			clickable: true,
			rect: { x: 0, y: i * 120, width: 1080, height: 120 },
		}));
		const compact = formatCompactElements(elements).length;
		const verbose = JSON.stringify(elements.map(e => ({
			type: e.type, text: e.text, label: e.label, identifier: e.identifier,
			coordinates: { x: e.rect.x, y: e.rect.y, width: e.rect.width, height: e.rect.height },
		}))).length;
		expect(compact).toBeLessThan(verbose / 2);
	});
});

test.describe("compact display (0.3.0)", () => {

	const screen = element({ identifier: "android:id/content", rect: { x: 0, y: 0, width: 1080, height: 2424 } });

	test("drops framework wrappers but keeps app test tags", () => {
		const shown = compactForDisplay([
			screen,
			element({ identifier: "app:id/action_bar_root", rect: { x: 0, y: 0, width: 1080, height: 2424 } }),
			element({ identifier: "home.first-useful-content", rect: { x: 0, y: 0, width: 1080, height: 2424 } }),
		]);
		expect(shown.map(e => e.identifier)).toEqual(["home.first-useful-content"]);
	});

	test("an unlabelled clickable absorbs the words inside it", () => {
		const lines = formatCompactElementLines(compactForDisplay([
			screen,
			element({ clickable: true, rect: { x: 2200, y: 666, width: 96, height: 112 } }),
			element({ label: "Save to a collection", rect: { x: 2224, y: 698, width: 48, height: 48 } }),
		]));
		expect(lines).toEqual(["\"Save to a collection\" @2200,666 96x112 clickable"]);
	});

	test("a labelled row drops the children its label already says", () => {
		const lines = formatCompactElementLines(compactForDisplay([
			screen,
			element({ identifier: "dictionary.search.result.1", clickable: true, rect: { x: 248, y: 336, width: 1448, height: 221 } }),
			element({ label: "\u2067كِتَاب\u2069, \u2066book\u2069, Nome", rect: { x: 248, y: 336, width: 1448, height: 221 } }),
			element({ text: "\u2066nome\u2069", rect: { x: 1489, y: 372, width: 67, height: 38 } }),
			element({ text: "\u2066book\u2069", rect: { x: 288, y: 476, width: 74, height: 53 } }),
			element({ text: "Tap for more", visible: false, rect: { x: 288, y: 500, width: 74, height: 20 } }),
		]));
		// Fused with its same-bounds label, children it repeats removed, bidi isolates gone; a hidden
		// child is never absorbed, so its `hidden` marker survives.
		expect(lines).toEqual([
			"#dictionary.search.result.1 (كِتَاب, book, Nome) @248,336 1448x221 clickable",
			"\"Tap for more\" @288,500 74x20 hidden",
		]);
	});

	test("an open keyboard collapses to one line and survives the interactive filter", () => {
		const shown = compactForDisplay([
			element({ identifier: "dictionary.search.field", clickable: true, rect: { x: 0, y: 176, width: 1080, height: 112 } }),
			...Array.from({ length: 30 }, (_, i) => element({ label: `${i}`, clickable: true, ime: true, rect: { x: (i % 10) * 107, y: 1589 + Math.floor(i / 10) * 131, width: 107, height: 131 } })),
		]);
		expect(shown).toHaveLength(2);
		const lines = formatCompactElementLines(shown.filter(isInteractive));
		expect(lines[1]).toBe("(soft keyboard open — mobile_press_button BACK dismisses it) @0,1589 1070x393");
	});

	test("a word goes to its smallest enclosing control, not the card around it", () => {
		const lines = formatCompactElementLines(compactForDisplay([
			screen,
			element({ clickable: true, rect: { x: 0, y: 200, width: 1080, height: 600 } }),
			element({ text: "Word of the day", rect: { x: 40, y: 220, width: 400, height: 40 } }),
			element({ clickable: true, rect: { x: 900, y: 220, width: 160, height: 96 } }),
			element({ text: "Retry", rect: { x: 920, y: 240, width: 100, height: 40 } }),
		]));
		expect(lines).toEqual([
			"\"Word of the day\" @0,200 1080x600 clickable",
			"\"Retry\" @900,220 160x96 clickable",
		]);
	});

	test("a selected tab absorbs its label even though it reports clickable=false", () => {
		const lines = formatCompactElementLines(compactForDisplay([
			screen,
			element({ identifier: "shell.dock.home", selected: true, rect: { x: 115, y: 2172, width: 212, height: 168 } }),
			element({ text: "Path", rect: { x: 149, y: 2275, width: 146, height: 48 } }),
		]));
		expect(lines).toEqual(["#shell.dock.home \"Path\" @115,2172 212x168 selected"]);
	});

	test("reports disabled, selected and toggle state", () => {
		const lines = formatCompactElementLines([
			element({ text: "Continue", clickable: true, enabled: false }),
			element({ identifier: "shell.dock.home", selected: true }),
			element({ text: "Reminders", checked: false }),
		]);
		expect(lines[0]).toContain("disabled");
		expect(lines[1]).toContain("selected");
		expect(lines[2]).toContain("unchecked");
	});

	test("tag families collapse to the prefix a caller should use", () => {
		expect(summarizeTags([
			"shell.dock.home",
			"dictionary.search.result.dc83",
			"dictionary.search.result.68f8",
			"dictionary.search.result.e762",
			"dictionary.search.field",
		])).toEqual(["shell.dock.home", "dictionary.search.result.* (3)", "dictionary.search.field"]);
	});
});

test.describe("selection still composes with folding", () => {

	test("finds vocalized arabic via unvocalized selector after merge", () => {
		const merged = mergeColocated([
			element({ identifier: "dictionary.search.result.abc" }),
			element({ text: "كِتَاب" }),
		]);
		expect(merged).toHaveLength(1);
		const matches = selectElements(merged, { text: "كتاب" });
		expect(matches).toHaveLength(1);
		expect(matches[0].identifier).toBe("dictionary.search.result.abc");
	});

	test("folds uzbek apostrophe variants", () => {
		expect(foldForMatch("oʻqish")).toBe(foldForMatch("o'qish"));
	});
});

test.describe("visibility travels the whole pipeline", () => {

	test("hidden and scrollable render in the compact format", () => {
		const lines = formatCompactElements([
			element({ identifier: "memory.list", scrollable: true, visible: true }),
			element({ identifier: "memory.row.offscreen", visible: false }),
		]).split("\n");
		expect(lines[0]).toContain("scrollable");
		expect(lines[0]).not.toContain("hidden");
		expect(lines[1]).toContain("hidden");
	});

	test("a visible match outranks a hidden one regardless of size", () => {
		const matches = selectElements([
			element({ identifier: "row", visible: false, clickable: true, rect: { x: 0, y: 0, width: 10, height: 10 } }),
			element({ identifier: "row", visible: true, clickable: false, rect: { x: 0, y: 0, width: 1000, height: 1000 } }),
		], { id: "row" });
		expect(matches[0].visible).toBe(true);
	});

	test("unknown visibility (adb transport) ranks with visible, not hidden", () => {
		const matches = selectElements([
			element({ identifier: "row", visible: false, rect: { x: 0, y: 0, width: 10, height: 10 } }),
			element({ identifier: "row", rect: { x: 0, y: 0, width: 1000, height: 1000 } }),
		], { id: "row" });
		expect(matches[0].visible).toBeUndefined();
	});

	test("merge carries visibility and scrollability across colocated nodes", () => {
		const merged = mergeColocated([
			element({ identifier: "reader.page", visible: true }),
			element({ text: "قصة", scrollable: true }),
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0].visible).toBe(true);
		expect(merged[0].scrollable).toBe(true);
	});
});

test.describe("computeCompactDiff", () => {

	test("reports added, removed and unchanged as a multiset", () => {
		const diff = computeCompactDiff(
			["a", "b", "b", "c"],
			["a", "b", "d"],
		);
		expect(diff.added).toEqual(["d"]);
		expect(diff.removed.sort()).toEqual(["b", "c"]);
		expect(diff.unchanged).toBe(2);
	});

	test("identical trees diff to nothing", () => {
		const lines = ["#shell.dock.home \"Path\" @24,2148 96x96 clickable"];
		const diff = computeCompactDiff(lines, lines);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
		expect(diff.unchanged).toBe(1);
	});
});

test("foreground-only assertions do not require or evaluate an element selector", async () => {
	const robot = Object.create(AgentAndroidRobot.prototype) as AgentAndroidRobot;
	(robot as any).invalidate = () => undefined;
	(robot as any).foregroundPackage = async () => "com.example.app";
	(robot as any).findElements = async () => {
		throw new Error("element lookup must not run");
	};

	const result = await robot.assertScreen(
		undefined,
		{ foregroundPackage: "com.example.app" },
		0,
	);

	expect(result.passed).toBe(true);
	expect(result.selector).toBeNull();
	expect(result.matchCount).toBe(0);
	expect(result.checks).toEqual([{
		check: "foregroundPackage",
		expected: "com.example.app",
		actual: "com.example.app",
		passed: true,
	}]);
});

test("screen invalidation prevents stale foreground metadata", async () => {
	const robot = Object.create(AgentAndroidRobot.prototype) as AgentAndroidRobot;
	(robot as any).lastForeground = "com.android.launcher";
	(robot as any).cachedElements = [];
	(robot as any).agent = { protocolMismatch: null };
	(robot as any).transport = async () => "agent";
	(robot as any).foregroundPackage = async () => "com.example.app";

	(robot as any).invalidate();
	const result = await robot.envelope({ ok: true });

	expect(result.foreground).toBe("com.example.app");
});

test("a confirmed agent foreground refreshes envelope metadata", async () => {
	const robot = Object.create(AgentAndroidRobot.prototype) as AgentAndroidRobot;
	(robot as any).lastForeground = "com.android.launcher";
	(robot as any).useAgent = async () => true;
	(robot as any).agent = {
		waitForPackage: async () => true,
		protocolMismatch: null,
	};
	(robot as any).transport = async () => "agent";

	expect(await robot.waitForForeground("com.example.app", 100)).toBe(true);
	const result = await robot.envelope({ ok: true });

	expect(result.foreground).toBe("com.example.app");
});
