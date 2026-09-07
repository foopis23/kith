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
		// Ownership for everything kith and its containers create. Both are
		// numeric IDs (not names) so the values are unambiguous on the host
		// and inside containers, where the names may not resolve. Default to
		// the invoking user so a single-user install needs no configuration.
		// process.getuid/getgid are POSIX-only; on platforms without them
		// (Windows) fall back to -1, which skips chown entirely.
		KITH_UID: z.coerce
			.number()
			.int()
			.default(process.getuid?.() ?? -1),
		KITH_GID: z.coerce
			.number()
			.int()
			.default(process.getgid?.() ?? -1),
		// Mode for secret-bearing files (compose files with backup
		// credentials, password scratch files), as an octal string.
		// Defaults to group-writable like every other file: the primary
		// install model is a shared group managing the servers together,
		// so group members need write access to reconfigure servers.
		// Tighten it (e.g. "640" or "600") for a per-user install.
		KITH_SECRET_FILE_MODE: z
			.string()
			.regex(/^[0-7]{3}$/, "must be three octal digits, e.g. \"660\"")
			.default("660")
			.transform((v) => Number.parseInt(v, 8)),
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
	/**
	 * Ownership applied to every file and directory kith creates, and to
	 * the identity the mc/backup containers run as (so the files they
	 * write into bind mounts are owned the same way on the host). For a
	 * shared multi-user install, set KITH_GID to the shared group and
	 * point the dirs at a group-writable location; kith applies the
	 * setgid bit to directories so the group propagates to new files.
	 */
	uid: env.KITH_UID,
	gid: env.KITH_GID,
	/**
	 * Mode applied to secret-bearing files. Group-writable by default so
	 * a shared group can manage servers; set KITH_SECRET_FILE_MODE to
	 * restrict (e.g. 0o640 for group-read-only, 0o600 for owner-only).
	 */
	secretFileMode: env.KITH_SECRET_FILE_MODE,
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
			// Setgid so the shared group propagates to files created inside
			// later (by kith, a container bind mount, or a user by hand).
			// chown to a foreign id needs privileges — tolerated when it
			// fails so a single-user install (defaults already match) never
			// trips on it. Kept self-contained here rather than in lib/fs
			// to avoid a config <-> fs import cycle.
			fs.mkdirSync(dir, { recursive: true, mode: 0o2770 });
			// chown before chmod: chown clears the setgid bit (POSIX
			// security behavior), so the mode must be applied last.
			// -1 means no real id (non-POSIX) — skip chown entirely.
			if (config.uid >= 0 && config.gid >= 0) {
				try {
					fs.chownSync(dir, config.uid, config.gid);
				} catch (chownErr) {
					const chownCode = (chownErr as NodeJS.ErrnoException).code;
					if (
						chownCode !== "EPERM" &&
						chownCode !== "EINVAL" &&
						chownCode !== "ENOENT"
					) {
						throw chownErr;
					}
				}
			}
			// Tolerated like chown: a group member who doesn't own the
			// dir can't chmod it, but it's still usable via group bits.
			try {
				fs.chmodSync(dir, 0o2770);
			} catch (chmodErr) {
				const chmodCode = (chmodErr as NodeJS.ErrnoException).code;
				if (
					chmodCode !== "EPERM" &&
					chmodCode !== "EINVAL" &&
					chmodCode !== "ENOENT"
				) {
					throw chmodErr;
				}
			}
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
