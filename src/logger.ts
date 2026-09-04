import { appendFileSync } from "node:fs";

const writeLog = (message: string, stderr: boolean) => {
	if (process.env.LOG_FILE) {
		const logfile = process.env.LOG_FILE;
		const timestamp = new Date().toISOString();
		const levelStr = "INFO";
		const logMessage = `[${timestamp}] ${levelStr} ${message}`;
		appendFileSync(logfile, logMessage + "\n");
	}

	if (stderr) {
		console.error(message);
	}
};

export const trace = (message: string) => {
	// Stdio clients surface stderr as tool chatter. Normal operation stays silent;
	// LOG_FILE still records traces without reflecting every result into model context.
	writeLog(message, process.env.ANDROID_AGENT_MCP_DEBUG === "1");
};

export const error = (message: string) => {
	writeLog(message, true);
};
