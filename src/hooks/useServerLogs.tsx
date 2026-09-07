import { useEffect, useState } from "react";
import { MAX_BUFFERED } from "../components/LogBox.js";
import type { LogLine } from "../models/log.model.js";
import * as ServerService from "../services/server.service.js";

export function useServerLogs(serverId: string): LogLine[] {
	const [lines, setLines] = useState<LogLine[]>([]);

	useEffect(() => {
		const stop = ServerService.startLogTail(
			serverId,
			(line) =>
				setLines((prev) =>
					prev.length >= MAX_BUFFERED
						? [...prev.slice(1), line]
						: [...prev, line],
				),
			() => setLines([]),
		);
		return stop;
	}, [serverId]);

	return lines;
}
