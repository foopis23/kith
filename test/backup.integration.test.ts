/**
 * Integration tests for the backup lifecycle. These run against real
 * docker: they create a server, snapshot its data directory, mutate
 * files, restore, and compare checksums. They need docker running and
 * pull the itzg/mc-backup image on first run.
 *
 * Run with: bun run test:integration
 *
 * Skipped by default (see the KITH_INTEGRATION_TEST gate below) so plain
 * `bun test` stays hermetic.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import * as BackupService from "../src/services/backup.service";
import * as ServerService from "../src/services/server.service";

// These tests shell out to docker and mutate real containers, so they
// only run when explicitly requested.
const RUN = process.env.KITH_INTEGRATION_TEST === "1";
const dockerTest = RUN ? test : test.skip;

/** Long timeout — image pulls and restic operations are slow. */
const TIMEOUT = 180_000;

let serverId: string;
let serverDir: string;
let dataDir: string;

/** sha256 of every file under dir, keyed by relative path. */
async function checksumTree(dir: string): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			for (const [k, v] of await checksumTree(full)) {
				result.set(path.join(entry.name, k), v);
			}
		} else {
			const content = await fs.readFile(full);
			result.set(
				entry.name,
				createHash("sha256").update(content).digest("hex"),
			);
		}
	}
	return result;
}

function dataFile(...parts: string[]) {
	return path.join(dataDir, ...parts);
}

afterAll(async () => {
	if (!RUN) return;
	await cleanupContainers();
	const workDir = process.env.KITH_BACKUP_TEST_WORKDIR;
	if (workDir) {
		await fs.rm(workDir, { recursive: true, force: true });
	}
}, TIMEOUT);

/** Waits for a spawned process to exit. */
function exited(proc: ReturnType<typeof spawn>): Promise<number> {
	return new Promise((resolve) => {
		proc.once("close", (code) => resolve(code ?? 0));
	});
}

/**
 * Removes every container belonging to the test server. Detached
 * `compose run` containers aren't part of the compose project, so
 * `compose down` alone doesn't catch them — they're named
 * `<serverId>-<service>-run-<hash>`, so they're matched by prefix.
 */
async function cleanupContainers() {
	if (serverDir) {
		const down = spawn(
			"docker",
			["compose", "down", "-t", "1", "--remove-orphans"],
			{ cwd: serverDir, stdio: "ignore" },
		);
		await exited(down);
	}
	if (serverId) {
		const ps = spawn("docker", ["ps", "-aq", "--filter", `name=${serverId}`], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		const [output] = await Promise.all([
			ps.stdout ? text(ps.stdout) : Promise.resolve(""),
			exited(ps),
		]);
		const ids = output.trim().split("\n").filter(Boolean);
		if (ids.length > 0) {
			const rm = spawn("docker", ["rm", "-f", ...ids], {
				stdio: "ignore",
			});
			await exited(rm);
		}
	}
}

/** Asserts the data dir matches a fingerprint exactly. */
async function expectDataDirToMatch(before: Map<string, string>) {
	const after = await checksumTree(dataDir);
	expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
	for (const [file, hash] of before) {
		expect(after.get(file)).toBe(hash);
	}
}

describe("backup lifecycle", () => {
	dockerTest(
		"creates a server with backups and takes a snapshot",
		async () => {
			const server = await ServerService.createVanillaServer({
				label: "backup-test",
				version: "1.21.1",
				memory: "1G",
				type: "VANILLA",
			});
			serverId = server.id;
			serverDir = server.dir;
			dataDir = path.join(serverDir, "data");

			// Seed a world-ish tree: nested dirs, a couple of files.
			await fs.mkdir(dataFile("world", "region"), { recursive: true });
			await fs.writeFile(
				dataFile("world", "region", "r.0.0.mca"),
				"region-origin",
			);
			await fs.writeFile(dataFile("player.dat"), "inventory-v1");
			await fs.writeFile(dataFile("server.properties"), "motd=hello");

			await BackupService.backupNow(serverId);
			const snapshots = await BackupService.listSnapshots(serverId);
			expect(snapshots.length).toBe(1);
		},
		TIMEOUT,
	);

	dockerTest(
		"restores modified, deleted, and added files to exact pre-backup state",
		async () => {
			const before = await checksumTree(dataDir);

			// Mutate: modify one file, delete one, add one, add a nested one.
			await fs.writeFile(dataFile("player.dat"), "inventory-v2-CHANGED");
			await fs.rm(dataFile("server.properties"));
			await fs.writeFile(
				dataFile("world", "region", "r.1.2.mca"),
				"new-region-after-backup",
			);
			await fs.writeFile(dataFile("junk.log"), "not in snapshot");

			const snapshots = await BackupService.listSnapshots(serverId);
			const snapshot = snapshots[0];
			expect(snapshot).toBeDefined();
			await BackupService.restoreSnapshot(serverId, snapshot?.id as string);

			// Same set of files, same contents — nothing more, nothing less.
			await expectDataDirToMatch(before);
		},
		TIMEOUT,
	);

	dockerTest(
		"takes an offline backup while the stack is stopped",
		async () => {
			// The stack was never started, so this exercises the one-off
			// container path rather than exec into a running sidecar.
			await fs.writeFile(dataFile("offline.txt"), "offline-backup-content");
			await BackupService.backupNow(serverId);
			const snapshots = await BackupService.listSnapshots(serverId);
			expect(snapshots.length).toBe(2);
		},
		TIMEOUT,
	);

	dockerTest(
		"restoring the offline snapshot includes the new file",
		async () => {
			const before = await checksumTree(dataDir);
			const snapshots = await BackupService.listSnapshots(serverId);
			// Newest snapshot (restic lists oldest first).
			const latest = snapshots[snapshots.length - 1];
			expect(latest).toBeDefined();
			await BackupService.restoreSnapshot(serverId, latest?.id as string);
			await expectDataDirToMatch(before);
		},
		TIMEOUT,
	);

	dockerTest(
		"blocks restore while the stack is running",
		async () => {
			// Stand in for a running stack: a detached sleeper as the mc service.
			const up = spawn(
				"docker",
				[
					"compose",
					"run",
					"-d",
					"--no-deps",
					"--entrypoint",
					"sh",
					"mc",
					"-c",
					"sleep 60",
				],
				{ cwd: serverDir, stdio: "ignore" },
			);
			await exited(up);
			await new Promise((r) => setTimeout(r, 2000));

			const snapshots = await BackupService.listSnapshots(serverId);
			const snapshot = snapshots[0];
			expect(snapshot).toBeDefined();
			await expect(
				BackupService.restoreSnapshot(serverId, snapshot?.id as string),
			).rejects.toThrow("must be stopped");

			await cleanupContainers();
		},
		TIMEOUT,
	);

	dockerTest(
		"fails cleanly on a bogus snapshot id without touching the data dir",
		async () => {
			const before = await checksumTree(dataDir);
			await expect(
				BackupService.restoreSnapshot(serverId, "deadbeefdeadbeef"),
			).rejects.toThrow("Failed to restore");
			await expectDataDirToMatch(before);
		},
		TIMEOUT,
	);
});
