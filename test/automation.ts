import { test, expect } from "@playwright/test";

import { computeCompactDiff, formatCompactElements, foldForMatch, mergeColocated, selectElements } from "../src/automation";
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
