import * as ModrinthAPI from "../lib/modrinth/index.js";

export async function getProject(modpack: string) {
	const { identifier } = parseModrinthModpack(modpack);
	const project = await ModrinthAPI.projects.id(identifier).get();
	return project;
}

export async function isModpack(modpack: string | ModrinthAPI.ModrinthProject) {
	if (typeof modpack !== "string") {
		return modpack.project_type === "modpack";
	}

	const { identifier } = parseModrinthModpack(modpack);

	try {
		const project = await ModrinthAPI.projects.id(identifier).get();
		return project.project_type === "modpack";
	} catch {
		return false;
	}
}

export async function getModpackVersions(modpack: string) {
	const { identifier } = parseModrinthModpack(modpack);

	const versions = await ModrinthAPI.projects.id(identifier).getVersions();
	return versions;
}

/**
 * The value input for a modrinth modpack can be,
 * - a url (ie. https://modrinth.com/modpack/cobbleverse)
 * - a slug (ie. cobbleverse)
 * - an id (ie. 5FFgwNNP)
 * - a url to a specific version (ie. https://modrinth.com/modpack/cobbleverse/version/1.42.2)
 *
 * This function will parse out an identifier and a selected version if present.
 */
export function parseModrinthModpack(modpack: string): {
	identifier: string;
	version?: string;
} {
	const urlPattern =
		/^https?:\/\/modrinth\.com\/modpack\/([^/]+)(?:\/version\/([^/]+))?/;
	const match = modpack.match(urlPattern);
	if (match) {
		const identifier = match[1];
		if (identifier) {
			return {
				identifier,
				version: match[2] || undefined,
			};
		}
	}

	// If it's not a URL, assume it's a slug or an ID
	return {
		identifier: modpack,
	};
}
