import fsSync from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Single-instance lock so only one kith process manages a serversDir at
 * a time. Two users (or two terminals) running kith against the same
 * shared directory would otherwise race on compose rewrites, port
 * allocation, and server id generation.
 *
 * The lock is a file created with O_EXCL (atomic create-or-fail)
 * holding the owner's PID. A stale lock — owner PID no longer alive —
 * is reclaimed, so a crashed kith doesn't lock everyone out until the
 * file is removed by hand. Released on exit; SIGINT/SIGTERM also
 * release so Ctrl-C and `kill` don't leave it behind.
 */

const LOCK_FILE_NAME = ".kith.lock";

function lockPath(): string {
	return path.join(config.serversDir, LOCK_FILE_NAME);
}

function isProcessAlive(pid: number): boolean {
	try {
		// Signal 0 probes existence without delivering a signal.
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// EPERM means the process exists but is owned by another user —
		// still alive, still holding the lock.
		return code === "EPERM";
	}
}

function readLockPid(file: string): number | undefined {
	try {
		const raw = fsSync.readFileSync(file, "utf-8").trim();
		const pid = Number.parseInt(raw, 10);
		return Number.isNaN(pid) ? undefined : pid;
	} catch {
		return undefined;
	}
}

function release(): void {
	try {
		fsSync.rmSync(lockPath(), { force: true });
	} catch {
		// Best-effort — a leftover is reclaimed as stale next start.
	}
}

/**
 * Acquires the single-instance lock or exits with an actionable
 * message. Call once at startup, after validateConfig has ensured the
 * serversDir exists.
 */
export function acquireInstanceLock(): void {
	const file = lockPath();

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fsSync.writeFileSync(file, `${process.pid}\n`, { flag: "wx" });
			// Group-readable/writable regardless of umask, so other group
			// members can check the holder and reclaim a stale lock.
			try {
				fsSync.chmodSync(file, 0o660);
			} catch {
				// Best-effort — a stricter mode only means others can't
				// inspect the lock; the message tells them how to clear it.
			}
			// Acquired. Release on the ways the process normally ends.
			process.on("exit", release);
			process.on("SIGINT", () => process.exit(130));
			process.on("SIGTERM", () => process.exit(143));
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				process.stderr.write(
					`kith: cannot create instance lock "${file}": ${code ?? "unknown error"}.\n`,
				);
				process.exit(1);
			}

			// Locked. Reclaim if the holder is gone, else report and exit.
			const holderPid = readLockPid(file);
			if (holderPid !== undefined && !isProcessAlive(holderPid)) {
				release();
				continue; // retry the acquire once
			}

			const holder = holderPid ? ` (pid ${holderPid})` : "";
			process.stderr.write(
				`kith: another instance is already managing "${config.serversDir}"${holder}.\n` +
					`Close it first. If it crashed, remove "${file}".\n`,
			);
			process.exit(1);
		}
	}

	// Lost a reclaim race — someone else grabbed it between our check
	// and our create.
	process.stderr.write(
		`kith: another instance is already managing "${config.serversDir}".\n`,
	);
	process.exit(1);
}
