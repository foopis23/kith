/**
 * Preloaded before any test module runs (bunfig's test preload, plus
 * the explicit --preload in the integration script). Points the env
 * config at a throwaway work dir so tests never touch real server
 * data. This matters even for unit runs: the dev shell may export
 * KITH_* vars, and test files share one module registry, so whichever
 * file imports the config first would otherwise pin it to the real
 * environment for the whole run.
 *
 * The integration branch (KITH_INTEGRATION_TEST=1 — the same flag that
 * un-skips the integration tests) adds the backup config those tests
 * need, so they can never run against the real config either.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Both preloads run this file; only the first wins.
if (!process.env.KITH_TEST_WORKDIR) {
	const integration = process.env.KITH_INTEGRATION_TEST === "1";
	const workDir = fs.mkdtempSync(
		path.join(os.tmpdir(), integration ? "kith-backup-test-" : "kith-test-"),
	);
	// Remove the work dir when the test process exits, pass or fail, so
	// plain `bun test` runs don't leak compose fixtures and archived
	// server data under the system temp dir. (The integration suite
	// also removes its own dir in afterAll; force makes the second
	// removal a no-op.)
	process.on("exit", () => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});
	process.env.KITH_TEST_WORKDIR = workDir;
	process.env.KITH_SERVERS_DIR = path.join(workDir, "servers");
	process.env.KITH_LOG_DIR = path.join(workDir, "logs");
	process.env.KITH_TMP_FILE_DIR = path.join(workDir, "tmp");
	process.env.KITH_CACHE_DIR = path.join(workDir, "cache");

	if (integration) {
		process.env.KITH_BACKUP_TEST_WORKDIR = workDir;
		process.env.KITH_BASE_BACKUP_DEST = path.join(workDir, "backups");
		process.env.KITH_BACKUP_PASSWORD = "integration-test-password";
	} else {
		// A narrow range of ports nothing real listens on, so port
		// assignment tests don't depend on the machine's 25565 being free.
		process.env.KITH_PORT_RANGE = "39991-39993";
	}
}
