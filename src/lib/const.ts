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
 * Compose label identifying which published port is the Minecraft game
 * port, so config updates never touch other mappings (voice chat, web
 * maps). The value is the container port, ie. "25565".
 */
export const GAME_PORT_LABEL = "kith.server.game-port";

/**
 * Compose label recording the per-server backup choice: "false" is an
 * explicit opt-out (so kith doesn't nag about setting backups up),
 * "true" means the backup sidecar was added by kith.
 */
export const BACKUPS_ENABLED_LABEL = "kith.backups.enabled";
