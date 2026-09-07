import chalk from "chalk";
import { Box, Text } from "ink";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { ServerWithStatus } from "../models/server.model.js";

export type KeyHint = {
	readonly key: string;
	readonly action: string;
};

/**
 * A dim footer line of keybinding hints, e.g. `↑↓ navigate · enter select`.
 */
export function KeyHints({ hints }: { readonly hints: readonly KeyHint[] }) {
	return (
		<Text dimColor>
			{hints.map((hint) => `${hint.key} ${hint.action}`).join("  ·  ")}
		</Text>
	);
}

const statusColors = {
	online: "green",
	starting: "yellow",
	offline: "gray",
	pending: "gray",
} as const;

/**
 * A colored dot reflecting a server's status, for rendering inside Text.
 */
export function StatusDot({
	status,
}: {
	readonly status: ServerWithStatus["status"] | null;
}) {
	if (status === null) {
		return <Text color={statusColors.pending}>●</Text>;
	}
	return <Text color={statusColors[status]}>●</Text>;
}

/**
 * The same status dot as a chalk-colored string, for embedding in plain
 * string labels (e.g. combobox items).
 */
export function statusDotText(
	status: ServerWithStatus["status"] | null,
): string {
	if (status === null) {
		return chalk[statusColors.pending]("●");
	}
	return chalk[statusColors[status]]("●");
}

/** How long each queued error is shown before rotating to the next. */
const ERROR_DISPLAY_MS = 5000;

type QueuedError = {
	readonly id: number;
	readonly message: string;
};

type ErrorQueue = {
	readonly current: QueuedError | null;
	readonly pushError: (message: string) => void;
};

const ErrorQueueContext = createContext<ErrorQueue>({
	current: null,
	pushError: () => { },
});

let nextErrorId = 0;

/**
 * Holds the app's transient error queue. Errors pushed via `useErrorQueue`
 * are shown one at a time in the `Screen` error bar, each for `displayMs`
 * before rotating to the next. Wraps the router so errors survive
 * navigation — an error pushed right before a screen change still shows.
 */
export function ErrorQueueProvider({
	children,
	displayMs = ERROR_DISPLAY_MS,
}: {
	readonly children: ReactNode;
	readonly displayMs?: number;
}) {
	const [queue, setQueue] = useState<QueuedError[]>([]);
	const current = queue[0] ?? null;

	// Rotate: show the head of the queue for displayMs, then drop it.
	useEffect(() => {
		if (!current) {
			return;
		}

		const timer = setTimeout(() => {
			setQueue((q) => q.slice(1));
		}, displayMs);

		return () => clearTimeout(timer);
	}, [current, displayMs]);

	const pushError = useCallback((message: string) => {
		setQueue((q) => {
			// A repeating failure (e.g. a retrying query) shouldn't flood the bar.
			if (q.some((queued) => queued.message === message)) {
				return q;
			}

			nextErrorId += 1;
			return [...q, { id: nextErrorId, message }];
		});
	}, []);

	const value = useMemo(() => ({ current, pushError }), [current, pushError]);

	return (
		<ErrorQueueContext.Provider value={value}>
			{children}
		</ErrorQueueContext.Provider>
	);
}

/**
 * Push a transient error into the shared error bar, e.g. a failed action.
 * Persistent screen-state errors (a failed initial load) should still
 * render inline, since they describe the screen rather than an event.
 */
export function useErrorQueue(): (message: string) => void {
	return useContext(ErrorQueueContext).pushError;
}

export type ScreenProps = {
	/**
	 * Optional banner rendered under the breadcrumb header, e.g. the BigText
	 * wordmark on the root screen.
	 */
	readonly banner?: ReactNode;

	/**
	 * The breadcrumb path of the current page, e.g. `["Servers", "Survival
	 * World"]` renders as `Kith › Servers › Survival World`. Ancestors are
	 * dimmed; the last segment is bold. A single segment keeps the flat
	 * `Kith › Servers` look.
	 */
	readonly breadcrumbs: readonly string[];

	/**
	 * Optional right-aligned header content, e.g. a status summary.
	 */
	readonly context?: ReactNode;

	/**
	 * Optional keybinding hints rendered in a dim footer line.
	 */
	readonly hints?: readonly KeyHint[];

	readonly children: ReactNode;
};

/**
 * The shared page chrome: a breadcrumb header with optional right-aligned
 * context, consistent horizontal padding, an error bar, and an optional
 * key-hint footer. Every view renders inside this so screens feel like one
 * tool. The error bar always occupies the line above the footer — blank
 * when idle — so a queued error never shifts the layout when it appears.
 */
export function Screen({
	banner,
	breadcrumbs,
	context,
	hints,
	children,
}: ScreenProps) {
	const current = breadcrumbs[breadcrumbs.length - 1];
	const ancestors = breadcrumbs.slice(0, -1);
	const { current: currentError } = useContext(ErrorQueueContext);

	return (
		<Box flexDirection="column" paddingX={1}>
			<Box justifyContent="space-between">
				<Text>
					<Text bold color="green">
						Kith
					</Text>
					{ancestors.map((ancestor) => (
						<Text key={ancestor} dimColor>
							{" › "}
							{ancestor}
						</Text>
					))}
					<Text dimColor>{" › "}</Text>
					<Text bold>{current}</Text>
				</Text>
				{context}
			</Box>
			{banner}
			<Text> </Text>
			{children}
			<Text color="red">
				{currentError ? `✖ ${currentError.message}` : " "}
			</Text>
			{hints && hints.length > 0 ? <KeyHints hints={hints} /> : null}
		</Box>
	);
}
