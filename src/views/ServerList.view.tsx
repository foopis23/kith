import { useQueries, useQuery } from "@tanstack/react-query";
import { Box, Text, useStdout } from "ink";
import BigText from "ink-big-text";
import Spinner from "ink-spinner";
import { useNavigate } from "react-router";
import stringWidth from "string-width";
import { Combobox } from "../components/Combobox.js";
import { Screen, StatusDot } from "../components/Screen.js";
import {
	MAX_SERVER_LABEL_LENGTH,
	type Server,
	type ServerStatus,
	type ServerWithStatus,
} from "../models/server.model.js";
import * as ServerService from "../services/server.service.js";

export function ServerList() {
	const navigate = useNavigate();
	const { stdout } = useStdout();

	const serverQuery = useQuery({
		queryKey: ["servers"],
		queryFn: ServerService.getServers,
	});

	const statusQueries = useQueries({
		queries:
			serverQuery.data?.map((server) => ({
				queryKey: ["servers", server.id, "status"],
				queryFn: () => ServerService.getServerStatus(server.id),
				refetchInterval: 15000, // Poll every 15 seconds
			})) ?? [],
	});

	// Merge server data with their corresponding statuses.
	const servers: (ServerWithStatus | Server)[] = (
		serverQuery.data?.map((server, index) => {
			const status = statusQueries[index]?.data;
			return status ? ({ ...server, ...status } as ServerWithStatus) : server;
		}) ?? []
	).sort((a, b) => {
		const aLabel = clampLabel(a.label);
		const bLabel = clampLabel(b.label);
		return aLabel.localeCompare(bLabel);
	});

	const onlineCount = servers.filter(
		(server) => "status" in server && server.status === "online",
	).length;

	// Align the status column: every label is padded out to the longest one.
	const labelWidth = servers.reduce(
		(width, server) => Math.max(width, stringWidth(clampLabel(server.label))),
		0,
	);

	type Item = {
		label: string;
		value: string;
		padded: string;
		detail: string | null;
		status: ServerStatus["status"] | null;
	};

	const serverItems: Item[] = servers.map((server) => {
		const label = clampLabel(server.label);
		const padded = label + " ".repeat(labelWidth - stringWidth(label));
		return {
			label,
			value: `/servers/${server.id}`,
			padded,
			detail: detailOf(server),
			status: "status" in server ? server.status : null,
		};
	});

	const items: Item[] = serverItems.concat([
		{
			label: "+ New server",
			value: "/create",
			padded: "+ New server",
			detail: null,
			status: null,
		},
		{
			label: "Exit",
			value: "/exit",
			padded: "Exit",
			detail: null,
			status: null,
		},
	]);

	function renderItem(item: Item, isSelected: boolean) {
		const textColor = isSelected ? "cyan" : undefined;

		if (item.detail === null) {
			// Action rows have no status to show off, so keep them quiet.
			return (
				<Text color={textColor} dimColor={!isSelected}>
					{item.padded}
				</Text>
			);
		}

		return (
			<>
				<StatusDot status={item.status} />{" "}
				<Text color={textColor} dimColor={!isSelected}>
					{item.padded}
				</Text>
				{"    "}
				<Text color={textColor} dimColor={!isSelected}>
					{item.status === null && (
						<>
							<Spinner /> Pending...
						</>
					)}
					{item.status === "starting" && (
						<>
							<Spinner /> Starting...
						</>
					)}
					{item.status !== null && item.status !== "starting" && item.detail}
				</Text>
			</>
		);
	}

	// Fill the terminal without overflowing it: the banner (10 rows), tagline,
	// breadcrumb header, spacing, the filter row and the hint footer reserve
	// about 17 rows.
	const maxVisibleItems = Math.min(Math.max((stdout?.rows ?? 24) - 17, 5), 24);

	return (
		<Screen
			banner={
				<Box flexDirection="column">
					<BigText text="Kith" />
					<Text dimColor>
						A simple TUI for managing your Minecraft servers.
					</Text>
				</Box>
			}
			breadcrumbs={["Servers"]}
			context={
				servers.length > 0 ? (
					<Text dimColor>
						{onlineCount}/{servers.length} online
					</Text>
				) : undefined
			}
			hints={[
				{ key: "↑↓", action: "navigate" },
				{ key: "enter", action: "select" },
				{ key: "type", action: "to filter" },
			]}
		>
			{serverQuery.isError ? (
				<Text color="red">{serverQuery.error.message}</Text>
			) : (
				<>
					{!serverQuery.isPending && servers.length === 0 && (
						<Text dimColor>No servers yet — create one to get started.</Text>
					)}
					<Combobox
						items={items}
						labelKey="label"
						searchKeys={["label"]}
						loading={serverQuery.isPending}
						loadingMessage="Loading servers…"
						renderItem={renderItem}
						onSelect={(item) => {
							navigate(item.value);
						}}
						maxVisibleItems={maxVisibleItems}
					/>
				</>
			)}
		</Screen>
	);
}

function detailOf(server: ServerWithStatus | Server): string {
	if ("status" in server === false) {
		return "...";
	}

	if (server.status === "online" && server.serverInfo) {
		const { online, max } = server.serverInfo.players;
		return `online · ${online}/${max} players`;
	}

	return server.status;
}

/**
 * Truncates a label to the display cap, adding an ellipsis when cut.
 */
function clampLabel(label: string): string {
	if (label.length <= MAX_SERVER_LABEL_LENGTH) {
		return label;
	}

	return `${label.slice(0, MAX_SERVER_LABEL_LENGTH - 1)}…`;
}
