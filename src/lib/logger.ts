import path from "node:path";
import pino from "pino";
// Imported directly (not via pino.transport) so the bundler includes it:
// pino.transport resolves `target: "pino-roll"` by name at runtime inside a
// worker thread, which fails in `bun build --compile` binaries where
// node_modules doesn't exist. Used as a plain destination stream instead.
import pinoRoll from "pino-roll";
import { config } from "./config.js";
import { makeDirSync } from "./fs.js";

let LOG_FILE: string;
try {
	makeDirSync(config.logDir);
	LOG_FILE = path.join(config.logDir, "kith.log");
} catch (err) {
	const fallback = path.resolve("data", "logs", "kith.log");
	try {
		makeDirSync(path.dirname(fallback));
	} catch (innerErr) {
		const code =
			(innerErr as NodeJS.ErrnoException).code ??
			(err as NodeJS.ErrnoException).code;
		throw new Error(
			`Cannot create a log directory — tried "${config.logDir}" and fallback "./data/logs". ` +
				`Last error: ${code}. Fix permissions on one of them, or set KITH_LOG_DIR to a writable path.`,
			{ cause: innerErr },
		);
	}
	process.stderr.write(
		`[logger] cannot write to ${config.logDir}, falling back to ${fallback}\n`,
	);
	LOG_FILE = fallback;
}

const destination = await pinoRoll({
	file: LOG_FILE,
	dateFormat: "yyyy.MM.dd",
	frequency: "daily",
	limit: {
		count: 90,
		removeOtherLogFiles: true,
	},
});

export const logger = pino(
	{
		level: process.env.DEBUG ? "debug" : "info",
		// Call sites log errors under `error`, but pino only applies its
		// error serializer to `err` by default — under any other key an
		// Error serializes as a plain object, silently dropping message,
		// stack and cause (they're non-enumerable).
		serializers: {
			err: pino.stdSerializers.err,
			error: pino.stdSerializers.err,
		},
	},
	destination,
);
