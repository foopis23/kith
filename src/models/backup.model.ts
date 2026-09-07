import { z } from "zod";

/**
 * How backups relate to a server, derived from its compose file:
 * - "enabled" — the mc-backup sidecar service is present.
 * - "opted_out" — no sidecar, and the user explicitly disabled backups
 *   for this server (recorded via a label, so kith doesn't nag).
 * - "not_set_up" — no sidecar and no recorded choice, ie. the server
 *   predates backups being enabled globally.
 */
export const backupStateSchema = z.enum(["enabled", "opted_out", "not_set_up"]);
export type BackupState = z.infer<typeof backupStateSchema>;

/**
 * How a server's backup sidecar has drifted from the global backup
 * config it's meant to track. `fields` names what changed (for the
 * warning); `passwordChanged` flags the destructive case — restic
 * encrypts a repo with its init-time password, so re-initializing with
 * a new one orphans every existing snapshot unless the data is
 * migrated first.
 */
export const backupDriftSchema = z.object({
	/** Names of what changed (for the warning), ie. "repository". */
	fields: z.array(z.string()),
	/**
	 * Flags the destructive-looking case: restic encrypts a repo with
	 * its init-time password, so the password must be migrated, not just
	 * swapped in the compose file.
	 */
	passwordChanged: z.boolean(),
	/**
	 * Where the server's backups actually live under its current
	 * sidecar config — only set when the repository itself drifted.
	 */
	actualRepository: z.string().optional(),
	/**
	 * Backups were disabled globally while this server still has a
	 * sidecar. The sidecar keeps running on its last config until the
	 * user chooses to keep it (now self-managed) or disable it.
	 */
	globalDisabled: z.boolean(),
});
export type BackupDrift = z.infer<typeof backupDriftSchema>;

/**
 * A single restic snapshot, parsed from `restic snapshots --json`.
 * Loose on purpose: restic adds fields across versions, and kith only
 * displays a few of them.
 */
export const resticSnapshotSchema = z.looseObject({
	id: z.string(),
	short_id: z.string().optional(),
	/** RFC 3339 timestamp of when the snapshot was taken. */
	time: z.string(),
	hostname: z.string().optional(),
	paths: z.array(z.string()).optional(),
	tags: z.array(z.string()).optional(),
});
export type BackupSnapshot = z.infer<typeof resticSnapshotSchema>;

export class BackupsNotConfiguredError extends Error {
	readonly code = "BACKUPS_NOT_CONFIGURED";
	constructor(errorOptions?: ErrorOptions) {
		super(
			"Backups are not configured. Set KITH_BASE_BACKUP_DEST to a directory or restic repository URL to enable them.",
			errorOptions,
		);
		this.name = "BackupsNotConfiguredError";
	}
}

export class FailedToListSnapshotsError extends Error {
	readonly code = "FAILED_TO_LIST_SNAPSHOTS";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(
			`Failed to list snapshots for server "${serverId}" — its backup repository exists but couldn't be read (wrong password after a config change, unreachable backend, or a docker problem). Check the kith logs for details.`,
			errorOptions,
		);
		this.name = "FailedToListSnapshotsError";
	}
}

export class BackupPasswordNotConfiguredError extends Error {
	readonly code = "BACKUP_PASSWORD_NOT_CONFIGURED";
	constructor(errorOptions?: ErrorOptions) {
		super(
			"Backups are enabled but no password is set. Set KITH_BACKUP_PASSWORD to the password for your restic repositories.",
			errorOptions,
		);
		this.name = "BackupPasswordNotConfiguredError";
	}
}

export class FailedToUpdateBackupsError extends Error {
	readonly code = "FAILED_TO_UPDATE_BACKUPS";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(`Failed to update backups for server "${serverId}"`, errorOptions);
		this.name = "FailedToUpdateBackupsError";
	}
}

export class BackupSidecarNotRunningError extends Error {
	readonly code = "BACKUP_SIDECAR_NOT_RUNNING";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(
			`The backup sidecar for server "${serverId}" isn't running, but the server is — an offline-style backup would skip the save-off flush and could capture a half-written world. Restart the server to bring the sidecar back, or stop the server to back it up offline.`,
			errorOptions,
		);
		this.name = "BackupSidecarNotRunningError";
	}
}

export class FailedToInitBackupRepoError extends Error {
	readonly code = "FAILED_TO_INIT_BACKUP_REPO";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(
			`Backups were enabled for server "${serverId}", but initializing the restic repository failed. Check KITH_BACKUP_PASSWORD and your backend credentials — the backup sidecar will retry the next time the server starts.`,
			errorOptions,
		);
		this.name = "FailedToInitBackupRepoError";
	}
}

export class FailedToMigrateBackupRepoError extends Error {
	readonly code = "FAILED_TO_MIGRATE_BACKUP_REPO";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(
			`Failed to migrate backups for server "${serverId}" to the global backup config. The server's compose file was left unchanged, so its existing backups are untouched.`,
			errorOptions,
		);
		this.name = "FailedToMigrateBackupRepoError";
	}
}

export class BackupCredentialMigrationUnsupportedError extends Error {
	readonly code = "BACKUP_CREDENTIAL_MIGRATION_UNSUPPORTED";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(
			`Backups for server "${serverId}" can't be migrated automatically: the old and new repositories use different backend credentials, and restic can only authenticate to one backend per command. Run "restic copy" manually (its -o flags can carry per-repo credentials), or give the new config credentials that can read both repositories. The server's compose file was left unchanged, so its existing backups are untouched.`,
			errorOptions,
		);
		this.name = "BackupCredentialMigrationUnsupportedError";
	}
}

export class RestoreRequiresStoppedServerError extends Error {
	readonly code = "RESTORE_REQUIRES_STOPPED_SERVER";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(
			`Server "${serverId}" must be stopped to restore a backup — restoring under a running server would corrupt the world it's writing.`,
			errorOptions,
		);
		this.name = "RestoreRequiresStoppedServerError";
	}
}

export class FailedToRestoreBackupError extends Error {
	readonly code = "FAILED_TO_RESTORE_BACKUP";
	constructor(
		readonly serverId: string,
		readonly snapshotId: string,
		errorOptions?: ErrorOptions,
	) {
		super(
			`Failed to restore snapshot "${snapshotId}" for server "${serverId}". The server's files may be partially restored — check them before starting the server.`,
			errorOptions,
		);
		this.name = "FailedToRestoreBackupError";
	}
}

export class FailedToRunBackupError extends Error {
	readonly code = "FAILED_TO_RUN_BACKUP";
	constructor(
		readonly serverId: string,
		errorOptions?: ErrorOptions,
	) {
		super(`Failed to run a backup for server "${serverId}"`, errorOptions);
		this.name = "FailedToRunBackupError";
	}
}
