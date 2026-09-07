import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Text, useInput } from "ink";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Menu } from "../components/Menu.js";
import { Screen, StatusDot, useErrorQueue } from "../components/Screen.js";
import { useServer } from "../hooks/useServer.js";
import type { BackupSnapshot } from "../models/backup.model.js";
import * as BackupService from "../services/backup.service.js";
import * as ServerService from "../services/server.service.js";

/** How many recent snapshots the backups screen lists. */
const MAX_LISTED_SNAPSHOTS = 10;

export function ServerBackups() {
	const { id } = useParams();
	const serverId = id ?? "";

	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const pushError = useErrorQueue();
	const { server, status } = useServer(serverId);

	const snapshotsQuery = useQuery({
		queryKey: ["servers", serverId, "backups", "snapshots"],
		queryFn: () => BackupService.listSnapshots(serverId),
		enabled: server?.backups === "enabled",
		refetchInterval: 30000,
	});

	const invalidateSnapshots = () =>
		queryClient.invalidateQueries({
			queryKey: ["servers", serverId, "backups", "snapshots"],
		});

	const backupNow = useMutation({
		mutationFn: () => BackupService.backupNow(serverId),
		onSuccess: invalidateSnapshots,
	});

	const disableBackups = useMutation({
		mutationFn: () => ServerService.setServerBackupsEnabled(serverId, false),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["servers", serverId] });
			navigate(`/servers/${serverId}`);
		},
	});

	const [confirmingUpdate, setConfirmingUpdate] = useState(false);
	const [updateDone, setUpdateDone] = useState(false);

	const [restoreMode, setRestoreMode] = useState<"pick" | "confirm" | null>(
		null,
	);
	const [restoreTarget, setRestoreTarget] = useState<BackupSnapshot | null>(
		null,
	);
	const [restoreDone, setRestoreDone] = useState(false);

	const restore = useMutation({
		mutationFn: (snapshotId: string) =>
			BackupService.restoreSnapshot(serverId, snapshotId),
		onSuccess: () => {
			setRestoreMode(null);
			setRestoreTarget(null);
			setRestoreDone(true);
			setTimeout(() => setRestoreDone(false), 5000);
		},
	});

	const updateToGlobal = useMutation({
		mutationFn: () => ServerService.updateServerBackupsToGlobal(serverId),
		onSuccess: () => {
			setConfirmingUpdate(false);
			setUpdateDone(true);
			queryClient.invalidateQueries({ queryKey: ["servers", serverId] });
			invalidateSnapshots();
			setTimeout(() => setUpdateDone(false), 5000);
		},
	});

	useInput((_, key) => {
		if (!key.escape) {
			return;
		}
		if (confirmingUpdate) {
			setConfirmingUpdate(false);
		} else if (restoreMode === "confirm") {
			setRestoreMode("pick");
		} else if (restoreMode === "pick") {
			setRestoreMode(null);
		} else {
			navigate(`/servers/${serverId}`);
		}
	});

	// restic lists snapshots oldest first; show the newest on top.
	const snapshots = [...(snapshotsQuery.data ?? [])].reverse();
	const listed = snapshots.slice(0, MAX_LISTED_SNAPSHOTS);

	const drift = server?.backupDrift ?? null;

	const runUpdateToGlobal = () =>
		updateToGlobal
			.mutateAsync()
			.catch((err: unknown) =>
				pushError(
					err instanceof Error ? err.message : "Unknown update failure",
				),
			);

	const serverRunning =
		status?.status === "online" || status?.status === "starting";

	const startRestorePick = () => {
		if (serverRunning) {
			pushError("Stop the server before restoring a backup.");
			return;
		}
		setRestoreMode("pick");
	};

	const runRestore = () => {
		if (!restoreTarget) {
			return;
		}
		restore
			.mutateAsync(restoreTarget.id)
			.catch((err: unknown) =>
				pushError(
					err instanceof Error ? err.message : "Unknown restore failure",
				),
			);
	};

	const items: MenuItem[] = confirmingUpdate
		? [
			actionItem({
				label: "Yes, update to the global config",
				pendingLabel: "Updating backup config…",
				value: "confirm-update",
				isPending: updateToGlobal.isPending,
				onSelect: runUpdateToGlobal,
			}),
			{
				label: "Cancel",
				value: "cancel-update",
				onSelect: () => setConfirmingUpdate(false),
			},
		]
		: restoreMode === "pick"
			? [
				...listed.map((snapshot) => ({
					label: snapshotLabel(snapshot),
					value: `restore-${snapshot.id}`,
					onSelect: () => {
						setRestoreTarget(snapshot);
						setRestoreMode("confirm");
					},
				})),
				{
					label: "Cancel",
					value: "cancel-restore-pick",
					onSelect: () => setRestoreMode(null),
				},
			]
			: restoreMode === "confirm"
				? [
					actionItem({
						label: "Yes, restore this snapshot",
						pendingLabel: "Restoring… (can take a while for large worlds)",
						value: "confirm-restore",
						isPending: restore.isPending,
						onSelect: runRestore,
					}),
					{
						label: "Cancel",
						value: "cancel-restore-confirm",
						onSelect: () => setRestoreMode("pick"),
					},
				]
				: [
					...(drift && !drift.globalDisabled
						? [
							{
								label: "Update to global config",
								value: "update-to-global",
								onSelect: () => setConfirmingUpdate(true),
							},
						]
						: []),
					actionItem({
						label: "Backup now",
						pendingLabel: "Running backup...",
						value: "backup-now",
						isPending: backupNow.isPending,
						onSelect: () =>
							backupNow
								.mutateAsync()
								.catch((err: unknown) =>
									pushError(
										err instanceof Error
											? err.message
											: "Unknown backup failure",
									),
								),
					}),
					...(snapshotsQuery.isSuccess && snapshots.length > 0
						? [
							{
								label: "Restore a snapshot",
								value: "restore",
								onSelect: startRestorePick,
							},
						]
						: []),
					actionItem({
						label: "Disable backups",
						pendingLabel: "Disabling backups...",
						value: "disable",
						isPending: disableBackups.isPending,
						onSelect: () =>
							disableBackups
								.mutateAsync()
								.catch((err: unknown) =>
									pushError(
										err instanceof Error
											? err.message
											: "Unknown disable failure",
									),
								),
					}),
					{
						label: "Back",
						value: "back",
						onSelect: () => navigate(`/servers/${serverId}`),
					},
				];

	if (!server) {
		return (
			<Screen breadcrumbs={["Servers", "Server", "Backups"]}>
				<Text dimColor>Loading server details…</Text>
			</Screen>
		);
	}

	if (server.backups !== "enabled") {
		return (
			<Screen
				breadcrumbs={["Servers", server.label, "Backups"]}
				hints={[{ key: "esc", action: "back" }]}
			>
				<Text dimColor>Backups are not enabled for this server.</Text>
			</Screen>
		);
	}

	return (
		<Screen
			breadcrumbs={["Servers", server.label, "Backups"]}
			context={
				<Text>
					<StatusDot status={status?.status ?? null} />{" "}
					<Text dimColor>{status?.status ?? "offline"}</Text>
				</Text>
			}
			hints={[
				{ key: "↑↓", action: "navigate" },
				{ key: "enter", action: "run action" },
				{ key: "esc", action: "back" },
			]}
		>
			{drift?.globalDisabled && (
				<>
					<Text color="yellow">
						Backups have been disabled globally, but this server still has a
						backup sidecar — it's running on its last config.
					</Text>
					<Text dimColor>
						Do nothing to keep backing up with those settings (this server is
						now self-managed), or disable backups below.
					</Text>
					<Text> </Text>
				</>
			)}
			{drift && !drift.globalDisabled && (
				<>
					<Text color="yellow">
						This server's backup config no longer matches the global config:{" "}
						{drift.fields.join(", ")}.
					</Text>
					{drift.actualRepository && (
						<Text color="yellow">
							Backups are currently going to: {drift.actualRepository}
						</Text>
					)}
					<Text> </Text>
				</>
			)}
			{confirmingUpdate && drift && (
				<>
					<Text>
						Update this server's backup config to the current global config?
					</Text>
					<Text dimColor>
						Existing snapshots are preserved:{" "}
						{drift.passwordChanged && !drift.actualRepository
							? "the repository is re-keyed with the global password."
							: drift.actualRepository
								? "their history is copied to the new location (this can take a while for large backups). The old repository is left in place."
								: "only the sidecar's settings change."}
					</Text>
					<Text> </Text>
				</>
			)}
			{updateDone && (
				<Text color="green">✓ Backup config updated to the global config.</Text>
			)}
			{restoreDone && (
				<Text color="green">
					✓ Snapshot restored. You can start the server again.
				</Text>
			)}
			{restoreMode === "confirm" && restoreTarget && (
				<>
					<Text>Restore snapshot {snapshotLabel(restoreTarget)}?</Text>
					<Text dimColor>
						The server directory is wiped and replaced with the snapshot's
						contents — anything changed or added since is lost.
					</Text>
					<Text> </Text>
				</>
			)}
			{restoreMode === "pick" && (
				<>
					<Text>Pick a snapshot to restore:</Text>
					<Text> </Text>
				</>
			)}
			<Text dimColor>
				repo:{" "}
				{BackupService.repositoryDisplay(serverId) ??
					drift?.actualRepository ??
					"unknown"}
			</Text>
			<Text dimColor>schedule: {BackupService.scheduleDisplay()}</Text>
			<Text> </Text>
			{snapshotsQuery.isPending ? (
				<Text dimColor>Loading snapshots…</Text>
			) : snapshotsQuery.isError ? (
				<Text color="red">
					Couldn't list snapshots: {snapshotsQuery.error.message}
				</Text>
			) : snapshots.length === 0 ? (
				<Text dimColor>No snapshots yet.</Text>
			) : restoreMode === null ? (
				<>
					{listed.map((snapshot) => (
						<SnapshotRow key={snapshot.id} snapshot={snapshot} />
					))}
					{snapshots.length > listed.length && (
						<Text dimColor>…and {snapshots.length - listed.length} more</Text>
					)}
				</>
			) : null}
			<Text> </Text>
			<Menu items={items} onSelect={(item) => item.onSelect?.()} />
		</Screen>
	);
}

function snapshotLabel(snapshot: BackupSnapshot): string {
	const time = new Date(snapshot.time);
	const formatted = Number.isNaN(time.getTime())
		? snapshot.time
		: time.toLocaleString();
	return `${formatted}  ${snapshot.short_id ?? snapshot.id.slice(0, 8)}`;
}

function SnapshotRow({ snapshot }: { snapshot: BackupSnapshot }) {
	return <Text dimColor>{snapshotLabel(snapshot)}</Text>;
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
