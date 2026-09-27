export const MC_SERVICE_NAME = "mc";
export const BACKUP_SERVICE_NAME = "backup";
export const DATA_DIR_NAME = "data";

/**
 * Patch-definitions file for itzg's config patching. Kith seeds it with
 * an empty patch set, mounts it into the mc container at
 * PATCH_FILE_CONTAINER_PATH, and points PATCH_DEFINITIONS at it. Users
 * add patch definitions to the host file by hand.
 */
export const PATCH_FILE_NAME = "patches.json";
export const PATCH_FILE_CONTAINER_PATH = "/patches.json";

/** Compose label carrying the server's display label. */
export const SERVER_LABEL = "kith.server.label";

/**
 * itzg/minecraft-server env var naming the container port the game
 * listens on. Kith publishes the same port on the host, so a game-port
 * mapping always has matching host and container ports.
 */
export const GAME_PORT_ENV = "SERVER_PORT";

/**
 * Compose label recording the per-server backup choice: "false" is an
 * explicit opt-out (so kith doesn't nag about setting backups up),
 * "true" means the backup sidecar was added by kith.
 */
export const BACKUPS_ENABLED_LABEL = "kith.backups.enabled";

/**
 * Directory-name prefix marking a server as archived: the data stays on
 * disk, but kith no longer lists the server or counts its ports as used.
 * Leading dot hides the directory from a plain `ls` — archived servers
 * are off the roster — while the tag keeps `ls -a` self-explanatory.
 */
export const ARCHIVED_SERVER_PREFIX = ".archived.";
