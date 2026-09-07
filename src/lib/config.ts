import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import z from "zod";

const env = z
	.object({
		KITH_SERVERS_DIR: z.string().default("/var/kith/servers"),
		KITH_BASE_BACKUP_DEST: z.string().optional(),
		KITH_BACKUP_PASSWORD: z.string().optional(),
		KITH_BACKUP_INTERVAL: z.string().default("24h"),
		KITH_BACKUP_CRON_SCHEDULE: z.string().optional(),
		KITH_BACKUP_PRUNE_RETENTION: z.string().optional(),
		KITH_LOG_DIR: z.string().default("/var/kith/logs"),
		KITH_TMP_FILE_DIR: z.string().default(path.join(os.tmpdir(), "kith")),
	})
	.parse(process.env);

export const config = {
	serversDir: env.KITH_SERVERS_DIR,
	logDir: env.KITH_LOG_DIR,
	/**
	 * Base location for backup repositories — a local directory or a
	 * restic repository URL prefix (s3:, b2:, rclone:, …). Each server's
	 * repo lives at `<baseBackupDest>/<server_id>`. Unset (or empty)
	 * disables backups globally. Local destinations are resolved to an
	 * absolute path: the sidecar bind-mounts this from each server's
	 * directory, where docker compose would resolve a relative one.
	 */
	baseBackupDest: normalizeBackupDest(env.KITH_BASE_BACKUP_DEST),
	/**
	 * Global restic repository password. Required when backups are
	 * enabled (KITH_BASE_BACKUP_DEST set) — enforced at startup by
	 * validateConfig.
	 */
	backupPassword: env.KITH_BACKUP_PASSWORD || undefined,
	/** mc-backup's BACKUP_INTERVAL (sleep format, ie. "24h", "2h 30m"). */
	backupInterval: env.KITH_BACKUP_INTERVAL,
	/**
	 * mc-backup's CRON_SCHEDULE (ie. "0 4 * * *"). When set it overrides
	 * backupInterval inside the sidecar.
	 */
	backupCronSchedule: env.KITH_BACKUP_CRON_SCHEDULE || undefined,
	/** mc-backup's PRUNE_RESTIC_RETENTION (ie. "--keep-within 7d"). */
	backupPruneRetention: env.KITH_BACKUP_PRUNE_RETENTION || undefined,
	tmpFileDir: env.KITH_TMP_FILE_DIR,
	version: loadVersionNumber(),
} as const;

export const resticEnv = z
	.object({
		AWS_ACCESS_KEY_ID: z.string().optional(),
		AWS_SECRET_ACCESS_KEY: z.string().optional(),
		B2_ACCOUNT_ID: z.string().optional(),
		B2_ACCOUNT_KEY: z.string().optional(),
		AZURE_ACCOUNT_NAME: z.string().optional(),
		AZURE_ACCOUNT_KEY: z.string().optional(),
		AZURE_ACCOUNT_SAS: z.string().optional(),
		AZURE_FORCE_CLI_CREDENTIAL: z.string().optional(),
		AZURE_ENDPOINT_SUFFIX: z.string().optional(),
		GOOGLE_PROJECT_ID: z.string().optional(),
		GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
		GOOGLE_ACCESS_TOKEN: z.string().optional(),
	})
	.parse(process.env);

/**
 * The credential env vars kith forwards to the backup sidecar. Used to
 * detect when a server's sidecar has drifted from the global config.
 */
export const resticEnvKeys = Object.keys(resticEnv);

export function serverPath(id: string): string {
	return path.join(config.serversDir, id);
}

/**
 * A restic repository URL has a scheme prefix (`s3:…`, `b2:…`,
 * `rclone:…`); anything else is treated as a local directory.
 */
export function isRemoteBackupDest(dest: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(dest);
}

/**
 * Normalizes the configured backup destination: empty means unset, a
 * restic URL passes through untouched, and a local path is made
 * absolute (against kith's cwd — the same base validateConfig checks
 * against, so the startup check and the sidecar's bind mount agree).
 */
function normalizeBackupDest(dest: string | undefined): string | undefined {
	if (!dest) {
		return undefined;
	}
	if (isRemoteBackupDest(dest)) {
		return dest;
	}
	return path.resolve(dest);
}

/**
 * Validates the env config and ensures every directory it references
 * exists, creating it when possible. The remote backup case (a restic
 * URL like `s3:…`) is skipped — there's nothing to create locally.
 *
 * Failures are fatal: the process exits with an actionable message
 * naming the env var, so a typo'd path, a permission problem or a
 * missing backup password surfaces at startup instead of as a
 * confusing error deep in a feature.
 */
export function validateConfig(): void {
	if (config.baseBackupDest && !config.backupPassword) {
		process.stderr.write(
			"kith: backups are enabled (KITH_BASE_BACKUP_DEST is set) but KITH_BACKUP_PASSWORD is not.\n" +
				"Set KITH_BACKUP_PASSWORD to the password for your restic repositories.\n",
		);
		process.exit(1);
	}

	const dirs: { dir: string; envVar: string }[] = [
		{ dir: config.serversDir, envVar: "KITH_SERVERS_DIR" },
		{ dir: config.logDir, envVar: "KITH_LOG_DIR" },
		{ dir: config.tmpFileDir, envVar: "KITH_TMP_FILE_DIR" },
	];

	// A local backup destination needs to exist for the sidecar's bind
	// mount; a remote one is the restic server's problem, not ours.
	if (config.baseBackupDest && !isRemoteBackupDest(config.baseBackupDest)) {
		dirs.push({ dir: config.baseBackupDest, envVar: "KITH_BASE_BACKUP_DEST" });
	}

	for (const { dir, envVar } of dirs) {
		try {
			fs.mkdirSync(dir, { recursive: true });
			fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
			process.stderr.write(
				`kith: cannot use directory "${dir}" (${envVar}): ${code}.\n` +
					`Create it and grant read/write access, or point ${envVar} at a writable directory.\n`,
			);
			process.exit(1);
		}
	}
}

export function loadVersionNumber(): string {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = path.dirname(__filename);
	const packageJson = path.resolve(__dirname, "../../package.json");
	const packageData = z
		.object({
			version: z.string(),
		})
		.parse(JSON.parse(fs.readFileSync(packageJson, "utf-8")));
	return packageData.version;
}
