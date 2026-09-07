import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import YAML from "yaml";
import type z from "zod";
import { config, serverPath } from "../lib/config.js";
import { makeDir, writeFile } from "../lib/fs.js";
import {
	BACKUP_SERVICE_NAME,
	BACKUPS_ENABLED_LABEL,
	DATA_DIR_NAME,
	GAME_PORT_LABEL,
	MC_SERVICE_NAME,
	PATCH_FILE_CONTAINER_PATH,
	PATCH_FILE_NAME,
	SERVER_LABEL,
} from "../lib/const.js";
import { logger as globalLogger } from "../lib/logger.js";
import {
	type BackupState,
	FailedToUpdateBackupsError,
} from "../models/backup.model.js";
import type { ComposeService as ComposeServiceConfig } from "../models/compose.model.js";
import type { LogLine, LogStream } from "../models/log.model.js";
import { safeTextSchema } from "../models/log.model.js";
import type {
	CreateModrinthServerArgs,
	CreateVanillaServerArgs,
	KithComposeConfig,
	ServerStatus,
} from "../models/server.model.js";
import {
	CantAccessServerComposeFile,
	CantAccessServersDirectoryError,
	CapturingLogTrailFailedError,
	type CommandResult,
	FailedToCreateServerError,
	FailedToFetchServerConfigError,
	FailedToFetchServerInfoError,
	FailedToSendCommandError,
	FailedToStartServerError,
	FailedToStopServerError,
	FailedToUpdateServerConfigError,
	InvalidServerConfigPatchError,
	MissingCommandResultError,
	managedComposeConfigSchema,
	mcMonitorResponseSchema,
	type Server,
	type ServerConfig,
	type ServerConfigPatch,
	ServerDirectoryDoesNotContainComposeFileError,
	type ServerFlags,
	type ServerInfo,
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
		composeFileExists = await fs.exists(composeFilePath);
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

	let composeConfig: KithComposeConfig;
	try {
		composeConfig = await loadComposeConfig(serverId);
	} catch (err) {
		const newErr = new FailedToFetchServerInfoError(serverId, {
			cause: err,
		});
		logger.error({ error: newErr }, newErr.message);
		throw newErr;
	}

	return {
		id: serverId,
		label: composeConfig.services.mc.labels[SERVER_LABEL],
		port: findHostPort(
			composeConfig.services.mc.ports,
			gameContainerPort(composeConfig.services.mc),
		),
		dir,
		backups: backupStateOf(composeConfig),
		backupDrift: BackupService.detectDrift(
			composeConfig.services[BACKUP_SERVICE_NAME],
			serverId,
		),
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
	let { server_port } = args;

	const { label, version, type, memory } = args;
	let id: string | undefined;
	try {
		id = await generateServerId();
		const dir = serverPath(id);
		const dockerComposeFilePath = path.resolve(dir, "docker-compose.yml");

		await makeDir(dir);

		if (!server_port) {
			server_port = await getAvailablePort();
		}

		const javaTag = await getJavaVersionForMinecraftVersion(version);

		const backupService = BackupService.backupsGloballyEnabled()
			? BackupService.buildBackupServiceConfig(id)
			: undefined;

		const composeConfig = {
			services: {
				mc: {
					image: `itzg/minecraft-server:${javaTag}`,
					pull_policy: "daily",
					tty: true,
					stdin_open: true,
					labels: {
						[SERVER_LABEL]: label || id,
						[GAME_PORT_LABEL]: "25565",
						...(backupService ? { [BACKUPS_ENABLED_LABEL]: "true" } : {}),
					},
					ports: [`${server_port}:25565`],
					environment: {
						EULA: "TRUE",
						TYPE: `${type}`,
						VERSION: `${version}`,
						MEMORY: memory,
						USE_AIKAR_FLAGS: "TRUE",
						PATCH_DEFINITIONS: PATCH_FILE_CONTAINER_PATH,
						// Run the server as the configured host identity so files
						// written into the bind-mounted data dir are owned
						// uid:gid on the host (shared-group installs). The image's
						// entrypoint re-maps its minecraft user to these and
						// chowns /data to match. Skipped when no real id is
						// configured (non-POSIX host) — the image default applies.
						...(config.uid >= 0 && config.gid >= 0
							? { UID: `${config.uid}`, GID: `${config.gid}` }
							: {}),
					},
					volumes: [
						`./${DATA_DIR_NAME}:/data`,
						`./${PATCH_FILE_NAME}:${PATCH_FILE_CONTAINER_PATH}:ro`,
					],
				},
				...(backupService ? { [BACKUP_SERVICE_NAME]: backupService } : {}),
			},
		};
		await writeFile(
			dockerComposeFilePath,
			YAML.stringify(composeConfig, { indent: 2 }),
			{ secret: true },
		);
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
	let { server_port } = args;
	const { label, type, modrinth_modpack, modrinth_modpack_version, memory } =
		args;

	let id: string | undefined;
	try {
		id = await generateServerId();
		const dir = serverPath(id);
		const dockerComposeFilePath = path.resolve(dir, "docker-compose.yml");

		await makeDir(dir);

		if (!server_port) {
			server_port = await getAvailablePort();
		}

		const { identifier } = parseModrinthModpack(modrinth_modpack);
		const javaTag = await getJavaVersionForModpackVersion(
			modrinth_modpack,
			modrinth_modpack_version,
		);

		const backupService = BackupService.backupsGloballyEnabled()
			? BackupService.buildBackupServiceConfig(id)
			: undefined;

		const composeConfig = {
			services: {
				mc: {
					image: `itzg/minecraft-server:${javaTag}`,
					pull_policy: "daily",
					tty: true,
					stdin_open: true,
					labels: {
						[SERVER_LABEL]: label || id,
						[GAME_PORT_LABEL]: "25565",
						...(backupService ? { [BACKUPS_ENABLED_LABEL]: "true" } : {}),
					},
					ports: [`${server_port}:25565`],
					environment: {
						EULA: "TRUE",
						TYPE: `${type}`,
						MODRINTH_MODPACK: identifier,
						MODRINTH_MODPACK_VERSION:
							modrinth_modpack_version === "latest"
								? undefined
								: modrinth_modpack_version,
						VERSION:
							modrinth_modpack_version === "latest" ? "latest" : undefined,
						MEMORY: memory,
						USE_AIKAR_FLAGS: "TRUE",
						PATCH_DEFINITIONS: PATCH_FILE_CONTAINER_PATH,
						// Same host-identity mapping as the vanilla path above.
						...(config.uid >= 0 && config.gid >= 0
							? { UID: `${config.uid}`, GID: `${config.gid}` }
							: {}),
					},
					volumes: [
						`./${DATA_DIR_NAME}:/data`,
						`./${PATCH_FILE_NAME}:${PATCH_FILE_CONTAINER_PATH}:ro`,
					],
				},
				...(backupService ? { [BACKUP_SERVICE_NAME]: backupService } : {}),
			},
		};

		await writeFile(
			dockerComposeFilePath,
			YAML.stringify(composeConfig, { indent: 2 }),
			{ secret: true },
		);
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
		const composeConfig = await loadComposeConfig(serverId);
		return serverConfigFromService(composeConfig.services.mc);
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
	return enqueueConfigUpdate(serverId, () =>
		applyServerConfigUpdate(serverId, validated.data),
	);
}

/**
 * Per-server tails of the config update queue, see {@link enqueueConfigUpdate}.
 */
const configUpdateQueues = new Map<string, Promise<unknown>>();

/**
 * Runs a config update after every previously queued update for the same
 * server has settled. Updates for different servers still run in parallel.
 * The queue entry is removed once it drains, so the map can't grow without
 * bound.
 */
function enqueueConfigUpdate<T>(
	serverId: string,
	update: () => Promise<T>,
): Promise<T> {
	const previous = configUpdateQueues.get(serverId) ?? Promise.resolve();
	const run = previous.catch(() => {}).then(update);
	configUpdateQueues.set(serverId, run);
	const cleanup = () => {
		if (configUpdateQueues.get(serverId) === run) {
			configUpdateQueues.delete(serverId);
		}
	};
	run.then(cleanup, cleanup);
	return run;
}

/**
 * Applies a validated config patch, see {@link updateServerConfig}.
 * Must only be called through the per-server update queue.
 */
async function applyServerConfigUpdate(
	serverId: string,
	patch: ServerConfigPatch,
): Promise<ServerConfig> {
	try {
		const composeConfig = await loadComposeConfig(serverId);
		const current = composeConfig.services.mc;

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
			const tag = await resolveImageTagForPatch(current, resolved);
			if (tag) {
				resolved = { ...resolved, imageTag: tag };
			}
		}

		const updated = applyServerConfigPatch(current, resolved);

		await saveComposeConfig(serverId, {
			...composeConfig,
			services: { ...composeConfig.services, mc: updated },
		});

		return serverConfigFromService(updated);
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
	return enqueueConfigUpdate(serverId, () =>
		applyBackupsUpdate(serverId, enabled),
	);
}

/**
 * Applies a backups enable/disable, see {@link setServerBackupsEnabled}.
 * Must only be called through the per-server update queue.
 */
async function applyBackupsUpdate(
	serverId: string,
	enabled: boolean,
): Promise<void> {
	try {
		const composeConfig = await loadComposeConfig(serverId);
		const services = { ...composeConfig.services };

		if (enabled) {
			services[BACKUP_SERVICE_NAME] =
				BackupService.buildBackupServiceConfig(serverId);
		} else {
			delete services[BACKUP_SERVICE_NAME];
		}

		services.mc = {
			...services.mc,
			labels: {
				...services.mc.labels,
				[BACKUPS_ENABLED_LABEL]: String(enabled),
			},
		};

		await saveComposeConfig(serverId, { ...composeConfig, services });
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
	return enqueueConfigUpdate(serverId, async () => {
		const composeConfig = await loadComposeConfig(serverId);
		const oldSidecar = composeConfig.services[BACKUP_SERVICE_NAME];
		if (!oldSidecar) {
			// No sidecar means there's nothing to reconcile — enabling
			// backups is the right action for that server instead.
			throw new FailedToUpdateBackupsError(serverId);
		}

		await BackupService.migrateToGlobalConfig(serverId, oldSidecar);

		try {
			await saveComposeConfig(serverId, {
				...composeConfig,
				services: {
					...composeConfig.services,
					[BACKUP_SERVICE_NAME]:
						BackupService.buildBackupServiceConfig(serverId),
				},
			});
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
 * Starts a specific Minecraft server.
 *
 * @param serverId The ID of the server to start.
 * @throws An error if the server fails to start.
 */
export async function start(serverId: string): Promise<void> {
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
 * Derives the server's backup state from its compose file: the sidecar's
 * presence wins, otherwise the recorded opt-out label, otherwise the
 * server simply predates backups.
 */
function backupStateOf(composeConfig: KithComposeConfig): BackupState {
	if (composeConfig.services[BACKUP_SERVICE_NAME]) {
		return "enabled";
	}
	if (composeConfig.services.mc.labels[BACKUPS_ENABLED_LABEL] === "false") {
		return "opted_out";
	}
	return "not_set_up";
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
 * Reads and parses the Kith compose configuration for the specified Minecraft server.
 *
 * @throws Will throw an error if the compose file cannot be read, parsed, or validated.
 *
 * @param serverId server id of the Minecraft server whose compose file is to be read.
 * @returns The parsed Kith compose configuration for the specified server.
 */
async function loadComposeConfig(serverId: string): Promise<KithComposeConfig> {
	const dir = serverPath(serverId);
	const composeConfig = await ComposeService.loadComposeConfig(dir);
	try {
		return managedComposeConfigSchema.parse(composeConfig);
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
 * Matches a compose port mapping, capturing the optional host port and
 * the container port: `"25565"`, `"25565:25565"`, `"24454:24454/udp"`.
 *
 * Deliberately does not support host-IP-prefixed (`"127.0.0.1:25565:25565"`)
 * or IPv6 mappings: kith only writes plain port mappings itself, and
 * servers are expected to be created and managed through kith. A
 * hand-edited mapping in one of those forms is treated as an unmanaged
 * "other" port — it survives rewrites untouched, but the game port field
 * won't recognize it.
 */
const portMappingPattern = /^(?:(\d+):)?(\d+)(?:\/(?:tcp|udp))?$/;

/** Extracts the container port from a compose port mapping. */
function containerPortOf(mapping: string): number | undefined {
	const match = portMappingPattern.exec(mapping);
	if (!match?.[2]) {
		return undefined;
	}
	const parsed = Number.parseInt(match[2], 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Extracts the host port from a compose port mapping. A mapping with no
 * host part (`"25565"`) counts as its container port — conservative,
 * since Docker would publish it on an ephemeral port.
 */
function hostPortOf(mapping: string): number | undefined {
	const match = portMappingPattern.exec(mapping);
	const host = match?.[1] ?? match?.[2];
	if (!host) {
		return undefined;
	}
	const parsed = Number.parseInt(host, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Finds the host port publishing the given container port, e.g. the
 * `"25565:25565"` in `["25565:25565", "24454:24454/udp"]`.
 */
function findHostPort(
	ports: string[] | undefined,
	containerPort: number,
): number | undefined {
	const mapping = ports?.find(
		(port) => containerPortOf(port) === containerPort,
	);
	return mapping ? hostPortOf(mapping) : undefined;
}

/**
 * The container port the Minecraft server listens on, identified by the
 * game-port label the compose file is created with. Defaults to 25565
 * for files predating the label.
 */
function gameContainerPort(service: ComposeServiceConfig): number {
	const raw = service.labels?.[GAME_PORT_LABEL];
	if (!raw) {
		return 25565;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) ? 25565 : parsed;
}

/**
 * Extracts the tag from an image reference, e.g. `"java21"` from
 * `"itzg/minecraft-server:java21"`. A digest or missing tag yields
 * `undefined`.
 */
function imageTagOf(image: string): string | undefined {
	const name = image.split("@")[0] ?? image;
	const separator = name.lastIndexOf(":");

	// No colon, or the colon belongs to a registry port ("host:5000/img").
	if (separator === -1 || separator < name.lastIndexOf("/")) {
		return undefined;
	}

	return name.slice(separator + 1);
}

/**
 * Parses a boolean env var value ("TRUE"/"false") into a boolean.
 * Returns `undefined` for anything else instead of throwing — an
 * unexpected value shouldn't break the whole config screen.
 */
function parseBooleanEnvVar(value: string | undefined): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}

	const normalized = value.toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return undefined;
}

/**
 * Derives the JVM flags preset from the flag env vars. "none" when
 * neither is enabled.
 */
function parseFlags(env: Record<string, string>): ServerFlags {
	if (parseBooleanEnvVar(env.USE_MEOWICE_FLAGS) === true) return "meowice";
	if (parseBooleanEnvVar(env.USE_AIKAR_FLAGS) === true) return "aikar";
	return "none";
}

/**
 * Reads the editable configuration out of a compose service.
 */
function serverConfigFromService(service: ComposeServiceConfig): ServerConfig {
	const env = service.environment ?? {};
	const type = env.TYPE;

	return {
		motd: env.MOTD,
		difficulty: env.DIFFICULTY,
		hardcore: parseBooleanEnvVar(env.HARDCORE),
		mode: env.MODE,
		level: env.LEVEL,
		enableWhitelist: parseBooleanEnvVar(env.ENABLE_WHITELIST),
		initialEnabledPacks: env.INITIAL_ENABLED_PACKS,
		seed: env.SEED,
		memory: env.MEMORY,
		version: env.VERSION,
		// Creation omits MODRINTH_MODPACK_VERSION for "latest".
		modpackVersion:
			type === "MODRINTH"
				? (env.MODRINTH_MODPACK_VERSION ?? "latest")
				: undefined,
		flags: parseFlags(env),
		port: findHostPort(service.ports, gameContainerPort(service)),
		imageTag: imageTagOf(service.image),
		type,
		modpack: env.MODRINTH_MODPACK,
	};
}

/**
 * Applies a config patch to a compose service, returning a new service.
 * The original is left untouched.
 *
 * Only the env vars the config model owns are modified — unrelated
 * variables (EULA, TYPE, MEMORY, modpack settings, …) are preserved, as
 * are extra port mappings (voice chat, web maps). A patch value of
 * `undefined` removes the setting's env var, letting itzg's default
 * apply again.
 */
function applyServerConfigPatch<T extends ComposeServiceConfig>(
	service: T,
	patch: ServerConfigPatch,
): T {
	const environment = { ...service.environment };

	const set = (key: string, value: string | undefined) => {
		if (value === undefined) {
			delete environment[key];
		} else {
			environment[key] = value;
		}
	};

	if ("motd" in patch) set("MOTD", patch.motd);
	if ("difficulty" in patch) set("DIFFICULTY", patch.difficulty);
	if ("hardcore" in patch) {
		set(
			"HARDCORE",
			patch.hardcore === undefined ? undefined : String(patch.hardcore),
		);
	}
	if ("mode" in patch) set("MODE", patch.mode);
	if ("level" in patch) set("LEVEL", patch.level);
	if ("enableWhitelist" in patch) {
		set(
			"ENABLE_WHITELIST",
			patch.enableWhitelist === undefined
				? undefined
				: String(patch.enableWhitelist),
		);
	}
	if ("initialEnabledPacks" in patch) {
		set("INITIAL_ENABLED_PACKS", patch.initialEnabledPacks);
	}
	if ("seed" in patch) set("SEED", patch.seed);
	if ("memory" in patch) set("MEMORY", patch.memory);
	if ("version" in patch) set("VERSION", patch.version);
	if ("modpackVersion" in patch) {
		// Mirrors creation: "latest" (or clearing) tracks the newest pack
		// release via VERSION=latest; a pinned version drops VERSION.
		if (
			patch.modpackVersion === undefined ||
			patch.modpackVersion === "latest"
		) {
			set("MODRINTH_MODPACK_VERSION", undefined);
			set("VERSION", "latest");
		} else {
			set("MODRINTH_MODPACK_VERSION", patch.modpackVersion);
			set("VERSION", undefined);
		}
	}
	if ("flags" in patch) {
		set("USE_AIKAR_FLAGS", patch.flags === "aikar" ? "TRUE" : undefined);
		set("USE_MEOWICE_FLAGS", patch.flags === "meowice" ? "TRUE" : undefined);
	}

	let ports = service.ports;
	if ("port" in patch) {
		// Replace the mapping for the game port, keeping every other
		// published port (voice chat, web maps) as-is.
		const containerPort = gameContainerPort(service);
		const others = (service.ports ?? []).filter(
			(port) => containerPortOf(port) !== containerPort,
		);

		ports =
			patch.port === undefined
				? others
				: [`${patch.port}:${containerPort}`, ...others];
	}

	let image = service.image;
	if ("imageTag" in patch && patch.imageTag !== undefined) {
		const tag = imageTagOf(service.image);
		image = tag
			? `${service.image.slice(0, service.image.lastIndexOf(":"))}:${patch.imageTag}`
			: `${service.image}:${patch.imageTag}`;
	}

	// The spread preserves every property of T (labels and all); only the
	// patched slices are replaced.
	return { ...service, image, ports, environment };
}

/**
 * Resolves the image tag for a patch that changes the game or modpack
 * version, the same way creation does. Returns `undefined` when the
 * patch doesn't touch versions (or a modpack server is missing its
 * MODRINTH_MODPACK), leaving the image alone.
 */
async function resolveImageTagForPatch(
	service: ComposeServiceConfig,
	patch: ServerConfigPatch,
): Promise<string | undefined> {
	const env = service.environment ?? {};

	if (env.TYPE === "MODRINTH" && "modpackVersion" in patch) {
		if (!env.MODRINTH_MODPACK) {
			return undefined;
		}
		return getJavaVersionForModpackVersion(
			env.MODRINTH_MODPACK,
			patch.modpackVersion ?? "latest",
		);
	}

	if (env.TYPE !== "MODRINTH" && "version" in patch) {
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
	const result = await ComposeService.exec("mc", "mc-monitor status --json", {
		cwd: dir,
	});

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

async function generateServerId(): Promise<string> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const id = crypto.randomUUID();
		const exists = await fs.exists(serverPath(id));
		if (!exists) {
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
 * Finds the first host port not published by any managed server,
 * starting at 25565. When `excludeServerId` is given, that server's own
 * game port mapping doesn't count as used (its other mappings — voice
 * chat, web maps — still do), so reassigning a server's port can land
 * on the port it already had.
 */
async function getAvailablePort(excludeServerId?: string): Promise<number> {
	const used = await getUsedHostPorts(excludeServerId);
	let port = 25565;
	while (used.has(port)) {
		port++;
	}
	return port;
}

/**
 * Collects every host port published by managed servers, so a new or
 * reassigned game port doesn't collide with an existing server.
 * Directories that aren't valid managed servers are skipped.
 */
async function getUsedHostPorts(
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

		let service: ComposeServiceConfig;
		try {
			const composeConfig = await loadComposeConfig(file.name);
			service = composeConfig.services.mc;
		} catch {
			continue; // not a managed server — nothing to count
		}

		const gamePort = gameContainerPort(service);
		for (const mapping of service.ports ?? []) {
			if (
				file.name === excludeServerId &&
				containerPortOf(mapping) === gamePort
			) {
				continue;
			}
			const host = hostPortOf(mapping);
			if (host !== undefined) {
				used.add(host);
			}
		}
	}

	return used;
}

// #endregion Private Helpers
