/**
 * Preloaded before any test module runs (bun --preload). Sets the env
 * config to a throwaway work dir so the integration tests never touch
 * real server data. No-ops unless KITH_INTEGRATION_TEST=1 — the same
 * flag that un-skips the integration tests, so they can never run
 * against the real config.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.env.KITH_INTEGRATION_TEST === "1") {
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "kith-backup-test-"));
	process.env.KITH_BACKUP_TEST_WORKDIR = workDir;
	process.env.KITH_SERVERS_DIR = path.join(workDir, "servers");
	process.env.KITH_LOG_DIR = path.join(workDir, "logs");
	process.env.KITH_TMP_FILE_DIR = path.join(workDir, "tmp");
	process.env.KITH_BASE_BACKUP_DEST = path.join(workDir, "backups");
	process.env.KITH_BACKUP_PASSWORD = "integration-test-password";
}
