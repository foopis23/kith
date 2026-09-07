import qs from "qs";
import {
	MODRINTH_API_BASE_URL,
	MODRINTH_USER_AGENT,
	ModrinthHttpError,
	ModrinthNotFoundError,
	ModrinthRateLimitError,
	ModrinthUnexpectedResponseError,
	modrinthProjectSchema,
	modrinthVersionsSchema,
	type ProjectVersionsQueryParameters,
} from "./model.js";

export const projects = {
	id(id: string) {
		return {
			get: async () => {
				const json = await getJson(`/project/${id}`);
				const validated = modrinthProjectSchema.safeParse(json);
				if (!validated.success) {
					throw new ModrinthUnexpectedResponseError(
						`/project/${id}`,
						validated.error,
					);
				}
				return validated.data;
			},
			getVersions: async (query?: ProjectVersionsQueryParameters) => {
				const queryString = buildQueryString(query);
				const json = await getJson(`/project/${id}/version${queryString}`);
				const validated = modrinthVersionsSchema.safeParse(json);
				if (!validated.success) {
					throw new ModrinthUnexpectedResponseError(
						`/project/${id}/version${queryString}`,
						validated.error,
					);
				}
				return validated.data;
			},
		};
	},
};

async function request(path: string) {
	const response = await fetch(`${MODRINTH_API_BASE_URL}${path}`, {
		headers: {
			"User-Agent": MODRINTH_USER_AGENT,
		},
	});
	if (!response.ok) {
		if (response.status === 429) {
			const limit = response.headers.get("X-RateLimit-Limit");
			const reset = response.headers.get("X-RateLimit-Reset");
			throw new ModrinthRateLimitError(path, limit, reset);
		}

		if (response.status === 404) {
			throw new ModrinthNotFoundError(path);
		}

		throw new ModrinthHttpError(path, response.status, response.statusText);
	}
	return response;
}

async function getJson(path: string) {
	const response = await request(path);
	return response.json();
}

function buildQueryString(query?: Record<string, unknown>) {
	const normalizedQuery = Object.entries(query ?? {}).reduce<
		Record<string, unknown>
	>((acc, [key, value]) => {
		if (Array.isArray(value)) {
			acc[key] = JSON.stringify(value);
		} else if (value !== undefined && value !== null) {
			acc[key] = value;
		}
		return acc;
	}, {});

	return Object.keys(normalizedQuery).length > 0
		? `?${qs.stringify(normalizedQuery, { arrayFormat: "repeat" })}`
		: "";
}
