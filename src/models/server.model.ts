import { z } from "zod";
import {
	BACKUP_SERVICE_NAME,
	BACKUPS_ENABLED_LABEL,
	DATA_DIR_NAME,
	GAME_PORT_ENV,
	MC_SERVICE_NAME,
	PATCH_FILE_CONTAINER_PATH,
	PATCH_FILE_NAME,
	SERVER_LABEL,
} from "../lib/const.js";
import { emptyToUndefined } from "../lib/validation.js";
import {
	type BackupState,
	backupDriftSchema,
	backupStateSchema,
} from "./backup.model.js";
import {
	type ComposeService,
	composeConfigSchema,
	composeServiceSchema,
} from "./compose.model.js";

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
	.regex(/^\d+[GgMm]$/, 'Memory must be a number followed by "G" or "M"');

export const createServerSchema = z.object({
	label: emptyToUndefined(
		z.string().min(1).max(MAX_SERVER_LABEL_LENGTH).default("My Server"),
	),
	version: z.string().default("LATEST"),
	server_port: z.number().optional(), // if no port is specified, the service will find an available port automatically
	// The default lives here rather than on memorySchema: in Zod 4 a
	// .default() fires even under .optional(), so a defaulted memorySchema
	// would inject "2G" into every config patch that doesn't touch memory.
	memory: memorySchema.default("2G"),
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
	 * The host port publishing the server's game port. The game port's
	 * host and container ports always match (SERVER_PORT); the service's
	 * `ports` may publish additional ports (voice chat, web maps) — those
	 * are left untouched on update.
	 */
	port: number | undefined;
	/** The tag of the itzg/minecraft-server image, i.e. the Java version. */
	imageTag: string | undefined;
	/** TYPE — the server type (VANILLA, MODRINTH, …). Read-only context. */
	type: string | undefined;
	/** MODRINTH_MODPACK — the modpack slug/id. Read-only context. */
	modpack: string | undefined;
	maxLogFiles: number | undefined;
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
		maxLogFiles: z.number().int().min(1).optional(),
	})
	.strict();

/**
 * How a single config field is read from and written to an env var.
 * Reading is always lenient: a hand-edited value that doesn't parse
 * reads as "unset" rather than breaking the whole config screen.
 */
type EnvCodec<T> = {
	readonly read: (raw: string | undefined) => T | undefined;
	readonly write: (value: T) => string;
};

/** "true"/"false" (any case) → boolean; anything else → undefined. */
const booleanEnvVar = z
	.stringbool({ truthy: ["true"], falsy: ["false"] })
	.optional()
	.catch(undefined);

/** A positive integer; anything else → undefined. */
const intEnvVar = z.coerce.number().int().min(1).optional().catch(undefined);

/**
 * The container port the game listens on (SERVER_PORT). Defaults to
 * 25565, itzg's default, when the variable isn't set or doesn't parse.
 */
const gamePortEnvVar = z.coerce
	.number()
	.int()
	.min(1)
	.max(65535)
	.catch(25565)
	.default(25565);

const stringEnv: EnvCodec<string> = {
	read: (raw) => raw,
	write: (value) => value,
};

const booleanEnv: EnvCodec<boolean> = {
	read: (raw) => booleanEnvVar.parse(raw),
	write: (value) => String(value),
};

const intEnv: EnvCodec<number> = {
	read: (raw) => intEnvVar.parse(raw),
	write: (value) => String(value),
};

/**
 * Compile-time contract for {@link ENV_FIELDS}: every key must be a
 * patchable config field and the codec's value type must match the
 * field's type — wiring `hardcore` to `intEnv` fails to compile
 * instead of writing garbage env vars at runtime.
 */
type EnvFieldTable = {
	[K in keyof ServerConfigPatch]?: readonly [
		string,
		EnvCodec<Exclude<ServerConfigPatch[K], undefined>>,
	];
};

/**
 * The 1:1 mapping between config fields and itzg env vars. Both reading
 * ({@link ManagedServer.config}) and writing
 * ({@link ManagedServer.applyConfigPatch}) are driven by this table, so
 * a new simple setting is one entry here plus its `ServerConfig` and
 * patch-schema declarations. Fields with cross-cutting storage
 * (modpackVersion, flags, port, imageTag) are handled separately.
 */
const ENV_FIELDS = {
	motd: ["MOTD", stringEnv],
	difficulty: ["DIFFICULTY", stringEnv],
	hardcore: ["HARDCORE", booleanEnv],
	mode: ["MODE", stringEnv],
	level: ["LEVEL", stringEnv],
	enableWhitelist: ["ENABLE_WHITELIST", booleanEnv],
	initialEnabledPacks: ["INITIAL_ENABLED_PACKS", stringEnv],
	seed: ["SEED", stringEnv],
	memory: ["MEMORY", stringEnv],
	version: ["VERSION", stringEnv],
	maxLogFiles: ["ROLLING_LOG_MAX_FILES", intEnv],
} as const satisfies EnvFieldTable;

type EnvFields = typeof ENV_FIELDS;

/** The config values backed 1:1 by env vars, with proper per-field types. */
type EnvFieldValues = {
	[K in keyof EnvFields]: EnvFields[K][1] extends EnvCodec<infer T>
		? T | undefined
		: never;
};

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
 * Replaces the tag of an image reference, keeping name and registry.
 * A digest pins exact content, so retagging drops it.
 */
function withImageTag(image: string, tag: string): string {
	const name = image.split("@")[0] ?? image;
	const current = imageTagOf(image);
	return current
		? `${name.slice(0, name.lastIndexOf(":"))}:${tag}`
		: `${name}:${tag}`;
}

/** Drops entries whose value is undefined ("unset") from an env map. */
function definedEnv(
	env: Record<string, string | undefined>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) {
			out[key] = value;
		}
	}
	return out;
}

/** Arguments for {@link ManagedServer.create}. */
export type NewManagedServerArgs = {
	/** The server's id — its directory name under the servers directory. */
	id: string;
	/** The display label, stored in the compose server label. */
	label: string;
	/** Full image reference, ie. "itzg/minecraft-server:java21". */
	image: string;
	/**
	 * The game port. Published on the host with host and container ports
	 * matching, and recorded in SERVER_PORT.
	 */
	port: number;
	/**
	 * itzg environment layered over the base env (TYPE, VERSION, MEMORY,
	 * MODRINTH_*, …). Undefined values are omitted — itzg's defaults
	 * apply for those.
	 */
	environment?: Record<string, string | undefined>;
	/**
	 * The host identity the container writes files as, recorded in the
	 * UID/GID env vars. Negative (the default) on platforms without
	 * real ids — the variables are omitted and itzg's defaults apply.
	 */
	uid?: number;
	gid?: number;
};

/**
 * A kith-managed Minecraft server as an object: the single place that
 * knows how the server's docker-compose.yml maps onto the things
 * developers care about — label, game port, image tag, backup state,
 * and the editable {@link ServerConfig}.
 *
 * Create one from compose data ({@link fromCompose}) or from scratch
 * ({@link create}), read the derived views, mutate with
 * {@link applyConfigPatch} / {@link setBackups}, and serialize back with
 * {@link toCompose}. Data the model doesn't understand (extra services,
 * env vars, labels, port mappings, service options) survives the
 * round-trip untouched.
 */
export class ManagedServer {
	private constructor(
		/** The server's id — its directory name under the servers directory. */
		readonly id: string,
		private readonly compose: KithComposeConfig,
	) {}

	/**
	 * Wraps a server's compose data, validating it has the shape kith
	 * expects (an `mc` service carrying the server label).
	 *
	 * @throws ZodError when the compose data isn't a kith-managed server.
	 */
	static fromCompose(id: string, compose: unknown): ManagedServer {
		return new ManagedServer(id, managedComposeConfigSchema.parse(compose));
	}

	/**
	 * Builds a brand-new server's compose data: the base service options
	 * kith always sets (restart policy, log rotation, data and patch-file
	 * mounts, EULA, …) plus the given image, game port and itzg env.
	 */
	static create(args: NewManagedServerArgs): ManagedServer {
		const { id, label, image, port, environment, uid = -1, gid = -1 } = args;
		return new ManagedServer(id, {
			services: {
				[MC_SERVICE_NAME]: {
					image,
					pull_policy: "daily",
					tty: true,
					stdin_open: true,
					stop_grace_period: "1m",
					restart: "unless-stopped",
					logging: {
						driver: "json-file",
						options: {
							"max-size": "10m",
							"max-file": "5",
						},
					},
					labels: {
						[SERVER_LABEL]: label,
					},
					ports: [`${port}:${port}`],
					environment: definedEnv({
						EULA: "TRUE",
						USE_AIKAR_FLAGS: "TRUE",
						PATCH_DEFINITIONS: PATCH_FILE_CONTAINER_PATH,
						...(uid >= 0 && gid >= 0 ? { UID: `${uid}`, GID: `${gid}` } : {}),
						...environment,
						[GAME_PORT_ENV]: `${port}`,
					}),
					volumes: [
						`./${DATA_DIR_NAME}:/data`,
						`./${PATCH_FILE_NAME}:${PATCH_FILE_CONTAINER_PATH}:ro`,
					],
				},
			},
		});
	}

	/**
	 * Serializes back to compose data for saving. Returns a deep copy —
	 * mutating the result doesn't affect the server.
	 */
	toCompose(): KithComposeConfig {
		return structuredClone(this.compose);
	}

	/** The `mc` service — guaranteed present by the managed schema. */
	private get mc() {
		return this.compose.services[MC_SERVICE_NAME];
	}

	/** The mc service's env vars, empty when the service declares none. */
	private get env(): Record<string, string> {
		return this.mc.environment ?? {};
	}

	/** The server's display label. */
	get label(): string {
		return this.mc.labels[SERVER_LABEL];
	}

	/** TYPE — the server type (VANILLA, MODRINTH, …). */
	get type(): string | undefined {
		return this.env.TYPE;
	}

	/** MODRINTH_MODPACK — the modpack slug/id. */
	get modpack(): string | undefined {
		return this.env.MODRINTH_MODPACK;
	}

	/** The tag of the itzg/minecraft-server image, ie. the Java version. */
	get imageTag(): string | undefined {
		return imageTagOf(this.mc.image);
	}

	/**
	 * The container port the Minecraft server listens on, read from the
	 * SERVER_PORT env var the compose file is created with. Defaults to
	 * 25565, itzg's default, when the variable isn't set.
	 */
	get gameContainerPort(): number {
		return gamePortEnvVar.parse(this.env[GAME_PORT_ENV]);
	}

	/**
	 * The host port publishing the server's game port. Undefined when the
	 * game port isn't published.
	 */
	get port(): number | undefined {
		return findHostPort(this.mc.ports, this.gameContainerPort);
	}

	/** Every host port this server publishes, game port included. */
	get hostPorts(): number[] {
		return (this.mc.ports ?? [])
			.map(hostPortOf)
			.filter((port): port is number => port !== undefined);
	}

	/**
	 * Every host port this server publishes, excluding the game port's
	 * mapping. Matched by container port (like the game port field), so
	 * an unrelated mapping that happens to share the game port's host
	 * port still counts as used.
	 */
	get nonGameHostPorts(): number[] {
		const containerPort = this.gameContainerPort;
		return (this.mc.ports ?? [])
			.filter((mapping) => containerPortOf(mapping) !== containerPort)
			.map(hostPortOf)
			.filter((port): port is number => port !== undefined);
	}

	/**
	 * The server's backup state: the sidecar's presence wins, otherwise
	 * the recorded opt-out label, otherwise the server simply predates
	 * backups.
	 */
	get backupsState(): BackupState {
		if (this.compose.services[BACKUP_SERVICE_NAME]) {
			return "enabled";
		}
		if (this.mc.labels[BACKUPS_ENABLED_LABEL] === "false") {
			return "opted_out";
		}
		return "not_set_up";
	}

	/**
	 * The backup sidecar service, when present. A live reference into the
	 * compose data — read it, but don't mutate it.
	 */
	get backupSidecar(): ComposeService | undefined {
		return this.compose.services[BACKUP_SERVICE_NAME];
	}

	/**
	 * The editable configuration, read out of the compose data.
	 * `undefined` means "not set in the compose file" — itzg's own
	 * defaults keep applying for unset fields.
	 */
	get config(): ServerConfig {
		const env = this.env;
		const type = env.TYPE;
		return {
			...this.readEnvFields(),
			// Creation omits MODRINTH_MODPACK_VERSION for "latest".
			modpackVersion:
				type === "MODRINTH"
					? (env.MODRINTH_MODPACK_VERSION ?? "latest")
					: undefined,
			flags: this.flags,
			port: this.port,
			imageTag: this.imageTag,
			type,
			modpack: env.MODRINTH_MODPACK,
		};
	}

	/**
	 * Applies a config patch to the compose data. Only the settings
	 * present in the patch are touched — unrelated env vars (EULA, TYPE,
	 * modpack settings, …), labels, extra port mappings (voice chat, web
	 * maps) and other services are preserved. A patch value of
	 * `undefined` clears the setting, removing its env var so itzg's
	 * default applies again.
	 *
	 * The patch must already be validated against serverConfigPatchSchema.
	 */
	applyConfigPatch(patch: ServerConfigPatch): void {
		const environment = { ...this.mc.environment };
		const set = (key: string, value: string | undefined) => {
			if (value === undefined) {
				delete environment[key];
			} else {
				environment[key] = value;
			}
		};

		// The 1:1 env-backed fields, driven by the mapping table.
		for (const [key, [name, codec]] of Object.entries(ENV_FIELDS)) {
			if (!(key in patch)) {
				continue;
			}
			const value = patch[key as keyof ServerConfigPatch];
			if (value === undefined) {
				delete environment[name];
			} else {
				// EnvFieldTable ties each codec to its field's type, so the
				// value always matches the codec; the loop can't see it.
				environment[name] = codec.write(value as never);
			}
		}

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

		let ports = this.mc.ports;
		if ("port" in patch) {
			// Replace the mapping for the game port, keeping every other
			// published port (voice chat, web maps) as-is. The game port's host
			// and container ports always match (SERVER_PORT), so a port change
			// rewrites both sides of the mapping.
			const containerPort = this.gameContainerPort;
			const others = (this.mc.ports ?? []).filter(
				(port) => containerPortOf(port) !== containerPort,
			);

			if (patch.port === undefined) {
				ports = others;
				set(GAME_PORT_ENV, undefined);
			} else {
				ports = [`${patch.port}:${patch.port}`, ...others];
				set(GAME_PORT_ENV, String(patch.port));
			}
		}

		let image = this.mc.image;
		if ("imageTag" in patch && patch.imageTag !== undefined) {
			image = withImageTag(image, patch.imageTag);
		}

		// The spread preserves every unmanaged property of the service
		// (labels and all); only the patched slices are replaced. A
		// service that declared no environment doesn't gain an empty one.
		this.compose.services[MC_SERVICE_NAME] = {
			...this.mc,
			image,
			ports,
			...(this.mc.environment !== undefined ||
			Object.keys(environment).length > 0
				? { environment }
				: {}),
		};
	}

	/**
	 * Adds or removes the backup sidecar, recording the choice in a label
	 * so an opted-out server isn't nagged to set backups up. Removing the
	 * sidecar keeps the restic repository itself — re-enabling picks up
	 * where backups left off.
	 */
	setBackups(sidecar: ComposeService | undefined): void {
		if (sidecar) {
			this.compose.services[BACKUP_SERVICE_NAME] = sidecar;
		} else {
			delete this.compose.services[BACKUP_SERVICE_NAME];
		}
		this.mc.labels = {
			...this.mc.labels,
			[BACKUPS_ENABLED_LABEL]: String(sidecar !== undefined),
		};
	}

	/**
	 * Replaces the backup sidecar in place, leaving the recorded choice
	 * label alone — re-pointing an enabled server at a new global
	 * config isn't a new choice.
	 */
	replaceBackupSidecar(sidecar: ComposeService): void {
		this.compose.services[BACKUP_SERVICE_NAME] = sidecar;
	}

	/** The JVM flags preset, derived from the flag env vars. */
	private get flags(): ServerFlags {
		if (booleanEnvVar.parse(this.env.USE_MEOWICE_FLAGS) === true) {
			return "meowice";
		}
		if (booleanEnvVar.parse(this.env.USE_AIKAR_FLAGS) === true) {
			return "aikar";
		}
		return "none";
	}

	/** Reads every 1:1 env-backed config field via the mapping table. */
	private readEnvFields(): EnvFieldValues {
		const env = this.env;
		const values: Record<string, unknown> = {};
		for (const [key, [name, codec]] of Object.entries(ENV_FIELDS)) {
			values[key] = codec.read(env[name]);
		}
		return values as EnvFieldValues;
	}
}

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
