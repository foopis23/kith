import type * as compose from "docker-compose";
import { z } from "zod";

export const containerIdSchema = z.string().regex(/^[0-9a-f]{12,64}$/i);

/**
 * A schema representing a Docker Compose service.
 *
 * Loose on purpose: kith rewrites compose files when server settings
 * change, and service options it doesn't model (restart policies,
 * depends_on, …) must survive that load/save round-trip.
 */
export const composeServiceSchema = z.looseObject({
	image: z.string(),
	pull_policy: z.string().optional(),
	tty: z.boolean().optional(),
	stdin_open: z.boolean().optional(),
	labels: z.record(z.string(), z.string()).optional(),
	ports: z.array(z.string()).optional(),
	// YAML parses unquoted scalars, so a hand-written `MAX_PLAYERS: 20`
	// arrives as a number. Coerce back to a string instead of rejecting
	// the whole compose file — itzg's env vars are all strings anyway.
	environment: z.record(z.string(), z.coerce.string()).optional(),
	volumes: z.array(z.string()).optional(),
});
export type ComposeService = z.infer<typeof composeServiceSchema>;

/**
 * A schema representing a Docker Compose configuration.
 *
 * By no means does this schema cover the full range of docker compose
 * configuration. It also specifically doesn't support all valid formats
 * of supported attributes. The reason being, it just makes things simpler.
 */
export const composeConfigSchema = z.looseObject({
	name: z.string().optional(),
	services: z.record(z.string(), composeServiceSchema),
});
export type ComposeConfig = z.infer<typeof composeConfigSchema>;

export class FailedToLoadComposeConfigError extends Error {
	readonly code = "FAILED_TO_LOAD_COMPOSE_CONFIG";

	constructor(
		public readonly path: string,
		public readonly reason: string,
		errorOptions?: ErrorOptions,
	) {
		super(
			`Failed to load Docker Compose configuration from "${path}"\nReason:\n${reason}`,
			errorOptions,
		);
		this.name = "FailedToLoadComposeConfigError";
	}
}
export class FailedToValidateComposeConfigError extends Error {
	readonly code = "FAILED_TO_VALIDATE_COMPOSE_CONFIG";

	constructor(
		public readonly zodError: z.ZodError,
		errorOptions?: ErrorOptions,
	) {
		super(
			`Missing or Unexpected fields in Docker Compose Configuration.\n${z.prettifyError(zodError)}`,
			errorOptions,
		);
		this.name = "FailedToValidateComposeConfigError";
	}
}

export class FailedToParseComposeConfigError extends Error {
	readonly code = "FAILED_TO_PARSE_COMPOSE_CONFIG";

	constructor(
		public readonly content: string,
		errorOptions?: ErrorOptions,
	) {
		super(`Invalid YAML in Docker Compose File.`, errorOptions);
		this.name = "FailedToParseComposeConfigError";
	}
}

export class FailedToReadComposeConfigError extends Error {
	readonly code = "FAILED_TO_READ_COMPOSE_CONFIG";

	constructor(
		public readonly path: string,
		errorOptions?: ErrorOptions,
	) {
		super(`Failed to read Docker Compose file from "${path}".`, errorOptions);
		this.name = "FailedToReadComposeConfigError";
	}
}

export class DockerCommandFailedError extends Error {
	readonly code = "DOCKER_COMMAND_FAILED";

	constructor(
		public readonly command: string,
		public readonly args: {
			command?: string | string[];
			container?: string;
			options?: compose.IDockerComposeOptions;
		},
		errorOptions?: ErrorOptions,
	) {
		super(`Failed to run Docker command "${command}".`, errorOptions);
		this.name = "DockerCommandFailedError";
	}
}
