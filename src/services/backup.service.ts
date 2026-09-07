import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { z } from "zod";
import {
	config,
	isRemoteBackupDest,
	resticEnv,
	resticEnvKeys,
	serverPath,
} from "../lib/config.js";
import {
	BACKUP_SERVICE_NAME,
	DATA_DIR_NAME,
	MC_SERVICE_NAME,
} from "../lib/const.js";
import { logger as globalLogger } from "../lib/logger.js";
import { makeDir, writeFile } from "../lib/fs.js";
import {
	BackupCredentialMigrationUnsupportedError,
	type BackupDrift,
	BackupPasswordNotConfiguredError,
	BackupSidecarNotRunningError,
	type BackupSnapshot,
	BackupsNotConfiguredError,
	FailedToInitBackupRepoError,
	FailedToListSnapshotsError,
	FailedToMigrateBackupRepoError,
	FailedToRestoreBackupError,
	FailedToRunBackupError,
	RestoreRequiresStoppedServerError,
	resticSnapshotSchema,
} from "../models/backup.model.js";
import type { ComposeService as ComposeServiceConfig } from "../models/compose.model.js";
import * as ComposeService from "./compose.service.js";

const logger = globalLogger.child({ service: "backup.service.ts" });

/**
 * The container path the local backup destination is mounted at in the
 * sidecar. Remote restic repositories (s3:, b2:, …) need no mount.
 */
const LOCAL_BACKUPS_MOUNT = "/backups";

/**
 * Container path the migration scratch dir is mounted at. Kept off the
 * data mount so a restore can't clobber the live world before it's
 * verified.
 */
const MIGRATE_MOUNT = "/kith-migrate";

/**
 * Container path the *new* local backup destination is mounted at
 * during a repository migration — the sidecar's own mounts still point
 * at the old destination.
 */
const NEW_REPO_MOUNT = "/kith-new-backups";

// #region Public API

/**
 * Whether backups are configured globally — ie. every server gets a
 * backup sidecar unless it opts out. Off when KITH_BASE_BACKUP_DEST is
 * unset.
 */
export function backupsGloballyEnabled(): boolean {
	return config.baseBackupDest !== undefined;
}

/**
 * The human-facing repository location for a server under the *current*
 * global config. `null` when backups aren't configured globally.
 */
export function repositoryDisplay(serverId: string): string | null {
	const dest = config.baseBackupDest;
	if (!dest) {
		return null;
	}
	return `${trimTrailingSlash(dest)}/${serverId}`;
}

/**
 * The repository a sidecar actually points at, derived from its own
 * compose definition rather than the global config — for a drifted
 * server this is where its backups *really* live. For a local repo the
 * in-container mount path is translated back to the host destination.
 */
export function repositoryDisplayFor(
	sidecar: ComposeServiceConfig,
	serverId: string,
): string {
	const repo = sidecar.environment?.RESTIC_REPOSITORY ?? "";
	if (repo.startsWith(`${LOCAL_BACKUPS_MOUNT}/`)) {
		const mount = sidecar.volumes?.find((v) =>
			v.endsWith(`:${LOCAL_BACKUPS_MOUNT}`),
		);
		// Strip "<colon>/backups" to get the host-side destination.
		const host = mount?.slice(0, mount.length - LOCAL_BACKUPS_MOUNT.length - 1);
		if (host) {
			return `${trimTrailingSlash(host)}/${serverId}`;
		}
	}
	return repo;
}

/**
 * The schedule the sidecar backs up on, shown on the backups screen.
 */
export function scheduleDisplay(): string {
	return config.backupCronSchedule ?? `every ${config.backupInterval}`;
}

/**
 * Builds the mc-backup sidecar service for a server's compose file.
 * The sidecar initializes the restic repository itself on its first
 * run, so "setting up backups" is just adding this service.
 *
 * @throws BackupsNotConfiguredError when backups aren't configured
 * globally (KITH_BASE_BACKUP_DEST unset).
 * @throws BackupPasswordNotConfiguredError when no backup password is
 * set (KITH_BACKUP_PASSWORD unset) — unreachable in the app itself,
 * where validateConfig fails at startup first.
 */
export function buildBackupServiceConfig(
	serverId: string,
): ComposeServiceConfig {
	const dest = config.baseBackupDest;
	if (!dest) {
		throw new BackupsNotConfiguredError();
	}
	const password = config.backupPassword;
	if (!password) {
		throw new BackupPasswordNotConfiguredError();
	}
	const remote = isRemoteBackupDest(dest);

	const environment: Record<string, string> = {
		RCON_HOST: MC_SERVICE_NAME,
		BACKUP_METHOD: "restic",
		RESTIC_REPOSITORY: remote
			? `${trimTrailingSlash(dest)}/${serverId}`
			: `${LOCAL_BACKUPS_MOUNT}/${serverId}`,
		RESTIC_PASSWORD: password,
		// The sidecar waits for mc to be healthy (depends_on below), so no
		// startup delay is needed.
		INITIAL_DELAY: "0",
	};
	if (config.backupCronSchedule) {
		// mc-backup's CRON_SCHEDULE overrides the interval-based triggers
		// (BACKUP_ON_STARTUP among them), so it's the only key to set.
		environment.CRON_SCHEDULE = config.backupCronSchedule;
	} else {
		environment.BACKUP_INTERVAL = config.backupInterval;
		// Backups run on the interval only — a startup backup would fire
		// on every server start, so frequently bounced servers would pile
		// up snapshots (and prune churn) far faster than the interval
		// intends. The first backup lands one interval after start.
		environment.BACKUP_ON_STARTUP = "false";
	}
	if (config.backupPruneRetention) {
		environment.PRUNE_RESTIC_RETENTION = config.backupPruneRetention;
	}
	// Credentials for remote restic backends (AWS, B2, Azure, GCS) — only
	// the ones actually set.
	for (const [key, value] of Object.entries(resticEnv)) {
		if (value !== undefined) {
			environment[key] = value;
		}
	}

	return {
		image: "itzg/mc-backup",
		pull_policy: "daily",
		// Restic ties snapshots and pruning to a hostname; pin it to the
		// server id so it stays stable across container recreations.
		hostname: serverId,
		// Run restic as the configured host identity so the local backup
		// repo it writes is owned uid:gid on the host (shared-group
		// installs), matching the mc container's data files. Skipped when
		// no real id is configured (non-POSIX host).
		...(config.uid >= 0 && config.gid >= 0
			? { user: `${config.uid}:${config.gid}` }
			: {}),
		depends_on: { [MC_SERVICE_NAME]: { condition: "service_healthy" } },
		environment,
		volumes: remote
			? [`./${DATA_DIR_NAME}:/data:ro`]
			: [`./${DATA_DIR_NAME}:/data:ro`, `${dest}:${LOCAL_BACKUPS_MOUNT}`],
	};
}

/**
 * Initializes the server's restic repository. The sidecar would do this
 * itself on its first run — this does it eagerly so a bad password or
 * unreachable backend surfaces when backups are set up, not hours later
 * in a sidecar log. A no-op when the repo already exists.
 *
 * Uses a throwaway `compose run` container, so it works whether the
 * server stack is running or not.
 *
 * @throws FailedToInitBackupRepoError when the repo can't be read or
 * initialized.
 */
export async function initRepository(serverId: string): Promise<void> {
	const dir = serverPath(serverId);
	const commandOptions = ["--rm", "--no-deps", "--entrypoint", "restic"];

	// `cat config` only succeeds against an existing, readable repo — a
	// failure is the expected "not initialized yet" answer, not an error.
	const existing = await ComposeService.run(
		BACKUP_SERVICE_NAME,
		"cat config",
		{ cwd: dir, commandOptions },
		{ expected: true },
	);
	if (existing) {
		return;
	}

	const result = await ComposeService.run(BACKUP_SERVICE_NAME, "init", {
		cwd: dir,
		commandOptions,
	});
	if (!result) {
		const err = new FailedToInitBackupRepoError(serverId);
		logger.error({ error: err }, err.message);
		throw err;
	}
	logger.info({ serverId }, "Initialized restic backup repository");
}

/**
 * Compares a server's existing backup sidecar against the current
 * global backup config, returning how they've drifted. `null` means no
 * drift (or no sidecar — nothing to reconcile). When backups are
 * disabled globally but the server still has a sidecar, returns a
 * `globalDisabled` drift instead: there's no global config to compare
 * against, so the user decides whether to keep or disable it.
 *
 * Password drift is reported only through `passwordChanged`, never by
 * value: kith shouldn't put a repo password on screen.
 */
export function detectDrift(
	sidecar: ComposeServiceConfig | undefined,
	serverId: string,
): BackupDrift | null {
	if (!sidecar) {
		return null;
	}

	// Backups disabled globally while this server still has a sidecar:
	// there's no global config to reconcile against, so this isn't field
	// drift — it's a decision the user has to make (keep the sidecar as
	// self-managed, or disable backups for the server).
	if (!backupsGloballyEnabled()) {
		return {
			fields: [],
			passwordChanged: false,
			actualRepository: repositoryDisplayFor(sidecar, serverId),
			globalDisabled: true,
		};
	}

	const fields: string[] = [];
	const expected = buildBackupServiceConfig(serverId);
	const env = sidecar.environment ?? {};
	const expectedEnv = expected.environment ?? {};

	// Compare effective, host-facing repository locations — for local
	// destinations the in-container RESTIC_REPOSITORY is identical
	// (/backups/<id>) no matter the host path, which only shows up in
	// the sidecar's volume mount.
	const actualRepo = repositoryDisplayFor(sidecar, serverId);
	if (actualRepo !== repositoryDisplay(serverId)) {
		fields.push("repository");
	}
	if (
		env.RESTIC_PASSWORD !== undefined &&
		env.RESTIC_PASSWORD !== expectedEnv.RESTIC_PASSWORD
	) {
		fields.push("password");
	}
	const actualSchedule = env.CRON_SCHEDULE ?? env.BACKUP_INTERVAL;
	const expectedSchedule =
		expectedEnv.CRON_SCHEDULE ?? expectedEnv.BACKUP_INTERVAL;
	if (actualSchedule !== expectedSchedule) {
		fields.push("schedule");
	}
	// Older sidecars backed up on every server start (mc-backup's
	// BACKUP_ON_STARTUP default). Only interval-scheduled sidecars carry
	// the opt-out — cron ignores it — so an unset key on one is drift.
	if (
		!env.CRON_SCHEDULE &&
		env.BACKUP_ON_STARTUP !== expectedEnv.BACKUP_ON_STARTUP
	) {
		fields.push("startup backup");
	}
	if (env.PRUNE_RESTIC_RETENTION !== expectedEnv.PRUNE_RESTIC_RETENTION) {
		fields.push("retention policy");
	}
	// The sidecar may carry credential keys the global config no longer
	// sets — a removed credential is drift too, so compare the union of
	// keys from both environments.
	const credentialKeys = new Set([
		...Object.keys(env),
		...Object.keys(expectedEnv),
	]);
	for (const key of credentialKeys) {
		if (resticEnvKeys.includes(key) && env[key] !== expectedEnv[key]) {
			fields.push("credentials");
			break;
		}
	}

	if (fields.length === 0) {
		return null;
	}
	return {
		fields,
		passwordChanged: fields.includes("password"),
		actualRepository: fields.includes("repository") ? actualRepo : undefined,
		globalDisabled: false,
	};
}

/**
 * Reconciles a server's existing restic repository with the current
 * global backup config, preserving backup history:
 *
 * - Same repo, new password → `restic key passwd` re-encrypts the repo
 *   key with the global password. All snapshots survive.
 * - New repo location → the new repo is initialized and `restic copy`
 *   moves the full snapshot history over (it handles the two passwords
 *   natively). The old repo is left untouched.
 *
 * Only the drifted sidecar's own env and the global env are involved —
 * the compose file is rewritten by the caller *after* this succeeds, so
 * a failure leaves the server exactly as it was.
 *
 * @throws BackupCredentialMigrationUnsupportedError when the repo
 * moved *and* its backend credentials changed — restic can only
 * authenticate to one backend per command, so the copy can't be done
 * automatically.
 * @throws FailedToMigrateBackupRepoError when the repo can't be
 * reconciled (unreachable backend, wrong old password, …).
 */
export async function migrateToGlobalConfig(
	serverId: string,
	oldSidecar: ComposeServiceConfig,
): Promise<void> {
	const dir = serverPath(serverId);
	const oldEnvironment = oldSidecar.environment ?? {};
	const newEnvironment = buildBackupServiceConfig(serverId).environment ?? {};

	// Compare effective, host-facing repository locations — for local
	// destinations the in-container RESTIC_REPOSITORY is identical
	// (/backups/<id>) no matter the host path (see detectDrift).
	const repoChanged =
		repositoryDisplayFor(oldSidecar, serverId) !== repositoryDisplay(serverId);
	const passwordChanged =
		oldEnvironment.RESTIC_PASSWORD !== newEnvironment.RESTIC_PASSWORD;
	if (!repoChanged && !passwordChanged) {
		return;
	}

	// restic authenticates to one backend per command, but a repo move
	// with changed backend credentials would need both the old and new
	// sets at once (env vars can't hold two values for the same key).
	// Refuse up front with a manual escape hatch rather than failing
	// halfway through with a misleading error. The old sidecar may
	// carry credential keys the new config no longer sets, so compare
	// the union of keys from both environments.
	if (repoChanged) {
		const credentialsChanged = [
			...new Set([
				...Object.keys(oldEnvironment),
				...Object.keys(newEnvironment),
			]),
		].some(
			(key) =>
				resticEnvKeys.includes(key) &&
				oldEnvironment[key] !== newEnvironment[key],
		);
		if (credentialsChanged) {
			const err = new BackupCredentialMigrationUnsupportedError(serverId);
			logger.error({ error: err }, err.message);
			throw err;
		}
	}

	// When the repository moved to a new local destination, that
	// destination isn't reachable through the sidecar's own volume
	// mounts (they point at the old one), so it's mounted separately
	// and the new repo addressed through it.
	const dest = config.baseBackupDest ?? "";
	const newRepoIsLocal = repoChanged && !isRemoteBackupDest(dest);
	const newRepoInContainer = newRepoIsLocal
		? `${NEW_REPO_MOUNT}/${serverId}`
		: (newEnvironment.RESTIC_REPOSITORY ?? "");

	// Passwords are also staged as files in a host-side scratch dir for
	// the restic flags that take password files (--from-password-file,
	// --new-password-file). The scripts still read them from env (the
	// OLD_/NEW_ vars passed to `compose run`), so they remain visible in
	// `ps` and the run container's config for the duration of the
	// migration — acceptable here because the compose file already holds
	// the same secrets persistently (see README's Security section).
	const scratch = path.join(config.tmpFileDir, `migrate-${serverId}`);
	await fs.rm(scratch, { recursive: true, force: true });
	await makeDir(scratch);
	await writeFile(
		path.join(scratch, "old-password"),
		oldEnvironment.RESTIC_PASSWORD ?? "",
		{ secret: true },
	);
	await writeFile(
		path.join(scratch, "new-password"),
		newEnvironment.RESTIC_PASSWORD ?? "",
		{ secret: true },
	);

	// Each restic invocation needs its backend credentials (AWS keys, …)
	// unprefixed; both configs are injected with OLD_/NEW_ prefixes and
	// the script re-exports the set it needs per phase.
	const credentialExports = (
		environment: Record<string, string>,
		prefix: string,
	) =>
		Object.keys(environment)
			.filter((k) => k !== "RESTIC_REPOSITORY" && k !== "RESTIC_PASSWORD")
			.map((k) => `export ${k}="$${prefix}${k}"`)
			.join("\n");

	// Both scripts probe the repo with `cat config` and branch on
	// restic's exit codes: 10 (repository does not exist) means there's
	// nothing to preserve, so the step is skipped; any other failure
	// (wrong password, unreachable backend, …) aborts the migration so
	// the compose file is left unchanged rather than pointing at a repo
	// nothing can read.
	const script = repoChanged
		? // New location: init the new repo, then copy the history over.
			// NEW_REPO is the new repo's in-container path, which differs
			// from the sidecar env's RESTIC_REPOSITORY for local
			// destinations (see above).
			`
set -eu
export RESTIC_REPOSITORY="$NEW_REPO"
export RESTIC_PASSWORD="$NEW_RESTIC_PASSWORD"
${credentialExports(newEnvironment, "NEW_")}
restic cat config >/dev/null 2>&1 || restic init
rc=0
RESTIC_PASSWORD="$OLD_RESTIC_PASSWORD" restic -r "$OLD_RESTIC_REPOSITORY" cat config >/dev/null 2>&1 || rc=$?
if [ "$rc" = "0" ]; then
	restic copy --from-repo "$OLD_RESTIC_REPOSITORY" --from-password-file "${MIGRATE_MOUNT}/old-password"
elif [ "$rc" != "10" ]; then
	echo "the old repository exists but could not be opened with the sidecar's stored credentials" >&2
	exit 1
fi
`.trim()
		: // Same repo, new password: re-key in place, keeping every
			// snapshot.
			`
set -eu
export RESTIC_REPOSITORY="$OLD_RESTIC_REPOSITORY"
export RESTIC_PASSWORD="$OLD_RESTIC_PASSWORD"
${credentialExports(oldEnvironment, "OLD_")}
rc=0
restic cat config >/dev/null 2>&1 || rc=$?
if [ "$rc" = "0" ]; then
	restic key passwd --new-password-file "${MIGRATE_MOUNT}/new-password"
elif [ "$rc" != "10" ]; then
	echo "the repository exists but could not be opened with the sidecar's stored credentials" >&2
	exit 1
fi
`.trim();

	const envFlags = [
		...Object.entries(oldEnvironment).flatMap(([k, v]) => [
			"-e",
			`OLD_${k}=${v}`,
		]),
		...Object.entries(newEnvironment).flatMap(([k, v]) => [
			"-e",
			`NEW_${k}=${v}`,
		]),
		"-e",
		`NEW_REPO=${newRepoInContainer}`,
	];

	try {
		const result = await ComposeService.run(
			BACKUP_SERVICE_NAME,
			["-c", script],
			{
				cwd: dir,
				commandOptions: [
					"--rm",
					"--no-deps",
					"--entrypoint",
					"sh",
					"--volume",
					`${scratch}:${MIGRATE_MOUNT}`,
					...(newRepoIsLocal ? ["--volume", `${dest}:${NEW_REPO_MOUNT}`] : []),
					...envFlags,
				],
			},
		);
		if (!result) {
			throw new FailedToMigrateBackupRepoError(serverId);
		}
	} catch (err) {
		const migrationErr =
			err instanceof FailedToMigrateBackupRepoError
				? err
				: new FailedToMigrateBackupRepoError(serverId, { cause: err });
		logger.error({ error: migrationErr }, migrationErr.message);
		throw migrationErr;
	} finally {
		await fs.rm(scratch, { recursive: true, force: true });
	}
	logger.info({ serverId }, "Migrated backups to the global config");
}

/**
 * Lists the snapshots in the server's restic repository, oldest first
 * (restic's own ordering).
 *
 * Works whether the server stack is running or not: a running sidecar
 * is exec'd into, otherwise a throwaway container runs restic with the
 * same environment. A missing or uninitialized repository reads as an
 * empty list — that's the normal state before the first backup.
 *
 * @throws FailedToListSnapshotsError when the repository exists but
 * can't be read (wrong password after a config change, unreachable
 * backend, docker down, …) — anything that would also make restores
 * fail, so the UI must not render it as "no snapshots yet".
 */
export async function listSnapshots(
	serverId: string,
): Promise<BackupSnapshot[]> {
	const dir = serverPath(serverId);
	const running = await isBackupContainerRunning(dir);
	const result = running
		? await ComposeService.exec(
				BACKUP_SERVICE_NAME,
				"restic snapshots --json",
				{ cwd: dir },
			)
		: await ComposeService.run(BACKUP_SERVICE_NAME, "snapshots --json", {
				cwd: dir,
				commandOptions: ["--rm", "--no-deps", "--entrypoint", "restic"],
			});

	if (!result) {
		const err = new FailedToListSnapshotsError(serverId);
		logger.error({ error: err, serverId }, err.message);
		throw err;
	}

	const out = result.out.trim();
	// restic prints a plain-text "no repository" notice (and exits
	// non-zero) when the repo hasn't been initialized — that's the
	// normal state before the first backup, not an error.
	if (!out || out.includes("unable to open repo")) {
		return [];
	}

	try {
		return z.array(resticSnapshotSchema).parse(JSON.parse(out));
	} catch (err) {
		// restic succeeded (exit 0) but its output didn't parse — the
		// repo was read, so "empty" would be a lie.
		const listErr = new FailedToListSnapshotsError(serverId, {
			cause: err,
		});
		logger.error(
			{ error: listErr, serverId },
			"Unexpected response from restic snapshots",
		);
		throw listErr;
	}
}

/**
 * Takes an immediate snapshot of the server's data directory. Works
 * whether the server is running or not:
 *
 * - Sidecar running → `backup now` is exec'd into it, so the backup
 *   gets the RCON save-off/save-on flush around it.
 * - Whole stack stopped → a one-off `restic backup /data` in a
 *   throwaway container. No flush needed — the data is quiescent.
 *   Only manual backups work this way; the scheduled ones still live
 *   and die with the sidecar.
 *
 * Blocks until the backup finishes, which can take a while for large
 * worlds.
 *
 * @throws BackupSidecarNotRunningError when the server is running but
 * its sidecar isn't — backing up then would skip the save-off flush
 * and could capture a half-written world.
 * @throws FailedToRunBackupError when the backup itself fails.
 */
export async function backupNow(serverId: string): Promise<void> {
	const dir = serverPath(serverId);

	if (await isBackupContainerRunning(dir)) {
		const result = await ComposeService.exec(
			BACKUP_SERVICE_NAME,
			"backup now",
			{ cwd: dir },
		);
		if (!result) {
			const err = new FailedToRunBackupError(serverId);
			logger.error({ error: err }, err.message);
			throw err;
		}
		return;
	}

	const running = await ComposeService.ps({
		cwd: dir,
		commandOptions: ["--status", "running"],
	});
	if ((running?.data?.services.length ?? 0) > 0) {
		const err = new BackupSidecarNotRunningError(serverId);
		logger.error({ error: err }, err.message);
		throw err;
	}

	// The same restic invocation the sidecar's backup loop runs; the
	// throwaway container inherits the sidecar's environment (repo,
	// password, credentials) and pinned hostname, so the snapshot is
	// indistinguishable from a scheduled one.
	const result = await ComposeService.run(BACKUP_SERVICE_NAME, "backup /data", {
		cwd: dir,
		commandOptions: ["--rm", "--no-deps", "--entrypoint", "restic"],
	});
	if (!result) {
		const err = new FailedToRunBackupError(serverId);
		logger.error({ error: err }, err.message);
		throw err;
	}
}

/**
 * Restores a snapshot over the server's data directory. The whole
 * stack must be stopped first — restoring under a running server
 * would corrupt the world it's writing.
 *
 * After the restore the directory contains exactly what the snapshot
 * contains — `--delete` removes anything not in it. A merge-restore
 * (overwriting only the files the snapshot knows about) breaks
 * world/player consistency whenever the world grew after the
 * snapshot: a region file created after the backup would keep a
 * placed block while the player's inventory rolls back.
 *
 * A bogus or pruned snapshot id fails before restic touches the
 * target, so the data dir is left intact.
 *
 * The restore can't go through `compose run` — the sidecar mounts the
 * data dir read-only and a `--volume` override doesn't take precedence
 * over the service's own mount — so it runs as a raw `docker run`
 * modeled on the sidecar: same image, same environment, but the data
 * dir mounted writable. Snapshots store absolute `/data/...` paths, so
 * `--target /` puts every file back where it came from.
 *
 * @throws RestoreRequiresStoppedServerError when any of the server's
 * containers are running.
 * @throws BackupsNotConfiguredError when the server has no backup
 * sidecar.
 * @throws FailedToRestoreBackupError when the restore itself fails —
 * possibly partway through, leaving the data directory mixed.
 */
export async function restoreSnapshot(
	serverId: string,
	snapshotId: string,
): Promise<void> {
	const dir = serverPath(serverId);

	const running = await ComposeService.ps({
		cwd: dir,
		commandOptions: ["--status", "running"],
	});
	if ((running?.data?.services.length ?? 0) > 0) {
		throw new RestoreRequiresStoppedServerError(serverId);
	}

	const composeConfig = await ComposeService.loadComposeConfig(dir);
	const sidecar = composeConfig.services[BACKUP_SERVICE_NAME];
	if (!sidecar) {
		throw new BackupsNotConfiguredError();
	}
	const environment = sidecar.environment ?? {};

	const dataDir = path.join(dir, DATA_DIR_NAME);
	await makeDir(dataDir);

	const args = [
		"run",
		"--rm",
		"--entrypoint",
		"restic",
		"--volume",
		`${dataDir}:/data`,
	];
	// A local repository is only reachable through its host mount —
	// the sidecar addresses it as /backups/<id>, so the destination is
	// mounted at the same container path here.
	const repo = environment.RESTIC_REPOSITORY ?? "";
	if (repo.startsWith(`${LOCAL_BACKUPS_MOUNT}/`)) {
		const mount = sidecar.volumes?.find((v) =>
			v.endsWith(`:${LOCAL_BACKUPS_MOUNT}`),
		);
		const host = mount?.slice(0, mount.length - LOCAL_BACKUPS_MOUNT.length - 1);
		if (host) {
			args.push("--volume", `${host}:${LOCAL_BACKUPS_MOUNT}`);
		}
	}
	for (const [key, value] of Object.entries(environment)) {
		args.push("-e", `${key}=${value}`);
	}
	// --delete removes anything in the target that isn't in the
	// snapshot, so the directory ends up exactly matching it. restic
	// refuses --delete with a bare target as a safety rail, so the
	// include filter scopes it to the data mount (every snapshot path
	// is /data/...).
	args.push(
		sidecar.image ?? "itzg/mc-backup",
		"restore",
		snapshotId,
		"--target",
		"/",
		"--delete",
		"--include",
		"/data/**",
	);

	const proc = spawn("docker", args, {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [exitCode, stderr] = await Promise.all([
		new Promise<number>((resolve) => {
			proc.once("close", (code) => resolve(code ?? 1));
		}),
		proc.stderr ? text(proc.stderr) : Promise.resolve(""),
	]);
	if (exitCode !== 0) {
		const err = new FailedToRestoreBackupError(serverId, snapshotId, {
			cause: new Error(stderr.trim()),
		});
		logger.error({ error: err, serverId, snapshotId }, err.message);
		throw err;
	}
	logger.info({ serverId, snapshotId }, "Restored backup snapshot");
}

// #endregion Public API

// #region Private Helpers

function trimTrailingSlash(dest: string): string {
	return dest.replace(/\/+$/, "");
}

/**
 * Whether the server's backup sidecar container is currently running.
 * Never throws — the compose wrapper swallows docker failures (logged
 * there), and a failed `ps` reads as "not running".
 */
async function isBackupContainerRunning(dir: string): Promise<boolean> {
	const result = await ComposeService.ps({
		cwd: dir,
		commandOptions: ["--status", "running", BACKUP_SERVICE_NAME],
	});
	return (result?.data?.services.length ?? 0) > 0;
}

// #endregion Private Helpers
