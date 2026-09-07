import { z } from "zod";
import { GAME_PORT_LABEL, SERVER_LABEL } from "../lib/const.js";
import { backupDriftSchema, backupStateSchema } from "./backup.model.js";
import { composeConfigSchema, composeServiceSchema } from "./compose.model.js";

/**
 * Represents the result of executing a command on a Minecraft server.
 */
export type CommandResult = {
	success: boolean;
	output: string;
};

/**
 * This is the packet that comes back from pinging a Minecraft Server. The tool, mc_monitor calls this the "server_info".
 */
export const serverInfoSchema = z.object({
	version: z.object({
		name: z.string(),
		protocol: z.number(),
	}),
	players: z.object({
		max: z.number(),
		online: z.number(),
		Sample: z.nullable(z.any()),
	}),
	description: z.object({
		text: z.string(),
		bold: z.boolean(),
		italic: z.boolean(),
		underlined: z.boolean(),
		strikethrough: z.boolean(),
		obfuscated: z.boolean(),
		color: z.string(),
		extra: z.nullable(z.any()),
	}),
	favicon: z.string(),
});
export type ServerInfo = z.infer<typeof serverInfoSchema>;

/**
 * This is the response from the mc_monitor tool when querying a Minecraft server.
 */
export const mcMonitorResponseSchema = z.object({
	host: z.string(),
	port: z.number(),
	server_info: serverInfoSchema,
});
export type McMonitorResponse = z.infer<typeof mcMonitorResponseSchema>;

/**
 * The base server object used in the application.
 */
export const serverSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	/**
	 * The host port publishing the server's game port, read from the
	 * compose file. Undefined when the game port isn't published.
	 */
	port: z.number().optional(),
	/** Absolute path of the server's directory on disk. */
	dir: z.string(),
	/**
	 * Per-server backup state, derived from the compose file: whether the
	 * mc-backup sidecar is present, explicitly opted out of, or never set
	 * up. Independent of whether backups are configured globally.
	 */
	backups: backupStateSchema,
	/**
	 * How the server's backup sidecar has drifted from the global backup
	 * config (repository, schedule, password, …). Null when there's no
	 * drift or nothing to compare against.
	 */
	backupDrift: backupDriftSchema.nullable(),
});
export type Server = z.infer<typeof serverSchema>;

/**
 * Represents the current status of a Minecraft server, including its online status and server information if available.
 */
export const serverStatusSchema = z.object({
	status: z.enum(["offline", "starting", "online"]),
	serverInfo: serverInfoSchema.nullable(),
});
export type ServerStatus = z.infer<typeof serverStatusSchema>;

export const serverWithStatusSchema = serverSchema.extend(
	serverStatusSchema.shape,
);
export type ServerWithStatus = z.infer<typeof serverWithStatusSchema>;

/**
 * This is a schema representing the expected structure of a Docker Compose configuration created or
 * managed by this project.
 *
 * This schema enforces that the Docker Compose configuration contains specific services with required labels.
 */
export const managedComposeConfigSchema = composeConfigSchema.extend({
	services: z
		.object({
			mc: composeServiceSchema.extend({
				// The catchall keeps unrelated labels on a load/save round-trip.
				labels: z
					.object({
						[SERVER_LABEL]: z.string(),
						[GAME_PORT_LABEL]: z.string().optional(),
					})
					.catchall(z.string()),
			}),
		})
		// Services kith doesn't manage (backups, voice chat, …) are kept
		// on a load/save round-trip instead of being stripped.
		.catchall(composeServiceSchema),
});
export type KithComposeConfig = z.infer<typeof managedComposeConfigSchema>;

export const flags = ["none", "aikar", "meowice"] as const;
export type ServerFlags = (typeof flags)[number];
export const difficulties = ["peaceful", "easy", "normal", "hard"];
export const modes = ["survival", "creative", "adventure", "spectator"];

/**
 * Longest allowed server label. Generous for users, but short enough that
 * the server list can align its status column on a 120-column terminal.
 */
export const MAX_SERVER_LABEL_LENGTH = 48;

/**
 * Memory allocated to the Minecraft server, in the format expected by
 * itzg/minecraft-server's MEMORY env var (ie. "2G", "4096M").
 */
export const memorySchema = z
	.string()
	.regex(/^\d+[GgMm]$/, 'Memory must be a number followed by "G" or "M"')
	.default("2G");

export const createServerSchema = z.object({
	label: z.string().min(1).max(MAX_SERVER_LABEL_LENGTH),
	version: z.string().default("LATEST"),
	server_port: z.number().optional(), // if no port is specified, the service will find an available port automatically
	memory: memorySchema,
});

export const createVanillaServerSchema = createServerSchema.extend({
	type: z.literal("VANILLA"),
});
export type CreateVanillaServerArgs = z.infer<typeof createVanillaServerSchema>;

export const createPaperServerSchema = createServerSchema.extend({
	type: z.literal("PAPER"),
	paper_build: z.string().optional(),
	paper_channel: z.string().optional(),
});
export type CreatePaperServerArgs = z.infer<typeof createPaperServerSchema>;

export const createNeoForgeServerSchema = createServerSchema.extend({
	type: z.literal("NEO_FORGE"),
	neoforge_version: z.string().optional(),
});
export type CreateNeoForgeServerArgs = z.infer<
	typeof createNeoForgeServerSchema
>;

export const createFabricServerSchema = createServerSchema.extend({
	type: z.literal("FABRIC"),
	fabric_launcher_version: z.string().optional(),
	fabric_loader_version: z.string().optional(),
});
export type CreateFabricServerArgs = z.infer<typeof createFabricServerSchema>;

export const createModrinthServerSchema = createServerSchema.extend({
	type: z.literal("MODRINTH"),
	modrinth_modpack: z.string(),
	modrinth_modpack_version: z.string().default("latest"),
});
export type CreateModrinthServerArgs = z.infer<
	typeof createModrinthServerSchema
>;

/**
 * The editable configuration of an existing server.
 *
 * Most settings map 1:1 onto environment variables of itzg/minecraft-server
 * (see https://docker-minecraft-server.readthedocs.io/en/latest/variables/).
 * The port and image tag are not env vars — they live elsewhere in the
 * compose service — but they are configurable from the same screen, so the
 * model carries them too.
 *
 * `undefined` means "not set in the compose file". Unset fields are omitted
 * when the config is applied back, so itzg's own defaults keep applying.
 */
export type ServerConfig = {
	/** MOTD — the message shown in the multiplayer server list. */
	motd: string | undefined;
	/** DIFFICULTY — peaceful, easy, normal or hard. */
	difficulty: string | undefined;
	/** HARDCORE — hardcore mode, players are banned on death. */
	hardcore: boolean | undefined;
	/** MODE — survival, creative, adventure or spectator. */
	mode: string | undefined;
	/** LEVEL — the world/level name, also used for save discovery. */
	level: string | undefined;
	/** ENABLE_WHITELIST — enforce the whitelist (aka allowlist). */
	enableWhitelist: boolean | undefined;
	/**
	 * INITIAL_ENABLED_PACKS — comma-separated datapack ids to enable when
	 * a world is first created.
	 */
	initialEnabledPacks: string | undefined;
	/** SEED — the world seed used when generating a new world. */
	seed: string | undefined;
	/** MEMORY — heap size, ie. "2G" or "4096M". Unset means itzg's 1G default. */
	memory: string | undefined;
	/**
	 * VERSION — the Minecraft game version. For MODRINTH servers this is
	 * managed through `modpackVersion` instead.
	 */
	version: string | undefined;
	/**
	 * MODRINTH_MODPACK_VERSION — the modpack version, or "latest" to track
	 * the newest release. Only meaningful for MODRINTH servers.
	 */
	modpackVersion: string | undefined;
	/**
	 * The JVM flags preset, derived from USE_AIKAR_FLAGS/USE_MEOWICE_FLAGS.
	 * "none" when neither is set.
	 */
	flags: ServerFlags;
	/**
	 * The host port publishing the server's game port (container 25565).
	 * Derived from the service's `ports`, which may publish additional
	 * ports (voice chat, web maps) — those are left untouched on update.
	 */
	port: number | undefined;
	/** The tag of the itzg/minecraft-server image, i.e. the Java version. */
	imageTag: string | undefined;
	/** TYPE — the server type (VANILLA, MODRINTH, …). Read-only context. */
	type: string | undefined;
	/** MODRINTH_MODPACK — the modpack slug/id. Read-only context. */
	modpack: string | undefined;
};

/**
 * A partial patch of editable settings. `undefined` clears a setting,
 * removing its env var from the compose file. `type` and `modpack` are
 * read-only context and can't be patched.
 */
export type ServerConfigPatch = Partial<Omit<ServerConfig, "type" | "modpack">>;

export const serverConfigPatchSchema = z
	.object({
		motd: z.string().optional(),
		difficulty: z.enum(difficulties).optional(),
		hardcore: z.boolean().optional(),
		mode: z.enum(modes).optional(),
		level: z.string().optional(),
		enableWhitelist: z.boolean().optional(),
		initialEnabledPacks: z.string().optional(),
		seed: z.string().optional(),
		memory: memorySchema.optional(),
		version: z.string().min(1).optional(),
		modpackVersion: z.string().min(1).optional(),
		flags: z.enum(flags).optional(),
		port: z.number().int().min(1).max(65535).optional(),
		imageTag: z.string().min(1).optional(),
	})
	.strict();

export class UnexpectedServerResponseError extends Error {
	readonly code = "UNEXPECTED_SERVER_RESPONSE";
	constructor(
		readonly serverId: string,
		readonly zodError: z.ZodError,
		readonly response: unknown,
		errorOptions?: ErrorOptions,
	) {
		super(
			`Unexpected response from mc monitor "${serverId}"\n${z.prettifyError(zodError)}`,
			errorOptions,
		);
		this.name = "UnexpectedServerResponseError";
	}
}

export class CapturingLogTrailFailedError extends Error {
	readonly code = "CAPTURING_LOG_TRAIL_FAILED";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(`Capturing log trail failed for server "${serverId}"`, errorOptions);
		this.name = "CapturingLogTrailFailedError";
	}
}

export class MissingCommandResultError extends Error {
	readonly code = "MISSING_COMMAND_RESULT";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(`Missing command result for server "${serverId}"`, errorOptions);
		this.name = "MissingCommandResultError";
	}
}

export class FailedToSendCommandError extends Error {
	readonly code = "FAILED_TO_SEND_COMMAND";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(`Failed to send command to server "${serverId}"`, errorOptions);
		this.name = "FailedToSendCommand";
	}
}

export class FailedToForceStopServerError extends Error {
	readonly code = "FAILED_TO_FORCE_STOP_SERVER";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(`Failed to force-stop server "${serverId}"`, errorOptions);
		this.name = "FailedToForceStopServerError";
	}
}

export class FailedToStopServerError extends Error {
	readonly code = "FAILED_TO_STOP_SERVER";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(`Failed to stop server "${serverId}"`, errorOptions);
		this.name = "FailedToStopServerError";
	}
}

export class FailedToStartServerError extends Error {
	readonly code = "FAILED_TO_START_SERVER";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(`Failed to start server "${serverId}"`, errorOptions);
		this.name = "FailedToStartServerError";
	}
}

export class CantAccessServersDirectoryError extends Error {
	readonly code = "CANT_ACCESS_SERVERS_DIRECTORY";
	constructor(
		readonly path: string,
		errorOptions?: ErrorOptions,
	) {
		super(
			`No permission to read servers directory "${path}". Fix ownership (sudo chown -R $USER "${path}") or adjust KITH_SERVERS_DIR.`,
			errorOptions,
		);
		this.name = "CantAccessServersDirectoryError";
	}
}

export class ServersDirectoryDoesNotExistError extends Error {
	readonly code = "SERVERS_DIRECTORY_DOES_NOT_EXIST";
	constructor(
		readonly path: string,
		errorOptions?: ErrorOptions,
	) {
		super(
			`Servers directory "${path}" does not exist. Set KITH_SERVERS_DIR to a valid path or create the directory.`,
			errorOptions,
		);
		this.name = "ServersDirectoryDoesNotExistError";
	}
}

export class CantAccessServerComposeFile extends Error {
	readonly code = "CANT_ACCESS_SERVER_COMPOSE_FILE";
	constructor(
		readonly path: string,
		errorOptions?: ErrorOptions,
	) {
		super(
			`No permission to access server compose file "${path}". Fix ownership (sudo chown -R $USER "${path}")`,
			errorOptions,
		);
		this.name = "CantAccessServerComposeFile";
	}
}

export class FailedToFetchServerInfoError extends Error {
	readonly code = "FAILED_TO_FETCH_SERVER_INFO";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(`Failed to fetch server info for server "${serverId}"`, errorOptions);
		this.name = "FailedToFetchServerInfoError";
	}
}

export class ServerDirectoryDoesNotContainComposeFileError extends Error {
	readonly code = "SERVER_DIRECTORY_DOES_NOT_CONTAIN_COMPOSE_FILE";
	constructor(
		readonly path: string,
		errorOptions?: ErrorOptions,
	) {
		super(
			`Server directory "${path}" does not contain a docker-compose.yml file`,
			errorOptions,
		);
		this.name = "ServerDirectoryDoesNotContainComposeFileError";
	}
}

export class UnexpectedKithComposeConfigError extends Error {
	readonly code = "UNEXPECTED_KITH_COMPOSE_CONFIG";
	constructor(
		readonly path: string,
		readonly zodError: z.ZodError,
		errorOptions?: ErrorOptions,
	) {
		super(
			`Unexpected or missing fields for kith managed server in docker compose file "${path}"\n${z.prettifyError(zodError)}`,
			errorOptions,
		);
		this.name = "UnexpectedKithComposeConfigError";
	}
}

export class FailedToCreateServerError extends Error {
	readonly code = "FAILED_TO_CREATE_SERVER";
	constructor(
		readonly serverId: string | undefined,
		errorOptions?: ErrorOptions,
	) {
		super(`Failed to create server "${serverId}"`, errorOptions);
		this.name = "FailedToCreateServerError";
	}
}

export class FailedToFetchServerConfigError extends Error {
	readonly code = "FAILED_TO_FETCH_SERVER_CONFIG";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(`Failed to fetch config for server "${serverId}"`, errorOptions);
		this.name = "FailedToFetchServerConfigError";
	}
}

export class InvalidServerConfigPatchError extends Error {
	readonly code = "INVALID_SERVER_CONFIG_PATCH";
	constructor(
		readonly serverId: string,
		readonly zodError: z.ZodError,
		errorOptions?: ErrorOptions,
	) {
		super(
			`Invalid config patch for server "${serverId}"\n${z.prettifyError(zodError)}`,
			errorOptions,
		);
		this.name = "InvalidServerConfigPatchError";
	}
}

export class FailedToUpdateServerConfigError extends Error {
	readonly code = "FAILED_TO_UPDATE_SERVER_CONFIG";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(`Failed to update config for server "${serverId}"`, errorOptions);
		this.name = "FailedToUpdateServerConfigError";
	}
}
