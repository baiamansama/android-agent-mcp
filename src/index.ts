#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./server";
import { error } from "./logger";

/**
 * Stdio only. Upstream also carried an Express/SSE listener; this fork is registered in the
 * repo's `.mcp.json` as a local stdio server and drives real developer devices, so a network
 * listener is pure attack surface with no caller — removed along with the express/qs/commander
 * dependencies it justified.
 */
const main = async () => {
	try {
		// Exit cleanly on termination signals so node flushes pending work
		// (including NODE_V8_COVERAGE output). Node's default SIGINT/SIGTERM
		// handling terminates the process without writing the coverage file,
		// which makes the `test:mcp` report come back all zeros.
		const shutdown = () => {
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		serveStdio(createMcpServer);
		error("android-agent-mcp running on stdio");
	} catch (err: any) {
		console.error("Fatal error in main():", err);
		error("Fatal error in main(): " + JSON.stringify(err.stack));
		process.exit(1);
	}
};

main().then();
