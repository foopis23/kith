#!/usr/bin/env bun
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };

const program = new Command();

program
	.name("kith")
	.description("A simple TUI for managing your Minecraft servers.")
	.version(pkg.version)
	// No subcommand given: launch the TUI. Future subcommands (backups,
	// server management, etc.) hang off `program` alongside this default.
	// The TUI stack (Ink, pino, docker-compose) is imported lazily so that
	// flag-only invocations like `--version` never pay for — or trip over —
	// its module-level side effects.
	.action(async () => {
		const { runTui } = await import("./tui.js");
		runTui();
	});

program.parse();
