import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { config } from "./config.js";

let LOG_FILE: string;
try {
	fs.mkdirSync(config.logDir, { recursive: true });
	LOG_FILE = path.join(config.logDir, "app.log");
} catch (err) {
	const fallback = path.resolve("data", "logs", "app.log");
	try {
		fs.mkdirSync(path.dirname(fallback), { recursive: true });
	} catch (innerErr) {
		const code =
			(innerErr as NodeJS.ErrnoException).code ??
			(err as NodeJS.ErrnoException).code;
		throw new Error(
			`Cannot create a log directory — tried "${config.logDir}" and fallback "./data/logs". ` +
			`Last error: ${code}. Fix permissions on one of them, or set DF_LOG_DIR to a writable path.`,
			{ cause: innerErr },
		);
	}
	process.stderr.write(
		`[logger] cannot write to ${config.logDir}, falling back to ${fallback}\n`,
	);
	LOG_FILE = fallback;
}

export const logger = pino(
	{
		level: process.env.DEBUG ? "debug" : "info",
	},
	pino.destination(LOG_FILE),
);
