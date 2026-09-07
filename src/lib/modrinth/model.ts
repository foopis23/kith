import z from "zod";
import { config } from "../config.js";

export const MODRINTH_API_BASE_URL = "https://api.modrinth.com/v2";
export const MODRINTH_USER_AGENT = `foopis23/kith/${config.version}`;

export type ProjectVersionsQueryParameters = {
	loaders?: string[];
	game_versions?: string[];
	featured?: boolean;
};

export const modrinthProjectSchema = z.object({
	id: z.string(),
	title: z.string(),
	project_type: z.enum(["mod", "modpack", "resourcepack", "shader"]),
});
export type ModrinthProject = z.infer<typeof modrinthProjectSchema>;

export const modrinthVersionsSchema = z.array(
	z.object({
		id: z.string(),
		project_id: z.string(),
		date_published: z.string(),
		name: z.string().optional(),
		version_number: z.string().optional(),
		game_versions: z.array(z.string()).optional(),
		version_type: z.enum(["release", "beta", "alpha"]).optional(),
		loaders: z.array(z.string()).optional(),
	}),
);
export type ModrinthVersion = z.infer<typeof modrinthVersionsSchema>;

export class ModrinthRateLimitError extends Error {
	readonly code = "MODRINTH_RATE_LIMIT";
	constructor(
		readonly path: string,
		readonly limit: string | null, // the max amount of requests allowed in a minute
		readonly reset: string | null,
	) {
		super(
			`Rate limit exceeded for path: ${path}. Limit: ${limit}, resets in: ${reset} seconds.`,
		);
	}
}

export class ModrinthNotFoundError extends Error {
	readonly code = "MODRINTH_NOT_FOUND";
	constructor(readonly path: string) {
		super(`Resource not found for path: ${path}`);
	}
}

export class ModrinthHttpError extends Error {
	readonly code = "MODRINTH_HTTP_ERROR";
	constructor(
		readonly path: string,
		readonly status: number,
		readonly statusText: string,
	) {
		super(
			`HTTP error for path: ${path}. Status: ${status}, Status Text: ${statusText}`,
		);
	}
}

export class ModrinthUnexpectedResponseError extends Error {
	readonly code = "MODRINTH_UNEXPECTED_RESPONSE";
	constructor(
		readonly path: string,
		readonly zodError: z.ZodError,
	) {
		super(
			`Unexpected response for path: ${path}.\n${z.prettifyError(zodError)}`,
		);
	}
}
