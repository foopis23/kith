import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../lib/config.js";
import { logger as globalLogger } from "../lib/logger.js";
import {
	savedVanillaVersionsSchema,
	type VanillaVersions,
	vanillaVersionsSchema,
} from "../models/vanilla.model.js";

const logger = globalLogger.child({ service: "version.service.ts" });
const cacheDuration = 1000 * 60 * 60; // 1 hour in milliseconds
const cacheFilePath = path.resolve(config.cacheDir, "version_manifest_v2.json");

//#region Public API
export async function getVanillaVersions(
	filters: { snapshots?: boolean; alphas?: boolean; betas?: boolean } = {},
): Promise<VanillaVersions> {
	const { snapshots = false, alphas = false, betas = false } = filters;

	let versions: VanillaVersions | null = await readCachedVanillaVersions();
	if (versions === null) {
		versions = await fetchVanillaVersions();
	}

	versions.versions = versions.versions.filter((version) => {
		if (version.type === "snapshot" && !snapshots) return false;
		if (version.type === "old_alpha" && !alphas) return false;
		if (version.type === "old_beta" && !betas) return false;
		return true;
	});

	return versions;
}
//#endregion

//#region Private Helpers
async function fetchVanillaVersions(): Promise<VanillaVersions> {
	const result = await fetch(
		"https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
		{
			method: "GET",
			headers: {
				"Content-Type": "application/json",
			},
		},
	);
	const json = await result.json();
	const validated = vanillaVersionsSchema.parse(json);

	try {
		await createCacheDir();
		await fs.writeFile(
			cacheFilePath,
			JSON.stringify({
				...validated,
				cachedAt: new Date().toISOString(),
			}),
			"utf-8",
		);
	} catch (error) {
		logger.error({ error }, "Failed to write cached vanilla versions");
	}

	return validated;
}

async function readCachedVanillaVersions() {
	try {
		const fileContent = await fs.readFile(cacheFilePath, "utf-8");
		const json = JSON.parse(fileContent);
		const validated = savedVanillaVersionsSchema.parse(json);
		if (Date.now() - new Date(validated.cachedAt).getTime() > cacheDuration) {
			return null;
		}
		return validated;
	} catch {
		return null;
	}
}

async function createCacheDir() {
	if (!(await fs.stat(config.cacheDir).catch(() => false))) {
		await fs.mkdir(config.cacheDir, { recursive: true });
	}
}

//#endregion
