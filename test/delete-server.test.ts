/**
 * Unit tests for server deletion: archive/destroy semantics, the
 * archived-server roster and port rules, and the refusal to delete
 * when the stack can't be confirmed down. The compose service is
 * mocked at the module boundary so no docker is needed. Test env
 * isolation (throwaway servers dir, narrow port range) comes from the
 * preloaded test/setup.ts; src imports are dynamic so the mock is
 * registered before the modules that use it load.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

// What the mocked ps reports: an empty stack (delete may proceed),
// undefined (docker unreachable — ps failed), or services still up.
let psResult: { data: { services: { name: string }[] } } | undefined;

const realCompose = await import("../src/services/compose.service.js");
mock.module("../src/services/compose.service.js", () => ({
	...realCompose,
	down: async () => undefined,
	ps: async () => psResult,
}));

const { ARCHIVED_SERVER_PREFIX, SERVER_LABEL } = await import(
	"../src/lib/const.js"
);
const { config, serverPath } = await import("../src/lib/config.js");
const { exists } = await import("../src/lib/fs.js");
const { FailedToDeleteServerError, ServerStackNotDownError } = await import(
	"../src/models/server.model.js"
);
const ServerService = await import("../src/services/server.service.js");

/**
 * Ports the port-reuse test works with. They must be the two lowest
 * ports of the KITH_PORT_RANGE the preloaded test/setup.ts configures.
 */
const REUSED_PORT = 39991;
const OTHER_PORT = 39992;

/** Writes a minimal but valid managed server to the servers dir. */
async function writeServer(id: string, port: number): Promise<string> {
	const dir = serverPath(id);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		path.join(dir, "docker-compose.yml"),
		YAML.stringify({
			services: {
				mc: {
					image: "itzg/minecraft-server:java21",
					labels: { [SERVER_LABEL]: id },
					ports: [`${port}:${port}`],
					environment: { SERVER_PORT: `${port}` },
				},
			},
		}),
	);
	return dir;
}

function archivedPath(id: string, suffix = ""): string {
	return path.join(
		config.serversDir,
		`${ARCHIVED_SERVER_PREFIX}${id}${suffix}`,
	);
}

beforeEach(() => {
	psResult = { data: { services: [] } };
});

describe("deleteServer", () => {
	test("archive renames the directory to .archived.<id>", async () => {
		const dir = await writeServer("archive-me", 40001);
		await ServerService.deleteServer("archive-me", "archive");
		expect(await exists(dir)).toBe(false);
		expect(
			await exists(path.join(archivedPath("archive-me"), "docker-compose.yml")),
		).toBe(true);
	});

	test("archive suffixes the name when a previous archive exists", async () => {
		await writeServer("twice", 40002);
		await ServerService.deleteServer("twice", "archive");
		await writeServer("twice", 40002);
		await ServerService.deleteServer("twice", "archive");
		expect(await exists(archivedPath("twice"))).toBe(true);
		expect(await exists(archivedPath("twice", "-2"))).toBe(true);
	});

	test("archived servers stay off the roster", async () => {
		await writeServer("listed", 40003);
		await writeServer("archived-one", 40004);
		await ServerService.deleteServer("archived-one", "archive");
		const ids = (await ServerService.getServers()).map((server) => server.id);
		expect(ids).toContain("listed");
		expect(ids).not.toContain("archived-one");
	});

	test("an archived server's ports are handed out again", async () => {
		// "old" pins REUSED_PORT; once it's archived the port is free, so
		// resetting "other"'s port must hand out REUSED_PORT — the only
		// other port in the range is "other"'s own.
		await writeServer("old", REUSED_PORT);
		await writeServer("other", OTHER_PORT);
		await ServerService.deleteServer("old", "archive");
		const updated = await ServerService.updateServerConfig("other", {
			port: undefined,
		});
		expect(updated.port).toBe(REUSED_PORT);
	});

	test("destroy erases the directory", async () => {
		const dir = await writeServer("gone", 40005);
		await ServerService.deleteServer("gone", "destroy");
		expect(await exists(dir)).toBe(false);
	});

	test("refuses to delete when docker can't confirm the stack is down", async () => {
		// ps failing means down may have failed too — the delete must not
		// touch the directory on a guess.
		psResult = undefined;
		const dir = await writeServer("daemon-down", 40006);
		await expect(
			ServerService.deleteServer("daemon-down", "destroy"),
		).rejects.toBeInstanceOf(ServerStackNotDownError);
		expect(await exists(dir)).toBe(true);
	});

	test("refuses to delete while services remain after down", async () => {
		psResult = { data: { services: [{ name: "mc" }] } };
		const dir = await writeServer("still-up", 40007);
		await expect(
			ServerService.deleteServer("still-up", "archive"),
		).rejects.toBeInstanceOf(ServerStackNotDownError);
		expect(await exists(dir)).toBe(true);
	});

	test("wraps filesystem failures in FailedToDeleteServerError", async () => {
		// Archiving a server whose directory doesn't exist fails at rename.
		await expect(
			ServerService.deleteServer("ghost", "archive"),
		).rejects.toBeInstanceOf(FailedToDeleteServerError);
	});
});
