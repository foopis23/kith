/**
 * Unit tests for the ManagedServer model: the compose <-> server mapping,
 * lenient env parsing, patch application, and round-trip preservation of
 * data kith doesn't manage. Pure data in, pure data out — no docker.
 */
import { describe, expect, test } from "bun:test";
import { ManagedServer } from "../src/models/server.model";

/**
 * A representative compose doc as kith writes it, plus the kinds of
 * unmanaged additions the round-trip must preserve: an extra label, an
 * extra env var, an extra port mapping, an unmanaged service option and
 * a whole unmanaged service.
 */
const vanillaCompose = {
	name: "test",
	services: {
		mc: {
			image: "itzg/minecraft-server:java21",
			pull_policy: "daily",
			tty: true,
			stdin_open: true,
			stop_grace_period: "1m",
			restart: "unless-stopped",
			logging: {
				driver: "json-file",
				options: { "max-size": "10m", "max-file": "5" },
			},
			labels: {
				"kith.server.label": "Test Server",
				"some.unrelated.label": "keep me",
			},
			ports: ["25565:25565", "24454:24454/udp"],
			environment: {
				EULA: "TRUE",
				USE_AIKAR_FLAGS: "TRUE",
				PATCH_DEFINITIONS: "/patches.json",
				TYPE: "VANILLA",
				VERSION: "1.21.4",
				SERVER_PORT: "25565",
				MOTD: "Hello",
				HARDCORE: "true",
				ROLLING_LOG_MAX_FILES: "7",
				CUSTOM_VAR: "preserve me",
			},
			volumes: ["./data:/data", "./patches.json:/patches.json:ro"],
			healthcheck: { test: ["CMD", "mc-monitor"] },
		},
		voicechat: {
			image: "example/voicechat:latest",
		},
	},
};

const modrinthCompose = {
	services: {
		mc: {
			image: "itzg/minecraft-server:java21",
			labels: { "kith.server.label": "Modded" },
			ports: ["25566:25566"],
			environment: {
				TYPE: "MODRINTH",
				MODRINTH_MODPACK: "adrenaline",
				VERSION: "latest",
				SERVER_PORT: "25566",
			},
		},
	},
};

function environmentOf(server: ManagedServer): Record<string, string> {
	return server.toCompose().services.mc.environment ?? {};
}

describe("ManagedServer.fromCompose", () => {
	test("reads the derived views out of the compose data", () => {
		const server = ManagedServer.fromCompose("abc", vanillaCompose);
		expect(server.id).toBe("abc");
		expect(server.label).toBe("Test Server");
		expect(server.type).toBe("VANILLA");
		expect(server.modpack).toBeUndefined();
		expect(server.imageTag).toBe("java21");
		expect(server.gameContainerPort).toBe(25565);
		expect(server.port).toBe(25565);
		expect(server.hostPorts).toEqual([25565, 24454]);
		expect(server.backupsState).toBe("not_set_up");
		expect(server.backupSidecar).toBeUndefined();
	});

	test("counts host-IP-prefixed mappings as used host ports", () => {
		const compose = structuredClone(vanillaCompose);
		compose.services.mc.ports = [
			"127.0.0.1:25565:25565",
			"192.168.1.10:40000:40000",
		];
		const server = ManagedServer.fromCompose("abc", compose);
		// Prefixed mappings still bind a host port, so they must count even
		// though the game port field deliberately ignores them.
		expect(server.hostPorts).toEqual([25565, 40000]);
	});

	test("reads the editable config", () => {
		const config = ManagedServer.fromCompose("abc", vanillaCompose).config;
		expect(config.motd).toBe("Hello");
		expect(config.hardcore).toBe(true);
		expect(config.maxLogFiles).toBe(7);
		expect(config.version).toBe("1.21.4");
		expect(config.flags).toBe("aikar");
		expect(config.port).toBe(25565);
		expect(config.imageTag).toBe("java21");
		expect(config.type).toBe("VANILLA");
		// Not a MODRINTH server — the modpack version stays unset.
		expect(config.modpackVersion).toBeUndefined();
		expect(config.seed).toBeUndefined();
	});

	test("reads a modrinth server's modpack context", () => {
		const config = ManagedServer.fromCompose("abc", modrinthCompose).config;
		expect(config.type).toBe("MODRINTH");
		expect(config.modpack).toBe("adrenaline");
		// Creation omits MODRINTH_MODPACK_VERSION for "latest".
		expect(config.modpackVersion).toBe("latest");
	});

	test("nonGameHostPorts excludes only the game port's mapping", () => {
		const server = ManagedServer.fromCompose("abc", {
			services: {
				mc: {
					image: "itzg/minecraft-server:java21",
					labels: { "kith.server.label": "Test" },
					environment: { SERVER_PORT: "25565" },
					ports: ["40000:25565", "40000:40000", "24454:24454/udp"],
				},
			},
		});
		// The mapping sharing the game mapping's host port still counts
		// as used — only the game mapping itself is excluded.
		expect(server.nonGameHostPorts).toEqual([40000, 24454]);
	});

	test("defaults the game container port to 25565 when SERVER_PORT is unset", () => {
		const server = ManagedServer.fromCompose("abc", {
			services: {
				mc: {
					image: "itzg/minecraft-server:java21",
					labels: { "kith.server.label": "Test" },
				},
			},
		});
		expect(server.gameContainerPort).toBe(25565);
		expect(server.port).toBeUndefined();
	});

	test("reads leniently: unparsable env values read as unset instead of throwing", () => {
		const server = ManagedServer.fromCompose("abc", {
			services: {
				mc: {
					image: "itzg/minecraft-server:java21",
					labels: { "kith.server.label": "Test" },
					environment: {
						HARDCORE: "yes please",
						ROLLING_LOG_MAX_FILES: "a lot",
					},
				},
			},
		});
		expect(server.config.hardcore).toBeUndefined();
		expect(server.config.maxLogFiles).toBeUndefined();
	});

	test("coerces non-string env values from hand-written YAML", () => {
		const server = ManagedServer.fromCompose("abc", {
			services: {
				mc: {
					image: "itzg/minecraft-server:java21",
					labels: { "kith.server.label": "Test" },
					environment: { ROLLING_LOG_MAX_FILES: 12, MOTD: 42 },
				},
			},
		});
		expect(server.config.maxLogFiles).toBe(12);
		expect(server.config.motd).toBe("42");
	});

	test("derives the flags preset, meowice winning when both are set", () => {
		const server = ManagedServer.fromCompose("abc", {
			services: {
				mc: {
					image: "itzg/minecraft-server:java21",
					labels: { "kith.server.label": "Test" },
					environment: {
						USE_AIKAR_FLAGS: "TRUE",
						USE_MEOWICE_FLAGS: "TRUE",
					},
				},
			},
		});
		expect(server.config.flags).toBe("meowice");
	});

	test("derives backup state from sidecar presence and the opt-out label", () => {
		const withSidecar = ManagedServer.fromCompose("abc", {
			services: {
				mc: {
					image: "itzg/minecraft-server:java21",
					labels: { "kith.server.label": "Test" },
				},
				backup: { image: "itzg/mc-backup:latest" },
			},
		});
		expect(withSidecar.backupsState).toBe("enabled");
		expect(withSidecar.backupSidecar).toEqual({
			image: "itzg/mc-backup:latest",
		});

		const optedOut = ManagedServer.fromCompose("abc", {
			services: {
				mc: {
					image: "itzg/minecraft-server:java21",
					labels: {
						"kith.server.label": "Test",
						"kith.backups.enabled": "false",
					},
				},
			},
		});
		expect(optedOut.backupsState).toBe("opted_out");
	});

	test("rejects compose data that isn't a kith-managed server", () => {
		expect(() =>
			ManagedServer.fromCompose("abc", {
				services: { mc: { image: "itzg/minecraft-server:java21" } },
			}),
		).toThrow();
	});
});

describe("ManagedServer round-tripping", () => {
	test("an untouched server round-trips identically", () => {
		const server = ManagedServer.fromCompose("abc", vanillaCompose);
		expect(server.toCompose()).toEqual(vanillaCompose);
	});

	test("toCompose preserves data the model doesn't understand", () => {
		const server = ManagedServer.fromCompose("abc", vanillaCompose);
		server.applyConfigPatch({ motd: "Changed" });
		const compose = server.toCompose();
		const mc = compose.services.mc;
		expect(mc.environment?.CUSTOM_VAR).toBe("preserve me");
		expect(mc.labels["some.unrelated.label"]).toBe("keep me");
		expect(mc.healthcheck).toEqual({ test: ["CMD", "mc-monitor"] });
		expect(mc.restart).toBe("unless-stopped");
		expect(mc.ports).toContain("24454:24454/udp");
		expect(compose.services.voicechat).toEqual({
			image: "example/voicechat:latest",
		});
	});

	test("a patch that touches no env vars doesn't add an environment map", () => {
		const server = ManagedServer.fromCompose("abc", {
			services: {
				mc: {
					image: "itzg/minecraft-server:java21",
					labels: { "kith.server.label": "Test" },
				},
			},
		});
		server.applyConfigPatch({ imageTag: "java17" });
		expect("environment" in server.toCompose().services.mc).toBe(false);
	});

	test("toCompose returns a deep copy", () => {
		const server = ManagedServer.fromCompose("abc", vanillaCompose);
		const compose = server.toCompose();
		const environment = compose.services.mc.environment;
		if (environment) {
			environment.MOTD = "mutated";
		}
		expect(server.config.motd).toBe("Hello");
	});
});

describe("ManagedServer.applyConfigPatch", () => {
	test("sets and clears env-backed fields", () => {
		const server = ManagedServer.fromCompose("abc", vanillaCompose);
		server.applyConfigPatch({
			motd: "New MOTD",
			hardcore: false,
			maxLogFiles: 10,
		});
		expect(server.config.motd).toBe("New MOTD");
		expect(server.config.hardcore).toBe(false);
		expect(server.config.maxLogFiles).toBe(10);

		let environment = environmentOf(server);
		expect(environment.MOTD).toBe("New MOTD");
		expect(environment.HARDCORE).toBe("false");
		expect(environment.ROLLING_LOG_MAX_FILES).toBe("10");

		server.applyConfigPatch({ motd: undefined, maxLogFiles: undefined });
		environment = environmentOf(server);
		expect("MOTD" in environment).toBe(false);
		expect("ROLLING_LOG_MAX_FILES" in environment).toBe(false);
		expect(server.config.motd).toBeUndefined();
		expect(server.config.maxLogFiles).toBeUndefined();
	});

	test("leaves fields not in the patch untouched", () => {
		const server = ManagedServer.fromCompose("abc", vanillaCompose);
		server.applyConfigPatch({ seed: "42" });
		expect(server.config.motd).toBe("Hello");
		expect(server.config.seed).toBe("42");
	});

	test("switches the flags preset", () => {
		const server = ManagedServer.fromCompose("abc", vanillaCompose);
		server.applyConfigPatch({ flags: "meowice" });
		let environment = environmentOf(server);
		expect(environment.USE_MEOWICE_FLAGS).toBe("TRUE");
		expect("USE_AIKAR_FLAGS" in environment).toBe(false);
		expect(server.config.flags).toBe("meowice");

		server.applyConfigPatch({ flags: "none" });
		environment = environmentOf(server);
		expect("USE_MEOWICE_FLAGS" in environment).toBe(false);
		expect(server.config.flags).toBe("none");
	});

	test("rewrites only the game port mapping on a port change", () => {
		const server = ManagedServer.fromCompose("abc", vanillaCompose);
		server.applyConfigPatch({ port: 25570 });
		const mc = server.toCompose().services.mc;
		expect(mc.ports).toEqual(["25570:25570", "24454:24454/udp"]);
		expect(mc.environment?.SERVER_PORT).toBe("25570");
		expect(server.port).toBe(25570);
	});

	test("unpublishes the game port when the port is cleared", () => {
		const server = ManagedServer.fromCompose("abc", vanillaCompose);
		server.applyConfigPatch({ port: undefined });
		const mc = server.toCompose().services.mc;
		expect(mc.ports).toEqual(["24454:24454/udp"]);
		expect("SERVER_PORT" in (mc.environment ?? {})).toBe(false);
		expect(server.port).toBeUndefined();
		// The container port falls back to itzg's default.
		expect(server.gameContainerPort).toBe(25565);
	});

	test("replaces the image tag", () => {
		const server = ManagedServer.fromCompose("abc", vanillaCompose);
		server.applyConfigPatch({ imageTag: "java17" });
		expect(server.toCompose().services.mc.image).toBe(
			"itzg/minecraft-server:java17",
		);
		expect(server.imageTag).toBe("java17");
	});

	test("retagging a digest-pinned image drops the digest", () => {
		const server = ManagedServer.fromCompose("abc", {
			services: {
				mc: {
					image: "itzg/minecraft-server:java21@sha256:abc123",
					labels: { "kith.server.label": "Test" },
				},
			},
		});
		server.applyConfigPatch({ imageTag: "java17" });
		expect(server.toCompose().services.mc.image).toBe(
			"itzg/minecraft-server:java17",
		);
	});

	test("retagging a digest-only image appends the tag", () => {
		const server = ManagedServer.fromCompose("abc", {
			services: {
				mc: {
					image: "itzg/minecraft-server@sha256:abc123",
					labels: { "kith.server.label": "Test" },
				},
			},
		});
		server.applyConfigPatch({ imageTag: "java17" });
		expect(server.toCompose().services.mc.image).toBe(
			"itzg/minecraft-server:java17",
		);
	});

	test("mirrors creation's VERSION interplay for modpack versions", () => {
		const server = ManagedServer.fromCompose("abc", modrinthCompose);

		server.applyConfigPatch({ modpackVersion: "abc123" });
		let environment = environmentOf(server);
		expect(environment.MODRINTH_MODPACK_VERSION).toBe("abc123");
		expect("VERSION" in environment).toBe(false);
		expect(server.config.modpackVersion).toBe("abc123");

		server.applyConfigPatch({ modpackVersion: "latest" });
		environment = environmentOf(server);
		expect("MODRINTH_MODPACK_VERSION" in environment).toBe(false);
		expect(environment.VERSION).toBe("latest");
		expect(server.config.modpackVersion).toBe("latest");
	});
});

describe("ManagedServer.setBackups", () => {
	test("adds the sidecar and records the choice in a label", () => {
		const server = ManagedServer.fromCompose("abc", vanillaCompose);
		const sidecar = { image: "itzg/mc-backup:latest" };
		server.setBackups(sidecar);
		expect(server.backupSidecar).toEqual(sidecar);
		expect(server.backupsState).toBe("enabled");
		expect(server.toCompose().services.mc.labels["kith.backups.enabled"]).toBe(
			"true",
		);
	});

	test("removes the sidecar and records the opt-out", () => {
		const server = ManagedServer.fromCompose("abc", vanillaCompose);
		server.setBackups({ image: "itzg/mc-backup:latest" });
		server.setBackups(undefined);
		expect(server.backupSidecar).toBeUndefined();
		expect(server.backupsState).toBe("opted_out");
		expect(server.toCompose().services.mc.labels["kith.backups.enabled"]).toBe(
			"false",
		);
	});

	test("replaceBackupSidecar swaps the sidecar without touching the label", () => {
		const server = ManagedServer.fromCompose("abc", {
			services: {
				mc: {
					image: "itzg/minecraft-server:java21",
					labels: {
						"kith.server.label": "Test",
						"kith.backups.enabled": "false",
					},
				},
				backup: { image: "itzg/mc-backup:old" },
			},
		});
		server.replaceBackupSidecar({ image: "itzg/mc-backup:new" });
		expect(server.backupSidecar).toEqual({ image: "itzg/mc-backup:new" });
		// The recorded choice is left as it was.
		expect(server.toCompose().services.mc.labels["kith.backups.enabled"]).toBe(
			"false",
		);
	});
});

describe("ManagedServer.create", () => {
	test("scaffolds the base compose data kith always writes", () => {
		const server = ManagedServer.create({
			id: "abc",
			label: "Fresh",
			image: "itzg/minecraft-server:java21",
			port: 25565,
			environment: { TYPE: "VANILLA", VERSION: "1.21.4", MEMORY: "2G" },
		});
		const mc = server.toCompose().services.mc;
		expect(mc.image).toBe("itzg/minecraft-server:java21");
		expect(mc.pull_policy).toBe("daily");
		expect(mc.restart).toBe("unless-stopped");
		expect(mc.ports).toEqual(["25565:25565"]);
		expect(mc.labels["kith.server.label"]).toBe("Fresh");
		expect(mc.volumes).toContain("./data:/data");

		const environment = mc.environment ?? {};
		expect(environment.EULA).toBe("TRUE");
		expect(environment.SERVER_PORT).toBe("25565");
		expect(environment.PATCH_DEFINITIONS).toBe("/patches.json");
		expect(environment.TYPE).toBe("VANILLA");
	});

	test("omits undefined environment values", () => {
		const server = ManagedServer.create({
			id: "abc",
			label: "Fresh",
			image: "itzg/minecraft-server:java21",
			port: 25565,
			environment: { VERSION: undefined },
		});
		expect("VERSION" in environmentOf(server)).toBe(false);
	});

	test("records the host identity in UID/GID env vars when given", () => {
		const withIds = ManagedServer.create({
			id: "abc",
			label: "Fresh",
			image: "itzg/minecraft-server:java21",
			port: 25565,
			uid: 1000,
			gid: 1001,
		});
		expect(environmentOf(withIds).UID).toBe("1000");
		expect(environmentOf(withIds).GID).toBe("1001");

		const withoutIds = ManagedServer.create({
			id: "abc",
			label: "Fresh",
			image: "itzg/minecraft-server:java21",
			port: 25565,
		});
		expect("UID" in environmentOf(withoutIds)).toBe(false);
		expect("GID" in environmentOf(withoutIds)).toBe(false);
	});

	test("round-trips through fromCompose with the expected config", () => {
		const created = ManagedServer.create({
			id: "abc",
			label: "Fresh",
			image: "itzg/minecraft-server:java21",
			port: 25565,
			environment: { TYPE: "VANILLA", VERSION: "1.21.4", MEMORY: "2G" },
		});
		const server = ManagedServer.fromCompose("abc", created.toCompose());
		expect(server.label).toBe("Fresh");
		expect(server.port).toBe(25565);
		expect(server.config.version).toBe("1.21.4");
		// The base env opts new servers into aikar flags.
		expect(server.config.flags).toBe("aikar");
		expect(server.backupsState).toBe("not_set_up");
	});
});
