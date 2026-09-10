# Kith

> [!WARNING]
> **Pre-release software.** Kith is under active development. Configuration formats, behavior, and on-disk layouts can change between releases, and following the docs without care can break your servers. Back up anything you can't afford to lose before upgrading or changing global settings.

A terminal UI for managing Minecraft servers on the [itzg/minecraft-server](https://docker-minecraft-server.readthedocs.io/) image. It handles the upkeep: modpack installs and updates, Java version matching, backups, and config patches. That said, every server stays a plain `docker-compose.yml` and a data directory you can edit by hand.

## Why?

The itzg/minecraft-server image already does almost everything a Minecraft server needs. But you only create a new server every few months, so each one means a trip back to the image's docs to re-learn how the compose file goes together and which environment variables do what. Server panels solve the remembering, but replace your files with their own abstractions. Kith is a thin layer on top of the Docker image that knows the knobs so you don't have to, while every server stays an ordinary compose project you can edit by hand when you need to.

## Features

- **Modpack management.** Paste a modpack link and kith validates it, lists every published version with its loader and release channel, and installs it. Track "Latest release" and the pack updates itself on restart, stable releases only. Vanilla servers work too: pick any Minecraft release and go.
- **Config patching.** Updating a pack regenerates its config files and wipes your hand-made changes. Kith re-applies your `patches.json` on every start. See [Patching mod configs](https://foopis23.github.io/kith/patching).
- **Java version matching.** Each server gets a JVM matched to its Minecraft version. No "unsupported class file version" crashes after an update, no juggling JDK installs.
- **Automatic backups.** Snapshots run on a schedule with retention pruning, and you can take one on demand before doing anything risky. Restoring to any snapshot takes a few keystrokes. Backups live on local disk or off-site on S3, Backblaze B2, Azure, or GCS.
- **Unified dashboard.** Live status and player counts for all your servers. Start and stop them, watch logs stream by, run console commands, all without leaving the app.
- **Plain Docker Compose.** Memory, port, version, and modpack are configurable per server from inside the app. Underneath, each server is a plain `docker-compose.yml` you can open and edit. Kith preserves anything it doesn't manage.

## Quick start

Requirements are [Bun](https://bun.com) 1.4+ and [Docker](https://www.docker.com/) with the Compose plugin.

```bash
bun install -g @foopis23/kith
kith
```

Out of the box kith is a per-user install. Everything lives under your home directory following the XDG Base Directory Specification, with nothing to configure. From the main screen, create a server, pick a modpack or a vanilla version, and start it.

## Documentation

Full documentation lives at [foopis23.github.io/kith](https://foopis23.github.io/kith/), published on every release. Covers motivation, installation, usage, the config reference, backups, and known limitations.

The markdown sources are in [`docs/`](docs/) if you're browsing the repo offline.

## Development

```bash
bun install
bun start

bun run lint        # biome lint (with autofix)
bun run format      # biome format
bunx tsc --noEmit   # typecheck
```
