import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../lib/config.js";
import { logger as globalLogger } from "../lib/logger.js";
import {
	dockerHubTagsPageSchema,
	JAVA_IMAGE_VARIANTS,
	type JavaImageTagsCache,
	type JavaVersionCache,
	javaImageTag,
	javaImageTagsCacheSchema,
	javaVersionCacheSchema,
	SUPPORTED_JAVA_MAJORS,
	versionDetailSchema,
} from "../models/java.model.js";
import * as ModrinthService from "./modrinth.service.js";
import * as VanillaService from "./vanilla.service.js";

const logger = globalLogger.child({ service: "java.service.ts" });
const cacheFilePath = path.resolve(config.cacheDir, "java_versions.json");
const imageTagsCacheFilePath = path.resolve(
	config.cacheDir,
	"java_image_tags.json",
);

/** How long fetched image tags are reused before Docker Hub is re-queried. */
const IMAGE_TAGS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// #region Public API

/**
 * Determines the itzg/minecraft-server image tag whose Java version can
 * run the given Minecraft version (ie. "1.20.6" -> "java21").
 *
 * The requirement comes from Mojang's version metadata and is cached on
 * disk. When Mojang can't be reached, a hardcoded table covers known
 * versions; anything unrecognized resolves to "latest".
 *
 * Passing "latest" resolves against the current latest release.
 */
export async function getJavaVersionForMinecraftVersion(
	mcVersion: string,
): Promise<string> {
	const major = await getRequiredJavaMajor(mcVersion);
	if (major === null) {
		return "latest";
	}
	return mapMajorToImageTag(major);
}

/**
 * Determines the image tag whose Java version can run the given modpack
 * version, based on the newest game version that pack version supports.
 * Passing "latest" resolves against the pack's current newest release.
 * Falls back to "latest" when the pack's versions can't be fetched or
 * none of them declare a usable game version.
 */
export async function getJavaVersionForModpackVersion(
	modpack: string,
	modpackVersion: string,
): Promise<string> {
	const gameVersions = await getGameVersionsForModpackVersion(
		modpack,
		modpackVersion,
	);
	const newest = gameVersions ? getNewestGameVersion(gameVersions) : null;
	return getJavaVersionForMinecraftVersion(newest ?? "latest");
}

/**
 * Given the game versions a modpack version supports, returns the newest
 * one — the version that dictates the Java requirement. Versions that
 * aren't dotted numbers (ie. snapshots like "24w14a") are ignored, and
 * `null` is returned when nothing usable remains.
 */
export function getNewestGameVersion(gameVersions: string[]): string | null {
	let newest: string | null = null;
	for (const gameVersion of gameVersions) {
		if (!/^\d+(\.\d+)*$/.test(gameVersion)) {
			continue;
		}
		if (newest === null || compareGameVersions(gameVersion, newest) > 0) {
			newest = gameVersion;
		}
	}
	return newest;
}

/**
 * Lists the itzg/minecraft-server image tags offered for selection in
 * the config screen — "latest" plus every "javaNN" tag (and variants
 * like "java21-graalvm") published on Docker Hub, newest major first.
 *
 * Docker Hub is queried at most once per day; the result is cached on
 * disk. When Docker Hub can't be reached, a stale cache is used, and
 * failing that a hardcoded list built from the known Java majors.
 */
export async function getJavaImageTags(): Promise<string[]> {
	const cached = await readCachedImageTags();
	if (cached && Date.now() - cached.fetchedAt < IMAGE_TAGS_CACHE_TTL_MS) {
		return cached.tags;
	}

	try {
		const tags = await fetchJavaImageTags();
		await writeCachedImageTags(tags);
		return tags;
	} catch (err) {
		logger.warn(
			{ error: err },
			"Failed to fetch image tags from Docker Hub, using fallback",
		);
		return cached?.tags ?? fallbackImageTags();
	}
}

// #endregion Public API

// #region Private Helpers

async function getRequiredJavaMajor(mcVersion: string): Promise<number | null> {
	try {
		const manifest = await VanillaService.getVanillaVersions({
			snapshots: true,
			alphas: true,
			betas: true,
		});
		const id =
			mcVersion === "latest" || mcVersion === "LATEST"
				? manifest.latest.release
				: mcVersion;

		const cached = await readCachedJavaVersions();
		const cachedMajor = cached[id];
		if (cachedMajor !== undefined) {
			return cachedMajor;
		}

		const entry = manifest.versions.find((version) => version.id === id);
		if (!entry) {
			return fallbackMajorFromVersionId(id);
		}

		const detail = await fetchVersionDetail(entry.url);
		await writeCachedJavaVersion(id, detail.javaVersion.majorVersion);
		return detail.javaVersion.majorVersion;
	} catch (err) {
		logger.warn(
			{ error: err },
			`Failed to resolve Java requirement for Minecraft "${mcVersion}", using fallback`,
		);
		return fallbackMajorFromVersionId(mcVersion);
	}
}

/**
 * Looks up the game versions declared by a modpack version. "latest"
 * means the pack's current newest release. Returns `null` when the
 * pack's versions can't be fetched or the requested version is unknown.
 */
async function getGameVersionsForModpackVersion(
	modpack: string,
	modpackVersion: string,
): Promise<string[] | null> {
	try {
		const versions = await ModrinthService.getModpackVersions(modpack);
		if (modpackVersion === "latest") {
			const release = versions.find(
				(version) => version.version_type === "release",
			);
			return release?.game_versions ?? null;
		}
		const match = versions.find(
			(version) =>
				version.version_number === modpackVersion ||
				version.id === modpackVersion,
		);
		return match?.game_versions ?? null;
	} catch (err) {
		logger.warn(
			{ error: err },
			`Failed to fetch versions for modpack "${modpack}", using fallback`,
		);
		return null;
	}
}

async function fetchVersionDetail(url: string) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch version detail: ${response.status} ${response.statusText}`,
		);
	}
	return versionDetailSchema.parse(await response.json());
}

function mapMajorToImageTag(major: number): string {
	for (const supported of SUPPORTED_JAVA_MAJORS) {
		if (major <= supported) {
			return javaImageTag(supported);
		}
	}
	return "latest";
}

/**
 * Last-resort table for when Mojang's metadata is unreachable. Only
 * covers versions known at time of writing; anything unrecognized
 * returns null so the caller falls back to "latest".
 */
function fallbackMajorFromVersionId(id: string): number | null {
	const match = id.match(/^1\.(\d+)(?:\.(\d+))?/);
	if (!match?.[1]) {
		return null;
	}

	const minor = Number(match[1]);
	const patch = Number(match[2] ?? 0);

	if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
	if (minor >= 18) return 17;
	if (minor === 17) return 16;
	return 8;
}

function compareGameVersions(a: string, b: string): number {
	const partsA = a.split(".").map(Number);
	const partsB = b.split(".").map(Number);
	const length = Math.max(partsA.length, partsB.length);
	for (let i = 0; i < length; i++) {
		const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

async function readCachedJavaVersions(): Promise<JavaVersionCache> {
	try {
		const fileContent = await fs.readFile(cacheFilePath, "utf-8");
		return javaVersionCacheSchema.parse(JSON.parse(fileContent));
	} catch {
		return {};
	}
}

/** Matches the image tags worth offering: "java21", "java21-graalvm". */
const javaTagPattern = /^java\d+(-[a-z0-9]+)?$/;

/**
 * Fetches the java image tags from Docker Hub, paginating through the
 * tags API (bounded, so a runaway page count can't hang the UI).
 */
async function fetchJavaImageTags(): Promise<string[]> {
	const tags = new Set<string>();
	let url: string | null =
		"https://hub.docker.com/v2/repositories/itzg/minecraft-server/tags?page_size=100&name=java";

	// Known limitation: Docker Hub orders tags by last activity, so if the
	// `java`-tagged set ever exceeds these 10 pages (1000 tags), the oldest
	// majors (java8/11/16) silently drop out of the list. The hardcoded
	// fallback in `getJavaImageTags` only kicks in when the fetch fails
	// outright, not when it truncates.
	for (let page = 0; page < 10 && url; page++) {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(
				`Docker Hub tags request failed: ${response.status} ${response.statusText}`,
			);
		}

		const data = dockerHubTagsPageSchema.parse(await response.json());
		for (const result of data.results) {
			if (javaTagPattern.test(result.name)) {
				tags.add(result.name);
			}
		}
		url = data.next;
	}

	if (tags.size === 0) {
		throw new Error("Docker Hub returned no java image tags");
	}

	return ["latest", ...sortImageTags([...tags])];
}

/** Sorts tags by Java major, newest first, standard variant before others. */
function sortImageTags(tags: string[]): string[] {
	const majorOf = (tag: string) => {
		const match = /^java(\d+)/.exec(tag);
		return match?.[1] ? Number(match[1]) : 0;
	};

	return tags.sort((a, b) => {
		const diff = majorOf(b) - majorOf(a);
		if (diff !== 0) {
			return diff;
		}
		if (a === javaImageTag(majorOf(a))) return -1;
		if (b === javaImageTag(majorOf(b))) return 1;
		return a.localeCompare(b);
	});
}

/**
 * Last-resort tag list for when Docker Hub is unreachable and nothing
 * is cached: every known Java major in every known variant.
 */
function fallbackImageTags(): string[] {
	const tags = SUPPORTED_JAVA_MAJORS.flatMap((major) =>
		JAVA_IMAGE_VARIANTS.map((variant) => javaImageTag(major, variant)),
	);
	return ["latest", ...sortImageTags(tags)];
}

async function readCachedImageTags(): Promise<JavaImageTagsCache | null> {
	try {
		const fileContent = await fs.readFile(imageTagsCacheFilePath, "utf-8");
		return javaImageTagsCacheSchema.parse(JSON.parse(fileContent));
	} catch {
		return null;
	}
}

async function writeCachedImageTags(tags: string[]) {
	try {
		const cache: JavaImageTagsCache = { fetchedAt: Date.now(), tags };
		await fs.mkdir(config.cacheDir, { recursive: true });
		await fs.writeFile(imageTagsCacheFilePath, JSON.stringify(cache), "utf-8");
	} catch (err) {
		logger.warn({ error: err }, "Failed to write cached java image tags");
	}
}

async function writeCachedJavaVersion(mcVersion: string, major: number) {
	try {
		const cached = await readCachedJavaVersions();
		cached[mcVersion] = major;
		await fs.mkdir(config.cacheDir, { recursive: true });
		await fs.writeFile(cacheFilePath, JSON.stringify(cached), "utf-8");
	} catch (err) {
		logger.warn({ error: err }, "Failed to write cached java versions");
	}
}

// #endregion Private Helpers
