import fs from "node:fs/promises";
import path from "node:path";
import * as compose from "docker-compose";
import YAML from "yaml";
import type z from "zod";
import { logger as globalLogger } from "../lib/logger.js";
import {
	type ComposeConfig,
	composeConfigSchema,
	DockerCommandFailedError,
	FailedToLoadComposeConfigError,
	FailedToParseComposeConfigError,
	FailedToReadComposeConfigError,
	FailedToValidateComposeConfigError,
} from "../models/compose.model.js";

const DOCKER_COMPOSE_FILE_NAME = "docker-compose.yml";

const logger = globalLogger.child({ service: "compose.service.ts" });

// #region Public API
/**
 * Read and validates the Docker Compose configuration file.
 *
 * @throws Will throw an error if the Docker Compose configuration is invalid.
 *
 * @param dir_path the directory path containing the Docker Compose configuration file.
 * @returns The validated Docker Compose configuration.
 */
export async function loadComposeConfig(
	dir_path: string,
): Promise<ComposeConfig> {
	try {
		const content = await readComposeFile(dir_path);
		const parsed = parseComposeContent(content);
		const validated = validateComposeConfig(parsed);
		return validated;
	} catch (err) {
		const message = err instanceof Error ? err.message : "unknown error";
		const newErr = new FailedToLoadComposeConfigError(dir_path, message, {
			cause: err,
		});
		logger.error(newErr);
		throw newErr;
	}
}

/**
 * Strips the Docker Compose prefix from a log line.
 *
 * @param line The log line to strip the Docker Compose prefix from.
 * @returns The log line without the Docker Compose prefix.
 */
export function stripComposePrefix(line: string): string {
	return line.replace(/^\s*[\w.-]+\s+\|\s+/, "");
}

export async function ps(options: compose.IDockerComposeOptions | undefined) {
	try {
		return await compose.ps(options);
	} catch (err) {
		const newErr = new DockerCommandFailedError(
			"ps",
			{ options },
			{
				cause: err,
			},
		);
		logger.error(newErr);
	}
}

export async function upAll(
	options: compose.IDockerComposeOptions | undefined,
) {
	try {
		return await compose.upAll(options);
	} catch (err) {
		const newErr = new DockerCommandFailedError(
			"up",
			{ options },
			{
				cause: err,
			},
		);
		logger.error(err);
		logger.error(newErr);
	}
}

export async function down(options: compose.IDockerComposeOptions | undefined) {
	try {
		return await compose.downAll(options);
	} catch (err) {
		const newErr = new DockerCommandFailedError(
			"down",
			{ options },
			{
				cause: err,
			},
		);
		logger.error(newErr);
	}
}

export async function exec(
	container: string,
	command: string,
	options: compose.IDockerComposeOptions | undefined,
) {
	try {
		return await compose.exec(container, command, options);
	} catch (err) {
		const newErr = new DockerCommandFailedError(
			"exec",
			{ container, command, options },
			{
				cause: err,
			},
		);
		logger.error(newErr);
	}
}

/**
 * Runs a one-off container for a service (`docker compose run`), for
 * commands that must work while the stack is stopped. Pass ie.
 * `["--rm", "--no-deps", "--entrypoint", "restic"]` as commandOptions.
 *
 * A failed command is logged at debug level when `expected` is set —
 * for probes like `restic cat config`, where failure is the normal
 * "doesn't exist yet" answer rather than a problem.
 */
export async function run(
	container: string,
	command: string | string[],
	options: compose.IDockerComposeOptions | undefined,
	opts?: { expected?: boolean },
) {
	try {
		return await compose.run(container, command, options);
	} catch (err) {
		const newErr = new DockerCommandFailedError(
			"run",
			{ container, command, options },
			{
				cause: err,
			},
		);
		if (opts?.expected) {
			logger.debug(newErr);
		} else {
			logger.error(newErr);
		}
	}
}
// #endregion Public API

// #region Private Helpers

function readComposeFile(dirPath: string) {
	try {
		return fs.readFile(path.join(dirPath, DOCKER_COMPOSE_FILE_NAME), "utf-8");
	} catch (err) {
		throw new FailedToReadComposeConfigError(
			path.join(dirPath, DOCKER_COMPOSE_FILE_NAME),
			{ cause: err },
		);
	}
}

function parseComposeContent(content: string): unknown {
	try {
		return YAML.parse(content);
	} catch (err) {
		throw new FailedToParseComposeConfigError(content, { cause: err });
	}
}

function validateComposeConfig(parsed: unknown) {
	try {
		return composeConfigSchema.parse(parsed);
	} catch (err) {
		throw new FailedToValidateComposeConfigError(
			err as z.ZodError, // This error could only ever be a zod error, so casting is safe here.
			{ cause: err },
		);
	}
}

//#endregion Private Helpers
