import { z } from "zod";

export type LogStream = "stdout" | "stderr" | "system";

export interface LogLine {
	stream: LogStream;
	text: string;
	timestamp: number;
}

// The compose file runs the container with `tty: true`, so tools like
// mc-image-helper emit ANSI color codes even with `--no-color` (that flag
// only stops compose from coloring its own prefix). Stripping the ESC byte
// alone would leave the rest of the sequence behind as literal text
// ("\x1b[39m" -> "[39m"), so whole escape sequences are removed first:
// CSI ("\x1b[...m" and friends) and OSC ("\x1b]...BEL/ST").
const ANSI_SEQUENCES =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: We need to remove ANSI escape sequences from logs
	/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: We need to remove the control characters from logs
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/g;
const MAX_LINE_LENGTH = 512;

export const safeTextSchema = z.string().transform((raw) => {
	const scrubbed = raw.replace(ANSI_SEQUENCES, "").replace(CONTROL_CHARS, "");
	if (scrubbed.length === 0) {
		return null;
	}
	return scrubbed.length > MAX_LINE_LENGTH
		? `${scrubbed.slice(0, MAX_LINE_LENGTH)}…`
		: scrubbed;
});
