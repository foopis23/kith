import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Box, Text, useInput, useStdout } from "ink";
import BigText from "ink-big-text";
import TextInput from "ink-text-input";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Form } from "../components/Form.js";
import { LogBox } from "../components/LogBox.js";
import { Menu } from "../components/Menu.js";
import { Screen, StatusDot, useErrorQueue } from "../components/Screen.js";
import { useServer } from "../hooks/useServer.js";
import { useServerConfigFields } from "../hooks/useServerConfigFields.js";
import type { Server } from "../models/server.model.js";
import * as BackupService from "../services/backup.service.js";
import * as ServerService from "../services/server.service.js";

export function ServerDetails() {
	const { id } = useParams();
	const serverId = id ?? "";

	const navigate = useNavigate();
	const { server, status, startServer, stopServer } = useServer(serverId);
	const { stdout } = useStdout();
	const pushError = useErrorQueue();
	const queryClient = useQueryClient();
	const [consoleMode, setConsoleMode] = useState(false);
	const [configureMode, setConfigureMode] = useState(false);
	const [deleteMode, setDeleteMode] = useState(false);
	const config = useServerConfigFields(serverId, configureMode);

	const enableBackups = useMutation({
		mutationFn: () => ServerService.setServerBackupsEnabled(serverId, true),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["servers", serverId] }),
	});

	const deleteServer = useMutation({
		mutationFn: (mode: ServerService.DeleteServerMode) =>
			ServerService.deleteServer(serverId, mode),
		onSuccess: () => {
			// The server is gone — drop every cached query about it and
			// refresh the list before landing back on it.
			queryClient.invalidateQueries({ queryKey: ["servers"] });
			navigate("/");
		},
		onError: (err: unknown) =>
			pushError(err instanceof Error ? err.message : "Unknown delete failure"),
	});

	// Backup setup runs docker pulls and a restic init, which can take a
	// while — keep a visible status line so it doesn't look like nothing
	// happened. The success message clears itself after a few seconds.
	const [backupSetupDone, setBackupSetupDone] = useState(false);
	useEffect(() => {
		if (!backupSetupDone) {
			return;
		}
		const timer = setTimeout(() => setBackupSetupDone(false), 5000);
		return () => clearTimeout(timer);
	}, [backupSetupDone]);

	// Escape goes back to the server list, except in console mode where the
	// CommandInput owns Escape (it exits the console instead) and in
	// configure mode where the Form owns Escape (it exits the form instead).
	// While the config is still loading the Form isn't mounted, so this view
	// keeps owning Escape to leave configure mode. In delete mode Escape
	// just cancels the confirmation.
	useInput(
		(_, key) => {
			if (!key.escape) {
				return;
			}
			if (deleteMode) {
				setDeleteMode(false);
				deleteServer.reset();
				return;
			}
			if (configureMode && config.isLoading) {
				setConfigureMode(false);
				return;
			}
			navigate("/");
		},
		{ isActive: !consoleMode && (!configureMode || config.isLoading) },
	);

	const items = [
		actionItem({
			label: "Start",
			pendingLabel: "Starting Server...",
			value: "start",
			isPending: startServer.isPending,
			onSelect: () =>
				startServer
					.mutateAsync()
					.catch((err: unknown) =>
						pushError(
							err instanceof Error ? err.message : "Unknown start failure",
						),
					),
		}),
		actionItem({
			label: "Stop",
			pendingLabel: "Stopping Server...",
			value: "stop",
			isPending: stopServer.isPending,
			onSelect: () =>
				stopServer
					.mutateAsync()
					.catch((err: unknown) =>
						pushError(
							err instanceof Error ? err.message : "Unknown stop failure",
						),
					),
		}),
		{
			label: "Console",
			value: "console",
			onSelect: () => setConsoleMode(true),
		},
		{
			label: "Configure",
			value: "configure",
			onSelect: () => setConfigureMode(true),
		},
		...(BackupService.backupsGloballyEnabled()
			? server?.backups === "enabled"
				? [
						{
							label: "Backups",
							value: "backups",
							onSelect: () => navigate(`/servers/${serverId}/backups`),
						},
					]
				: [
						actionItem({
							label:
								server?.backups === "opted_out"
									? "Enable backups"
									: "Set up backups",
							pendingLabel: "Setting up backups...",
							value: "setup-backups",
							isPending: enableBackups.isPending,
							onSelect: () =>
								enableBackups
									.mutateAsync()
									.then(() => setBackupSetupDone(true))
									.catch((err: unknown) =>
										pushError(
											err instanceof Error
												? err.message
												: "Unknown backup setup failure",
										),
									),
						}),
					]
			: []),
		{
			label: "Delete",
			value: "delete",
			onSelect: () => setDeleteMode(true),
		},
		{
			label: "Back",
			value: "back",
			onSelect: () => navigate("/"),
		},
	];

	const versionText = status?.serverInfo ? status.serverInfo.version.name : "";
	const playersText = status?.serverInfo
		? `${status.serverInfo.players.online}/${status.serverInfo.players.max}`
		: "";
	const statusText = status?.status ?? "offline";
	// Servers created before backups were configured globally get a nudge
	// to set them up; an explicit opt-out stays quiet.
	const showBackupNotice =
		BackupService.backupsGloballyEnabled() && server?.backups === "not_set_up";
	const showBackupSetupStatus = enableBackups.isPending || backupSetupDone;
	const controlRows = consoleMode ? 3 : deleteMode ? 6 : items.length;
	// Header, info lines, log borders, hint footer and breathing room.
	const reserved =
		controlRows +
		10 +
		(showBackupNotice ? 1 : 0) +
		(server?.backupDrift ? 1 : 0) +
		(showBackupSetupStatus ? 1 : 0);
	const maxLines = Math.min(Math.max(1, (stdout?.rows ?? 24) - reserved), 24);

	function handleSelect(item: (typeof items)[number]) {
		item.onSelect?.();
	}

	if (!server) {
		return (
			<Screen breadcrumbs={["Servers", "Server"]}>
				<Text dimColor>Loading server details…</Text>
			</Screen>
		);
	}

	return (
		<Screen
			breadcrumbs={
				deleteMode
					? ["Servers", server.label, "Delete"]
					: ["Servers", server.label]
			}
			banner={
				deleteMode ? <BigText text="Delete?" colors={["red"]} /> : undefined
			}
			context={
				deleteMode ? undefined : (
					<Text>
						<StatusDot status={status?.status ?? null} />{" "}
						<Text dimColor>{statusText}</Text>
					</Text>
				)
			}
			hints={
				configureMode
					? [
							{ key: "type", action: "filter" },
							{ key: "↑↓", action: "navigate" },
							{ key: "enter", action: "edit" },
							{ key: "esc", action: "clear filter / back" },
						]
					: consoleMode
						? [
								{ key: "enter", action: "send command" },
								{ key: "esc", action: "exit console" },
							]
						: deleteMode
							? [
									{ key: "↑↓", action: "navigate" },
									{ key: "enter", action: "confirm" },
									{ key: "esc", action: "cancel" },
								]
							: [
									{ key: "↑↓", action: "navigate" },
									{ key: "enter", action: "run action" },
									{ key: "esc", action: "back" },
								]
			}
		>
			{!deleteMode && (
				<>
					<Text dimColor>
						id: {server.id}
						{server.port !== undefined ? ` · port: ${server.port}` : ""}
						{status?.serverInfo ? ` · players: ${playersText}` : ""}
						{status?.serverInfo ? ` · version: ${versionText}` : ""}
					</Text>
					<Text dimColor>dir: {server.dir}</Text>
					{showBackupNotice && (
						<Text color="yellow">
							Backups are enabled globally, but this server isn't set up for
							them yet.
						</Text>
					)}
					{server.backupDrift && (
						<Text color="yellow">
							{server.backupDrift.globalDisabled
								? "Backups are disabled globally, but this server still has a backup sidecar — see Backups."
								: "This server's backup config no longer matches the global config — see Backups."}
						</Text>
					)}
					{enableBackups.isPending && (
						<Text color="yellow">
							Setting up backups… (first run pulls the backup image, this can
							take a minute)
						</Text>
					)}
					{backupSetupDone && !enableBackups.isPending && (
						<Text color="green">
							✓ Backups set up — repository initialized.
						</Text>
					)}
				</>
			)}
			{!configureMode && !deleteMode && server.id && (
				<LogBox serverId={server.id} maxLines={maxLines} />
			)}

			{configureMode ? (
				<>
					<Text> </Text>
					<Text dimColor>
						Changes apply on the next server start.
						{config.isSaving ? " Saving…" : ""}
					</Text>
					{config.isLoading ? (
						<Text dimColor>Loading config…</Text>
					) : (
						<Form
							fields={config.fields}
							filterable
							filterPlaceholder="type to filter settings"
							onEscape={() => setConfigureMode(false)}
						/>
					)}
					{config.errorMessage && (
						<Text color="red">{config.errorMessage}</Text>
					)}
					{config.imageTagWarning && (
						<Text color="yellow">{config.imageTagWarning}</Text>
					)}
				</>
			) : consoleMode ? (
				<CommandInput
					serverId={server.id}
					onEsc={() => setConsoleMode(false)}
				/>
			) : deleteMode ? (
				<DeleteConfirm
					server={server}
					isPending={deleteServer.isPending}
					onArchive={() => deleteServer.mutate("archive")}
					onDestroy={() => deleteServer.mutate("destroy")}
					onCancel={() => {
						setDeleteMode(false);
						deleteServer.reset();
					}}
				/>
			) : (
				<Menu items={items} onSelect={handleSelect} />
			)}
		</Screen>
	);
}

function CommandInput({
	serverId,
	onEsc,
}: {
	serverId: string;
	onEsc: () => void;
}) {
	const [command, setCommand] = useState("");

	const submitCommand = useMutation({
		mutationFn: (command: string) => {
			setCommand("");
			return ServerService.sendCommand(serverId, command);
		},
	});

	useInput((_, key) => {
		if (key.escape) {
			setCommand("");
			submitCommand.reset();
			onEsc();
		}
	});

	return (
		<>
			<Box borderStyle="round">
				<Text color="green">{"> "}</Text>
				<TextInput
					value={command}
					onChange={setCommand}
					onSubmit={() => submitCommand.mutate(command)}
					placeholder="Press esc to go back"
				/>
			</Box>
			{submitCommand.data && (
				<Text color={!submitCommand.data.success ? "red" : undefined}>
					{submitCommand.data.output}
				</Text>
			)}
			{submitCommand.error && (
				<Text color="red">{submitCommand.error.message}</Text>
			)}
		</>
	);
}

/**
 * The delete confirmation: the warnings plus a menu whose default focus
 * is the safe "No" option, so confirming a destructive choice always
 * takes deliberate extra input. The screen's banner and breadcrumb
 * carry the "what is being deleted" context.
 */
function DeleteConfirm({
	server,
	isPending,
	onArchive,
	onDestroy,
	onCancel,
}: {
	server: Server;
	isPending: boolean;
	onArchive: () => void;
	onDestroy: () => void;
	onCancel: () => void;
}) {
	const items = [
		{ label: "No, keep this server", value: "cancel", onSelect: onCancel },
		{
			label: "Yes, archive the server data (kept on disk)",
			value: "archive",
			onSelect: onArchive,
		},
		{
			label: "Yes, delete ALL server data (cannot be undone)",
			value: "destroy",
			onSelect: onDestroy,
		},
	];

	return (
		<>
			<Text color="red">
				Archiving removes the server from kith but keeps its directory on disk,
				renamed to the hidden .archived.{server.id}.
			</Text>
			<Text color="red">
				Deleting all data permanently erases the server directory — this is not
				recoverable. Backups are kept either way.
			</Text>
			{isPending ? (
				<Text dimColor>Deleting server…</Text>
			) : (
				<Menu
					items={items}
					initialIndex={0}
					onSelect={(item) => item.onSelect()}
				/>
			)}
		</>
	);
}

type MenuItem = {
	label: string;
	value: string;
	onSelect?: () => void;
};

function actionItem({
	label,
	pendingLabel,
	value,
	isPending,
	onSelect,
}: {
	label: string;
	pendingLabel: string;
	value: string;
	isPending: boolean;
	onSelect: () => void;
}): MenuItem {
	if (isPending) {
		return { label: pendingLabel, value };
	}

	return { label, value, onSelect };
}
