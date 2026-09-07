/** biome-ignore-all lint/suspicious/noArrayIndexKey: These are just lines in a log, there isn't a great way to key them */

import { Box, Text } from "ink";
import { useServerLogs } from "../hooks/useServerLogs.js";
import type { LogLine } from "../models/log.model.js";

const VISIBLE_LINES = 12;
export const MAX_BUFFERED = 1000;

export function LogBox({
	serverId,
	maxLines = VISIBLE_LINES,
}: {
	serverId: string;
	maxLines?: number;
}) {
	const lines = useServerLogs(serverId);
	const visible = lines.slice(-maxLines);

	const padded = [
		...visible,
		...Array.from(
			{ length: maxLines - visible.length },
			() => null as LogLine | null,
		),
	];

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			paddingX={1}
			height={maxLines + 2}
			overflow="hidden"
		>
			{padded.map((line, index) =>
				line === null ? (
					<Text key={`pad-${index}`}> </Text>
				) : (
					<Text
						key={`${line.timestamp}-${index}`}
						wrap="truncate"
						color={line.stream === "stderr" ? "red" : undefined}
						dimColor={line.stream === "system"}
					>
						{line.text}
					</Text>
				),
			)}
		</Box>
	);
}
