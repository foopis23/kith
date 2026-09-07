import fsSync from "node:fs";
import fs from "node:fs/promises";
import { config } from "./config.js";

/**
 * Centralized creation of every file and directory kith owns, so
 * ownership and permissions are applied consistently.
 *
 * The model for a shared multi-user install:
 *  - directories are created setgid (0o2770) so the shared group
 *    propagates to anything created inside them later — by kith, by a
 *    container through a bind mount, or by a user by hand;
 *  - files are group-accessible (0o660 data; secret-bearing files use
 *    config.secretFileMode, group-writable by default);
 *  - everything is chowned to config.uid:config.gid.
 *
 * chown to a foreign uid/gid needs privileges (root or CAP_CHOWN). When
 * kith runs unprivileged and the target ownership differs from the
 * invoking user, the chown fails with EPERM; that's tolerated so a
 * single-user install (where the defaults already match) never trips
 * on it, and a misconfigured shared install still functions for the
 * owning user while surfacing a warning rather than crashing.
 */

/** True when a real uid/gid is configured (POSIX). -1 means "skip chown". */
function ownershipEnabled(): boolean {
	return config.uid >= 0 && config.gid >= 0;
}

/** Directory mode: rwxrws--- — setgid so the group is inherited. */
const DIR_MODE = 0o2770;
/** Regular data file: rw-rw---- */
const FILE_MODE = 0o660;

/**
 * chmod/chown both require ownership of the target. In a shared install
 * a second group member can write into a dir (group-rw) without owning
 * it, so both can fail with EPERM even in a healthy setup. Tolerate
 * that: the file stays accessible via the group bits it already has.
 */
function isToleratedPermError(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException).code;
	return code === "EPERM" || code === "EINVAL" || code === "ENOENT";
}

async function applyMode(target: string, mode: number): Promise<void> {
	try {
		await fs.chmod(target, mode);
	} catch (err) {
		if (!isToleratedPermError(err)) throw err;
	}
}

async function applyOwnership(target: string): Promise<void> {
	if (!ownershipEnabled()) return;
	try {
		await fs.chown(target, config.uid, config.gid);
	} catch (err) {
		if (!isToleratedPermError(err)) throw err;
	}
}
/** Creates a directory (recursive) and applies setgid + ownership. */
export async function makeDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
	// chown before chmod: chown clears the setgid bit (POSIX security
	// behavior), so the mode must be applied last to stick. mkdir's mode
	// only applies to the leaf it actually creates anyway — an existing
	// dir or a recursive parent keeps its old mode.
	await applyOwnership(dir);
	await applyMode(dir, DIR_MODE);
}

export type WriteFileOptions = {
	/** Secret-bearing files use config.secretFileMode (KITH_SECRET_FILE_MODE). */
	secret?: boolean;
	/** Passed through to fs.writeFile (e.g. { flag: "wx" } for create-only). */
	flag?: string;
};

/**
 * Writes a file and applies ownership + group permissions. Honors an
 * exclusive flag by only chowning/chmoding when the write actually
 * created the file (a pre-existing file keeps its content and owner).
 */
export async function writeFile(
	filePath: string,
	content: string,
	options: WriteFileOptions = {},
): Promise<void> {
	const mode = options.secret ? config.secretFileMode : FILE_MODE;
	await fs.writeFile(filePath, content, {
		mode,
		...(options.flag ? { flag: options.flag } : {}),
	});
	// chown before chmod — chown can strip mode bits.
	await applyOwnership(filePath);
	await applyMode(filePath, mode);
}

/**
 * Sync variant of makeDir for startup paths (validateConfig, the
 * logger) that run before the event loop is doing useful work.
 */
export function makeDirSync(dir: string): void {
	fsSync.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	// chown before chmod — chown clears the setgid bit.
	if (ownershipEnabled()) {
		try {
			fsSync.chownSync(dir, config.uid, config.gid);
		} catch (err) {
			if (!isToleratedPermError(err)) throw err;
		}
	}
	try {
		fsSync.chmodSync(dir, DIR_MODE);
	} catch (err) {
		if (!isToleratedPermError(err)) throw err;
	}
}
