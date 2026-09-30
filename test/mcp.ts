import { test, expect } from "@playwright/test";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";

import { describeTap } from "../src/server";

const readMessage = (child: ChildProcessWithoutNullStreams, timeoutMs = 5_000): Promise<any> =>
	new Promise((resolve, reject) => {
		let pending = "";
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for MCP response. stderr: ${pending}`));
		}, timeoutMs);
		const onData = (chunk: Buffer) => {
			pending += chunk.toString();
			const newline = pending.indexOf("\n");
			if (newline < 0) {
				return;
			}
			const line = pending.slice(0, newline);
			cleanup();
			resolve(JSON.parse(line));
		};
		const cleanup = () => {
			clearTimeout(timeout);
			child.stdout.off("data", onData);
		};
		child.stdout.on("data", onData);
	});

const send = (child: ChildProcessWithoutNullStreams, message: Record<string, unknown>) => {
	child.stdin.write(`${JSON.stringify(message)}\n`);
};

test("stdio handshake exposes a compact, annotated tool catalog", async () => {
	const child = spawn(process.execPath, [path.resolve("lib/index.js")], { stdio: ["pipe", "pipe", "pipe"] });
	try {
		send(child, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "wire-test", version: "1.0.0" },
			},
		});
		const initialized = await readMessage(child);
		expect(initialized.result.protocolVersion).toBe("2025-11-25");
		// The operating manual rides the handshake, so a client can place it in context once.
		expect(initialized.result.instructions).toContain("mobile_run_steps");

		send(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
		send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		const listed = await readMessage(child);
		const tools = listed.result.tools as Array<any>;
		expect(tools).toHaveLength(31);
		// Consolidated in 0.3.0: each of these is now a parameter of a surviving tool.
		for (const removed of ["mobile_get_screen_size", "mobile_save_screenshot", "mobile_find_elements", "mobile_double_tap_on_screen"]) {
			expect(tools.find(tool => tool.name === removed)).toBeUndefined();
		}
		const performance = tools.find(tool => tool.name === "mobile_performance");
		expect(performance).toBeTruthy();
		expect(performance.annotations).toMatchObject({ destructiveHint: true, openWorldHint: false });
		expect(performance.inputSchema.properties.kind.enum).toContain("perfetto");
	} finally {
		child.kill("SIGTERM");
	}
});

test("stdio serves the stateless 2026-07-28 protocol era", async () => {
	const child = spawn(process.execPath, [path.resolve("lib/index.js")], { stdio: ["pipe", "pipe", "pipe"] });
	const meta = {
		"io.modelcontextprotocol/protocolVersion": "2026-07-28",
		"io.modelcontextprotocol/clientInfo": { name: "wire-test", version: "1.0.0" },
		"io.modelcontextprotocol/clientCapabilities": {},
	};
	try {
		send(child, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } });
		const discovered = await readMessage(child);
		expect(discovered.result.supportedVersions).toContain("2026-07-28");
		expect(discovered.result._meta["io.modelcontextprotocol/serverInfo"].version).toBe("0.3.0");

		send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } });
		const listed = await readMessage(child);
		expect(listed.result.tools).toHaveLength(31);
		expect(listed.result.resultType).toBe("complete");
	} finally {
		child.kill("SIGTERM");
	}
});

test("tap reports say how the tap landed and whether it was ambiguous", () => {
	const element = { type: "android.view.View", identifier: "shell.dock.library", rect: { x: 0, y: 0, width: 100, height: 100 } };
	expect(describeTap({ element, method: "node", matchCount: 1 })).toBe("Tapped shell.dock.library (screen changed)");
	expect(describeTap({ element, method: "gesture", changed: false, matchCount: 1 })).toContain("the screen did not change");
	expect(describeTap({ element, method: "coordinates", matchCount: 1 })).toContain("at 50,50 over adb");
	expect(describeTap({ element, method: "node", matchCount: 6 })).toContain("6 elements matched; pass index");
});
