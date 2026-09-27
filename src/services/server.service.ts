import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import YAML from "yaml";
import type z from "zod";
import { config, isRemoteBackupDest, serverPath } from "../lib/config.js";
import {
	ARCHIVED_SERVER_PREFIX,
	DATA_DIR_NAME,
	MC_SERVICE_NAME,
	PATCH_FILE_CONTAINER_PATH,
	PATCH_FILE_NAME,
} from "../lib/const.js";
import { exists, makeDir, writeFile } from "../lib/fs.js";
import { logger as globalLogger } from "../lib/logger.js";
import { isPortFree } from "../lib/tcp.js";
import { FailedToUpdateBackupsError } from "../models/backup.model.js";
import type { LogLine, LogStream } from "../models/log.model.js";
import { safeTextSchema } from "../models/log.model.js";
import type {
	CreateModrinthServerArgs,
	CreateVanillaServerArgs,
	KithComposeConfig,
	ServerStatus,
} from "../models/server.model.js";
import {
	BackupRepoInsideServerDirError,
	CantAccessServerComposeFile,
	CantAccessServersDirectoryError,
	CapturingLogTrailFailedError,
	type CommandResult,
	FailedToCreateServerError,
	FailedToDeleteServerError,
	FailedToFetchServerConfigError,
	FailedToFetchServerInfoError,
	FailedToSendCommandError,
	FailedToStartServerError,
	FailedToStopServerError,
	FailedToUpdateServerConfigError,
	InvalidServerConfigPatchError,
	ManagedServer,
	MissingCommandResultError,
	mcMonitorResponseSchema,
	type Server,
	type ServerConfig,
	type ServerConfigPatch,
	ServerDirectoryDoesNotContainComposeFileError,
	type ServerInfo,
	ServerStackNotDownError,
	ServersDirectoryDoesNotExistError,
	serverConfigPatchSchema,
	UnexpectedKithComposeConfigError,
	UnexpectedServerResponseError,
} from "../models/server.model.js";
import * as BackupService from "./backup.service.js";
import * as ComposeService from "./compose.service.js";
import { stripComposePrefix } from "./compose.service.js";
import {
	getJavaVersionForMinecraftVersion,
	getJavaVersionForModpackVersion,
} from "./java.service.js";
import { parseModrinthModpack } from "./modrinth.service.js";

const logger = globalLogger.child({ service: "server.service.ts" });

//#region Public API

/**
 * Retrieves a list of all Minecraft servers manged by kith.
 */
export async function getServers(): Promise<Server[]> {
	const files = await fs
		.readdir(config.serversDir, { withFileTypes: true })
		.catch((rawErr: unknown) => {
			const err = rawErr as NodeJS.ErrnoException;
			if (err.code === "ENOENT") {
				throw new ServersDirectoryDoesNotExistError(config.serversDir);
			}
			if (err.code === "EACCES") {
				throw new CantAccessServersDirectoryError(config.serversDir);
			}
			throw rawErr;
		});

	const dirs = files
		.filter((file) => file.isDirectory())
		.map((d) => d.name)
		.filter((name) => !name.startsWith("."))
		// Redundant with the dot-filter above (the prefix starts with
		// ".") — kept as defense-in-depth so archived servers stay off
		// the roster even if the hidden-file rule ever changes.
		.filter((name) => !name.startsWith(ARCHIVED_SERVER_PREFIX))
		.filter((name) => /^[\w.-]+$/.test(name));

	return (
		await Promise.all(dirs.map(async (id) => getServer(id, true)))
	).filter((server): server is Server => server !== null);
}

export function getServer(
	serverId: string,
	ignoreInvalidDir: true,
): Promise<Server | null>;

export function getServer(
	serverId: string,
	ignoreInvalidDir?: false,
): Promise<Server>;

/**
 * Retrieves detailed information about a specific Minecraft server managed by kith.
 *
 * @param serverId The ID of the server to retrieve.
 * @param ignoreInvalidDir Whether to ignore directories that do not contain a docker-compose.yml file.
 */
export async function getServer(
	serverId: string,
	ignoreInvalidDir = false,
): Promise<Server | null> {
	const dir = serverPath(serverId);
	const composeFilePath = path.resolve(dir, "docker-compose.yml");
	let composeFileExists = false;

	try {
		composeFileExists = await exists(composeFilePath);
	} catch (rawErr) {
		const err = rawErr as NodeJS.ErrnoException;

		if (err.code === "EACCES") {
			const newErr = new CantAccessServerComposeFile(composeFilePath);
			logger.error(newErr);
			throw newErr;
		}

		throw rawErr;
	}

	if (!composeFileExists) {
		if (ignoreInvalidDir) {
			logger.warn(
				"Ignoring directory as it does not have a docker-compose.yml file",
			);
			return null;
		} else {
			throw new ServerDirectoryDoesNotContainComposeFileError(dir);
		}
	}

	let server: ManagedServer;
	try {
		server = await loadServer(serverId);
	} catch (err) {
		const newErr = new FailedToFetchServerInfoError(serverId, {
			cause: err,
		});
		logger.error({ error: newErr }, newErr.message);
		throw newErr;
	}

	return {
		id: serverId,
		label: server.label,
		port: server.port,
		dir,
		backups: server.backupsState,
		backupDrift: BackupService.detectDrift(server.backupSidecar, serverId),
	};
}

/**
 * Checks the current status of a specific Minecraft server.
 *
 * @param serverId The ID of the server to check.
 */
export async function getServerStatus(serverId: string): Promise<ServerStatus> {
	const hasContainer = await isContainerCreated(serverId);
	const info = hasContainer
		? await pingMCServer(serverId).catch((err) => {
				logger.warn(
					{ error: err },
					`Failed to ping server "${serverId}" while retrieving server info`,
				);
				return null;
			})
		: null;

	return {
		status: determineStatus(hasContainer, info),
		serverInfo: info,
	};
}

/**
 * Creates a new vanilla Minecraft server managed by kith.
 */
export async function createVanillaServer(
	args: CreateVanillaServerArgs,
): Promise<Server> {
	let { server_port, label } = args;

	const { version, type, memory } = args;
	let id: string | undefined;
	try {
		label = uniquifyLabel(
			label,
			(await getServers()).map((server) => server.label),
		);
		id = await generateServerId();
		const dir = serverPath(id);

		await makeDir(dir);

		if (!server_port) {
			server_port = await getAvailablePort();
		}

		const javaTag = await getJavaVersionForMinecraftVersion(version);

		const server = ManagedServer.create({
			id,
			label: label || id,
			image: `itzg/minecraft-server:${javaTag}`,
			port: server_port,
			environment: {
				TYPE: `${type}`,
				VERSION: `${version}`,
				MEMORY: memory,
			},
			uid: config.uid,
			gid: config.gid,
		});

		const backupService = BackupService.backupsGloballyEnabled()
			? BackupService.buildBackupServiceConfig(id)
			: undefined;
		if (backupService) {
			server.setBackups(backupService);
		}

		await saveComposeConfig(id, server.toCompose());
		await makeDir(path.resolve(dir, DATA_DIR_NAME));
		await ensurePatchFile(dir);
		if (backupService) {
			// Eagerly init the restic repo so a broken global backup config
			// surfaces at creation. Non-fatal: the sidecar retries on start.
			try {
				await BackupService.initRepository(id);
			} catch {
				logger.warn(
					{ serverId: id },
					"Failed to initialize the backup repository for a new server",
				);
			}
		}

		return await getServer(id);
	} catch (err) {
		const newErr = new FailedToCreateServerError(id, {
			cause: err,
		});
		logger.error({ error: newErr }, newErr.message);
		throw newErr;
	}
}

/**
 * Creates a new modrinth modpack Minecraft server managed by kith.
 */
export async function createModrinthServer(
	args: CreateModrinthServerArgs,
): Promise<Server> {
	let { server_port, label } = args;
	const { type, modrinth_modpack, modrinth_modpack_version, memory } = args;

	let id: string | undefined;
	try {
		label = uniquifyLabel(
			label,
			(await getServers()).map((server) => server.label),
		);
		id = await generateServerId();
		const dir = serverPath(id);

		await makeDir(dir);

		if (!server_port) {
			server_port = await getAvailablePort();
		}

		const { identifier } = parseModrinthModpack(modrinth_modpack);
		const javaTag = await getJavaVersionForModpackVersion(
			modrinth_modpack,
			modrinth_modpack_version,
		);

		const server = ManagedServer.create({
			id,
			label: label || id,
			image: `itzg/minecraft-server:${javaTag}`,
			port: server_port,
			environment: {
				TYPE: `${type}`,
				MODRINTH_MODPACK: identifier,
				MODRINTH_MODPACK_VERSION:
					modrinth_modpack_version === "latest"
						? undefined
						: modrinth_modpack_version,
				VERSION: modrinth_modpack_version === "latest" ? "latest" : undefined,
				MEMORY: memory,
			},
			uid: config.uid,
			gid: config.gid,
		});

		const backupService = BackupService.backupsGloballyEnabled()
			? BackupService.buildBackupServiceConfig(id)
			: undefined;
		if (backupService) {
			server.setBackups(backupService);
		}

		await saveComposeConfig(id, server.toCompose());
		await makeDir(path.resolve(dir, DATA_DIR_NAME));
		await ensurePatchFile(dir);

		if (backupService) {
			// Eagerly init the restic repo so a broken global backup config
			// surfaces at creation. Non-fatal: the sidecar retries on start.
			try {
				await BackupService.initRepository(id);
			} catch {
				logger.warn(
					{ serverId: id },
					"Failed to initialize the backup repository for a new server",
				);
			}
		}

		return await getServer(id);
	} catch (err) {
		const newErr = new FailedToCreateServerError(id, {
			cause: err,
		});
		logger.error({ error: newErr }, newErr.message);
		throw newErr;
	}
}

/**
 * Reads the editable configuration of a specific Minecraft server from its
 * compose file.
 *
 * @param serverId The ID of the server whose config to read.
 */
export async function getServerConfig(serverId: string): Promise<ServerConfig> {
	try {
		const server = await loadServer(serverId);
		return server.config;
	} catch (err) {
		const newErr = new FailedToFetchServerConfigError(serverId, {
			cause: err,
		});
		logger.error({ error: newErr }, newErr.message);
		throw newErr;
	}
}

/**
 * Applies a config patch to a specific Minecraft server, rewriting its
 * compose file. Only the settings present in the patch are touched;
 * everything else in the file is preserved.
 *
 * Changes take effect the next time the server is (re)started.
 *
 * @param serverId The ID of the server to update.
 * @param patch The settings to change. `undefined` clears a setting —
 * except for `port`, which auto-assigns an available port instead.
 */
export async function updateServerConfig(
	serverId: string,
	patch: ServerConfigPatch,
): Promise<ServerConfig> {
	const validated = serverConfigPatchSchema.safeParse(patch);
	if (!validated.success) {
		const err = new InvalidServerConfigPatchError(serverId, validated.error);
		logger.error({ error: err }, err.message);
		throw err;
	}

	// Serialized per server: an update is a read-modify-write of the
	// compose file, and the config screen fires one mutation per edit,
	// so overlapping updates would silently drop each other's changes.
	return enqueueServerOp(serverId, () =>
		applyServerConfigUpdate(serverId, validated.data),
	);
}

/**
 * Per-server tails of the lifecycle queue, see {@link enqueueServerOp}.
 */
const serverOpQueues = new Map<string, Promise<unknown>>();

/**
 * Runs an operation after every previously queued operation for the
 * same server has settled. Operations for different servers still run
 * in parallel. The queue entry is removed once it drains, so the map
 * can't grow without bound.
 *
 * Everything that mutates a server's compose file, directory, or
 * container stack goes through this queue. Config updates are
 * read-modify-writes that would silently drop each other's changes,
 * and a delete must never interleave with a start: its down/ps could
 * observe the stack before the start's containers exist and remove
 * the directory out from under the starting containers.
 */
function enqueueServerOp<T>(
	serverId: string,
	op: () => Promise<T>,
): Promise<T> {
	const previous = serverOpQueues.get(serverId) ?? Promise.resolve();
	const run = previous.catch(() => {}).then(op);
	serverOpQueues.set(serverId, run);
	const cleanup = () => {
		if (serverOpQueues.get(serverId) === run) {
			serverOpQueues.delete(serverId);
		}
	};
	run.then(cleanup, cleanup);
	return run;
}

/**
 * Applies a validated config patch, see {@link updateServerConfig}.
 * Must only be called through the per-server lifecycle queue.
 */
async function applyServerConfigUpdate(
	serverId: string,
	patch: ServerConfigPatch,
): Promise<ServerConfig> {
	logger.info({ serverId, ...patch }, "Applying server config update");
	try {
		const server = await loadServer(serverId);

		let resolved = patch;
		if ("port" in patch && patch.port === undefined) {
			// Unsetting the port assigns the next available one; the
			// server's current game port is free to be picked again.
			resolved = { ...patch, port: await getAvailablePort(serverId) };
		}

		// A version change can move the Java requirement (ie. 1.20 -> 1.21
		// needs java17 -> java21), so the image tag is re-resolved just like
		// at creation — unless the patch pins an explicit tag.
		if (!("imageTag" in resolved)) {
			const tag = await resolveImageTagForPatch(server, resolved);
			if (tag) {
				resolved = { ...resolved, imageTag: tag };
			}
		}

		server.applyConfigPatch(resolved);

		await saveComposeConfig(serverId, server.toCompose());

		return server.config;
	} catch (err) {
		const newErr = new FailedToUpdateServerConfigError(serverId, {
			cause: err,
		});
		logger.error({ error: newErr }, newErr.message);
		throw newErr;
	}
}

/**
 * Enables or disables backups for a server by adding or removing the
 * mc-backup sidecar from its compose file. Disabling keeps the restic
 * repository itself — only the sidecar goes away, so re-enabling picks
 * up where backups left off. The choice is recorded in a label so an
 * opted-out server isn't nagged to set backups up.
 *
 * Enabling also initializes the restic repository immediately (via a
 * throwaway container, so the server doesn't need to be running) —
 * otherwise a bad password or unreachable backend would only surface
 * in the sidecar's logs on its first run.
 *
 * The sidecar itself joins the stack the next time the server is
 * (re)started.
 *
 * @throws FailedToInitBackupRepoError when enabling succeeded but the
 * repository couldn't be initialized.
 */
export async function setServerBackupsEnabled(
	serverId: string,
	enabled: boolean,
): Promise<void> {
	// Same queue as config updates: both rewrite the compose file.
	return enqueueServerOp(serverId, () => applyBackupsUpdate(serverId, enabled));
}

/**
 * Applies a backups enable/disable, see {@link setServerBackupsEnabled}.
 * Must only be called through the per-server lifecycle queue.
 */
async function applyBackupsUpdate(
	serverId: string,
	enabled: boolean,
): Promise<void> {
	try {
		const server = await loadServer(serverId);
		server.setBackups(
			enabled ? BackupService.buildBackupServiceConfig(serverId) : undefined,
		);
		await saveComposeConfig(serverId, server.toCompose());
	} catch (err) {
		const newErr = new FailedToUpdateBackupsError(serverId, { cause: err });
		logger.error({ error: newErr }, newErr.message);
		throw newErr;
	}

	if (enabled) {
		// Initialize the restic repo right away (the sidecar would only do
		// it on its first run) so a bad password or unreachable backend
		// surfaces now. Outside the try/catch above: the compose update
		// succeeded, so a failure here must not read as one.
		await BackupService.initRepository(serverId);
	}
}

/**
 * Re-points a server's backup sidecar at the current global backup
 * config after the global config has changed (see {@link BackupDrift}).
 *
 * The existing snapshots are preserved across the switch — the repo is
 * re-keyed or its history copied, see
 * {@link BackupService.migrateToGlobalConfig} — and the migration runs
 * *before* the compose file is touched, so a failure leaves the server
 * on its old config with its backups untouched.
 *
 * @throws FailedToMigrateBackupRepoError when the repository couldn't
 * be reconciled (the compose file is left unchanged).
 * @throws FailedToUpdateBackupsError when the compose update itself
 * fails.
 */
export async function updateServerBackupsToGlobal(
	serverId: string,
): Promise<void> {
	// Same queue as config updates: both rewrite the compose file.
	return enqueueServerOp(serverId, async () => {
		const server = await loadServer(serverId);
		const oldSidecar = server.backupSidecar;
		if (!oldSidecar) {
			// No sidecar means there's nothing to reconcile — enabling
			// backups is the right action for that server instead.
			throw new FailedToUpdateBackupsError(serverId);
		}

		await BackupService.migrateToGlobalConfig(serverId, oldSidecar);

		try {
			server.replaceBackupSidecar(
				BackupService.buildBackupServiceConfig(serverId),
			);
			await saveComposeConfig(serverId, server.toCompose());
		} catch (err) {
			const newErr = new FailedToUpdateBackupsError(serverId, { cause: err });
			logger.error({ error: newErr }, newErr.message);
			throw newErr;
		}

		// Make sure the (possibly freshly-copied) repo exists and is
		// readable under the new config.
		await BackupService.initRepository(serverId);
	});
}

/**
 * How a server's directory is treated when the server is deleted:
 * "archive" renames it to `.archived.<id>` (data kept on disk, server
 * removed from kith); "destroy" erases it entirely. Restic backup
 * repositories are never touched — a destroy whose local backup
 * destination nests the repository inside the server directory is
 * refused outright (see {@link BackupRepoInsideServerDirError}).
 */
export type DeleteServerMode = "archive" | "destroy";

/**
 * Deletes a server from kith. The server is stopped first, then its
 * directory is either archived or erased depending on the mode.
 * Archiving is recoverable by hand (rename the directory back);
 * destroying is not.
 *
 * @param serverId The ID of the server to delete.
 * @param mode Whether to keep the data on disk (archived) or erase it.
 * @throws ServerStackNotDownError when the stack can't be confirmed
 * down — the directory is left untouched in that case.
 * @throws BackupRepoInsideServerDirError when a destroy would erase a
 * backup repository nested inside the server directory — nothing is
 * touched in that case either.
 */
export async function deleteServer(
	serverId: string,
	mode: DeleteServerMode,
): Promise<void> {
	// Same queue as config updates and starts: a delete must never
	// interleave with a compose file write or a stack coming up.
	return enqueueServerOp(serverId, () => applyServerDelete(serverId, mode));
}

/**
 * Brings the stack down and archives or erases the server's directory,
 * see {@link deleteServer}. Must only be called through the per-server
 * lifecycle queue.
 */
async function applyServerDelete(
	serverId: string,
	mode: DeleteServerMode,
): Promise<void> {
	const dir = serverPath(serverId);

	// A local backup destination nested inside the server directory
	// puts the restic repository in the path of the recursive removal,
	// so a destroy would erase the very backups the confirmation
	// promises to keep. Refuse before anything is touched. (Archive
	// only renames the directory — the repository moves with it but
	// stays on disk.)
	const dest = config.baseBackupDest;
	if (mode === "destroy" && dest && !isRemoteBackupDest(dest)) {
		const dirPath = path.resolve(dir);
		const repoPath = path.resolve(dest, serverId);
		if (repoPath === dirPath || repoPath.startsWith(`${dirPath}${path.sep}`)) {
			const newErr = new BackupRepoInsideServerDirError(serverId, repoPath);
			logger.error({ error: newErr }, newErr.message);
			throw newErr;
		}
	}

	// A running stack can't survive its directory being renamed or
	// deleted out from under it, so bring it down first.
	await ComposeService.down({
		cwd: dir,
		commandOptions: ["--remove-orphans"],
	});

	// The compose wrapper swallows docker failures (logged there), so a
	// resolved down is no proof the stack is actually down — confirm it.
	// A failed ps means docker is unreachable or the compose file is
	// broken; a remaining service means down didn't do its job. Either
	// way, deleting now could rip the data dir out from under live
	// containers, so refuse and leave the directory untouched.
	const ps = await ComposeService.ps({ cwd: dir });
	if (!ps || ps.data.services.length > 0) {
		const newErr = new ServerStackNotDownError(serverId);
		logger.error({ error: newErr }, newErr.message);
		throw newErr;
	}

	try {
		if (mode === "archive") {
			await fs.rename(dir, await availableArchivedPath(serverId));
		} else {
			await fs.rm(dir, { recursive: true, force: true });
		}
	} catch (err) {
		const newErr = new FailedToDeleteServerError(serverId, { cause: err });
		logger.error({ error: newErr }, newErr.message);
		throw newErr;
	}
}

/**
 * Finds a free `.archived.<id>` directory name, suffixing `-2`, `-3`…
 * when a previous archive of the same server is still around.
 */
async function availableArchivedPath(serverId: string): Promise<string> {
	for (let n = 1; ; n++) {
		const name =
			n === 1
				? `${ARCHIVED_SERVER_PREFIX}${serverId}`
				: `${ARCHIVED_SERVER_PREFIX}${serverId}-${n}`;
		const candidate = path.join(config.serversDir, name);
		if (!(await exists(candidate))) {
			return candidate;
		}
	}
}

/**
 * Starts a specific Minecraft server.
 *
 * @param serverId The ID of the server to start.
 * @throws An error if the server fails to start.
 */
export async function start(serverId: string): Promise<void> {
	// Same lifecycle queue as config updates and deletes: a delete
	// running mid-start could confirm an empty stack (the start hasn't
	// created its containers yet) and remove the directory out from
	// under it. A start queued behind a delete fails on its own — the
	// compose file is gone by the time it runs.
	return enqueueServerOp(serverId, () => applyServerStart(serverId));
}

/**
 * Recreates a missing patch file and brings the stack up, see
 * {@link start}. Must only be called through the per-server lifecycle
 * queue.
 */
async function applyServerStart(serverId: string): Promise<void> {
	try {
		const dir = serverPath(serverId);
		await ensurePatchFileIfMounted(dir);
		await ComposeService.upAll({
			cwd: dir,
			commandOptions: ["--remove-orphans"],
		});
	} catch (err) {
		const newErr = new FailedToStartServerError(serverId, {
			cause: err,
		});
		logger.error({ error: newErr }, newErr.message);
		throw newErr;
	}
}

/**
 * Forcefully stops a specific Minecraft server.
 *
 * Instead of sending a rcom stop command, this method forcefully shuts down the server using Docker Compose.
 *
 * @param serverId The ID of the server to force-stop.
 */
export async function stop(serverId: string): Promise<void> {
	const dir = serverPath(serverId);
	try {
		await ComposeService.down({
			cwd: dir,
			commandOptions: ["--remove-orphans"],
		});
	} catch (err) {
		const newErr = new FailedToStopServerError(serverId, {
			cause: err,
		});
		logger.error({ error: newErr }, newErr.message);
	}
}

/**
 * Send a command to a specific Minecraft server using RCON.
 *
 * @param serverId The ID of the server to send the command to.
 * @param commandLine The command line to send to the server.
 */
export async function sendCommand(
	serverId: string,
	commandLine: string,
): Promise<CommandResult> {
	const dir = serverPath(serverId);
	commandLine = commandLine.trim();
	if (commandLine.length === 0) {
		throw new Error("Empty command");
	}

	let result: Awaited<ReturnType<typeof ComposeService.exec>>;
	try {
		result = await ComposeService.exec(
			MC_SERVICE_NAME,
			`rcon-cli ${commandLine}`,
			{
				cwd: dir,
			},
		);
	} catch (err) {
		const newErr = new FailedToSendCommandError(serverId, {
			cause: err,
		});
		logger.error({ error: newErr }, newErr.message);
		throw newErr;
	}

	if (!result) {
		const err = new MissingCommandResultError(serverId);
		logger.error({ error: err }, err.message);
		throw err;
	}

	let success = true;
	const output = result.out.trim();

	if (output.includes("Unknown or incomplete command")) {
		success = false;
	}

	return {
		success,
		output,
	};
}

/**
 * Starts tailing the logs of a specific Minecraft server.
 *
 * @param serverId The ID of the server to tail the logs for.
 * @param onLine Callback function invoked for each new log line.
 * @param onClear Callback function invoked when the log is cleared.
 *
 * @returns A function that can be called to stop tailing the logs.
 */
export function startLogTail(
	serverId: string,
	onLine: (line: LogLine) => void,
	onClear: () => void,
): () => void {
	const dir = serverPath(serverId);
	let stopped = false;
	let proc: ReturnType<typeof spawn> | null = null;

	const capture = async (
		kind: LogStream,
		stream: Readable | null | undefined,
	): Promise<void> => {
		if (!stream) return;
		const decoder = new TextDecoder();
		let pending = "";
		try {
			for await (const chunk of stream) {
				pending += decoder.decode(chunk as Buffer, { stream: true });
				const parts = pending.split(/\r\n|\r|\n/);
				pending = parts.pop() ?? "";
				for (const part of parts) {
					if (part.length === 0) continue;
					const noPrefix = stripComposePrefix(part);
					if (
						/RCON Client \//.test(noPrefix) ||
						/RCON Listener\//.test(noPrefix)
					) {
						continue;
					}
					const text = safeTextSchema.parse(noPrefix);
					if (text !== null) {
						onLine({ stream: kind, text, timestamp: Date.now() });
					}
				}
			}
			pending += decoder.decode();
			if (pending.trim().length > 0) {
				const noPrefix = stripComposePrefix(pending);
				if (
					/RCON Client \//.test(noPrefix) ||
					/RCON Listener\//.test(noPrefix)
				) {
					// fallthrough — the match below will also suppress
				} else {
					const text = safeTextSchema.parse(noPrefix);
					if (text !== null) {
						onLine({ stream: kind, text, timestamp: Date.now() });
					}
				}
			}
		} catch (err) {
			logger.error(new CapturingLogTrailFailedError(serverId, { cause: err }));
		}
	};

	void (async () => {
		while (!stopped) {
			if (!(await isContainerCreated(serverId))) {
				onClear();
				await new Promise((resolve) => setTimeout(resolve, 500));
				continue;
			}

			try {
				proc = spawn(
					"docker",
					["compose", "logs", "--follow", "--no-color", "mc"],
					{
						cwd: dir,
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
			} catch (err) {
				logger.error(
					new CapturingLogTrailFailedError(serverId, { cause: err }),
				);
				await new Promise((resolve) => setTimeout(resolve, 500));
				continue;
			}

			const exited = new Promise<number>((resolve) => {
				proc?.once("close", (code) => resolve(code ?? 0));
			});
			await Promise.all([
				exited,
				capture("stdout", proc.stdout),
				capture("stderr", proc.stderr),
			]);
			proc = null;
		}
	})();

	return () => {
		stopped = true;
		proc?.kill();
	};
}

// #endregion Public API

// #region Private Helpers

/**
 * The empty patch set every server is seeded with. A mounted patch file
 * must contain valid patch-set JSON — an empty file makes mc-image-helper
 * exit non-zero, and itzg's startup scripts run under `set -e`, so that
 * would crash the container on start.
 */
const EMPTY_PATCH_SET = `${JSON.stringify({ patches: [] }, null, 2)}\n`;

/**
 * Creates the server's patch-definitions file when it's missing, without
 * touching an existing one. The compose file mounts it unconditionally,
 * and Docker auto-creates a missing bind-mount source as an empty
 * directory — so a deleted file is put back before it can wedge the mount.
 */
async function ensurePatchFile(dir: string): Promise<void> {
	const patchPath = path.resolve(dir, PATCH_FILE_NAME);
	try {
		// wx: create-only — a user's patch content is never clobbered.
		await writeFile(patchPath, EMPTY_PATCH_SET, { flag: "wx" });
	} catch (rawErr) {
		const err = rawErr as NodeJS.ErrnoException;
		if (err.code === "EEXIST") {
			return;
		}
		if (err.code === "EISDIR") {
			// Docker already recreated the deleted mount source as a
			// directory. Replace it when it's empty (the usual case);
			// otherwise leave it — mc-image-helper treats a patch directory
			// without .json files as "no patches", so the server still
			// starts.
			try {
				await fs.rmdir(patchPath);
				await writeFile(patchPath, EMPTY_PATCH_SET);
			} catch (recoveryErr) {
				logger.warn(
					{ error: recoveryErr, path: patchPath },
					"Patch file path is a directory; leaving it in place",
				);
			}
			return;
		}
		throw rawErr;
	}
}

/**
 * Recreates the patch-definitions file before a start when the compose
 * file mounts it but the file itself is gone (see {@link ensurePatchFile}).
 * Servers whose compose file no longer references the patch file —
 * hand-edited to drop patching — are left alone.
 */
async function ensurePatchFileIfMounted(dir: string): Promise<void> {
	let mounted = false;
	try {
		const composeConfig = await ComposeService.loadComposeConfig(dir);
		const mc = composeConfig.services[MC_SERVICE_NAME];
		mounted =
			mc?.environment?.PATCH_DEFINITIONS !== undefined ||
			(mc?.volumes?.some((volume) =>
				volume.includes(PATCH_FILE_CONTAINER_PATH),
			) ??
				false);
	} catch {
		// Load failures are logged in the compose service; the up below
		// surfaces whatever is actually wrong with the file.
		return;
	}

	if (mounted) {
		await ensurePatchFile(dir);
	}
}

/**
 * Determines the status of the Minecraft server based on container creation and server information.
 *
 * @param isContainerCreated Whether the Minecraft container has been created.
 * @param serverInfo The current server information, or null if not available.
 */
function determineStatus(
	isContainerCreated: boolean,
	serverInfo: ServerInfo | null,
): ServerStatus["status"] {
	if (!isContainerCreated) return "offline";
	if (!serverInfo) return "starting";
	return "online";
}

/**
 * Reads the compose file for the specified Minecraft server and wraps it
 * in a ManagedServer — the object that owns all compose mapping.
 *
 * @throws Will throw an error if the compose file cannot be read, parsed, or validated.
 *
 * @param serverId server id of the Minecraft server whose compose file is to be read.
 * @returns The managed server backed by the server's compose file.
 */
async function loadServer(serverId: string): Promise<ManagedServer> {
	const dir = serverPath(serverId);
	const composeConfig = await ComposeService.loadComposeConfig(dir);
	try {
		return ManagedServer.fromCompose(serverId, composeConfig);
	} catch (err) {
		const newErr = new UnexpectedKithComposeConfigError(
			dir,
			err as z.ZodError,
			{ cause: err },
		);
		logger.error(newErr);
		throw newErr;
	}
}

/**
 * Writes the compose configuration back to the server's compose file.
 */
async function saveComposeConfig(
	serverId: string,
	composeConfig: KithComposeConfig,
): Promise<void> {
	const dir = serverPath(serverId);
	await writeFile(
		path.resolve(dir, "docker-compose.yml"),
		YAML.stringify(composeConfig, { indent: 2 }),
		// The compose file carries the restic password and any cloud
		// credentials for the backup backend (see README's Security
		// section), so it's group-read-only rather than group-writable.
		{ secret: true },
	);
}

/**
 * Resolves the image tag for a patch that changes the game or modpack
 * version, the same way creation does. Returns `undefined` when the
 * patch doesn't touch versions (or a modpack server is missing its
 * MODRINTH_MODPACK), leaving the image alone.
 */
async function resolveImageTagForPatch(
	server: ManagedServer,
	patch: ServerConfigPatch,
): Promise<string | undefined> {
	if (server.type === "MODRINTH" && "modpackVersion" in patch) {
		if (!server.modpack) {
			return undefined;
		}
		return getJavaVersionForModpackVersion(
			server.modpack,
			patch.modpackVersion ?? "latest",
		);
	}

	if (server.type !== "MODRINTH" && "version" in patch) {
		return getJavaVersionForMinecraftVersion(patch.version ?? "latest");
	}

	return undefined;
}

/**
 * Checks if the Minecraft container for the given server ID has been created.
 *
 * Never throws: the compose wrapper swallows docker failures (logged
 * there), and a failed `ps` is treated as "no container" — the status
 * query keeps polling instead of dying on a transient docker hiccup.
 */
async function isContainerCreated(serverId: string): Promise<boolean> {
	const dir = serverPath(serverId);
	const result = await ComposeService.ps({
		cwd: dir,
		commandOptions: [MC_SERVICE_NAME],
	});
	return (result?.data?.services.length ?? 0) > 0;
}

/**
 * Uses the built in mc-monitor to ping the Minecraft server for a status update.
 *
 * Never throws: the compose wrapper swallows docker failures (logged
 * there), and a failed exec or an unparseable response means the server
 * isn't answerable yet — treated as "still starting" so the status
 * query keeps polling.
 */
async function pingMCServer(serverId: string): Promise<ServerInfo | null> {
	const dir = serverPath(serverId);
	const result = await ComposeService.exec(
		"mc",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the curly here is intended for shell variable substitution inside the container
		["sh", "-c", "mc-monitor status --port=${SERVER_PORT:-25565} --json"],
		{
			cwd: dir,
		},
	);

	if (!result?.out || result.out.length < 1) {
		return null;
	}

	try {
		const status = mcMonitorResponseSchema.parse(JSON.parse(result.out));
		return status.server_info;
	} catch (error) {
		const newErr = new UnexpectedServerResponseError(
			serverId,
			error as z.ZodError,
			result.out,
			{ cause: error },
		);
		logger.warn(newErr);
		return null;
	}
}

/**
 * Disambiguates a label against existing server labels so the server list
 * never shows identical entries (defaults like "My Server" collide fast).
 * Appends " (2)", " (3)"… until unique.
 */
function uniquifyLabel(label: string, existingLabels: string[]): string {
	if (!existingLabels.includes(label)) {
		return label;
	}
	let n = 2;
	while (existingLabels.includes(`${label} (${n})`)) {
		n++;
	}
	return `${label} (${n})`;
}

async function generateServerId(): Promise<string> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const id = crypto.randomUUID();
		const alreadyExists = await exists(serverPath(id));
		if (!alreadyExists) {
			return id;
		}
	}
	const err = new Error(
		"Failed to generate a unique server ID after 5 attempts.",
	);
	logger.error(err);
	throw err;
}

/**
 * Finds the first available host port within the configured range that is not
 * currently used by any managed server. Optionally excludes the specified server
 * ID from the used ports check, allowing a server to retain its current port if
 * being reassigned.
 *
 * @param excludeServerId The server ID to exclude from the used ports check.
 * @throws Error if no available port is found within the configured range.
 * @returns The first available host port within the configured range.
 */
async function getAvailablePort(excludeServerId?: string): Promise<number> {
	const used = await getAllManagedServerPorts(excludeServerId);

	for (let port = config.portRange.min; port < config.portRange.max; port++) {
		if (!used.has(port) && (await isPortFree(port))) {
			return port;
		}
	}

	throw new Error("No available port found in the configured range.");
}

/**
 * Collects every host port published by managed servers, so a new or
 * reassigned game port doesn't collide with an existing server.
 * Directories that aren't valid managed servers are skipped.
 */
async function getAllManagedServerPorts(
	excludeServerId?: string,
): Promise<Set<number>> {
	const files = await fs
		.readdir(config.serversDir, { withFileTypes: true })
		.catch((err) => {
			logger.warn(
				{ error: err },
				"Failed to list servers directory while collecting used ports",
			);
			return [];
		});

	const used = new Set<number>();

	for (const file of files) {
		if (!file.isDirectory()) {
			continue;
		}

		// Archived servers are off the roster — their ports are free
		// to be handed out again.
		if (file.name.startsWith(ARCHIVED_SERVER_PREFIX)) {
			continue;
		}

		let server: ManagedServer;
		try {
			server = await loadServer(file.name);
		} catch {
			continue; // not a managed server — nothing to count
		}

		// The excluded server's own game port is free to be picked again;
		// its other published ports still count as used.
		const hostPorts =
			file.name === excludeServerId
				? server.nonGameHostPorts
				: server.hostPorts;
		for (const host of hostPorts) {
			used.add(host);
		}
	}

	return used;
}

// #endregion Private Helpers
