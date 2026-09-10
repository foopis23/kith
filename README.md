# Kith

A terminal UI for running Minecraft servers that are meant to _stay_ running. Kith handles the upkeep: installing and updating modpacks, matching Java versions, keeping backups, re-applying your config tweaks after every pack update. It's built on the [itzg/minecraft-server](https://docker-minecraft-server.readthedocs.io/) image and wraps each server in a plain Docker Compose project.

Kith stays out of your way. Each server is a `docker-compose.yml` and a data directory, nothing more. No daemon, no database. Edit `server.properties` by hand, drop plugins or mods into the data directory, tweak the compose file. It's your server; kith just streamlines the boring parts. Anything kith doesn't manage, it leaves alone.

## Features

- **Modrinth modpacks without the manual labor.** Paste a modpack link and kith validates it, lists every published version with its loader and release channel, and installs it. Track "Latest release" and the pack updates itself on restart, stable releases only. Vanilla servers work too: pick any Minecraft release and go.
- **Config tweaks that survive modpack updates.** Updating a pack regenerates its config files and wipes your hand-made changes. Every kith server is wired up for patch definitions out of the box. Describe your tweaks once in `patches.json` and they're re-applied on every start. See [Patching mod configs](#patching-mod-configs).
- **The right Java, every time.** Each server gets a JVM matched to its Minecraft version. No "unsupported class file version" crashes after an update, no juggling JDK installs.
- **Backups you don't have to remember.** Snapshots run on a schedule with retention pruning, and you can take one on demand before doing anything risky. Restoring to any snapshot takes a few keystrokes. Backups live on local disk or off-site on S3, Backblaze B2, Azure, or GCS. See [Backups](docs/backups.md).
- **Every server on one screen.** Live status and player counts for all your servers. Start and stop them, watch logs stream by, run console commands, all without leaving the app.
- **Sensible defaults, nothing locked away.** Memory, port, version, and modpack are configurable per server from inside the app. Underneath, each server is a plain `docker-compose.yml` you can open and edit. Kith preserves anything it doesn't manage, so the escape hatch is always open.

## How it works

Each server is a directory under `KITH_SERVERS_DIR` (`~/.local/share/kith/servers` by default) containing:

- `docker-compose.yml`, the server definition. A standard compose file you can read and edit.
- `patches.json`, your config patches, re-applied on every start. See [Patching mod configs](#patching-mod-configs).
- `data/`, the server's live data: world, `server.properties`, mods, plugins. Mounted into the container at `/data`.

Everything in there is yours. Edit configs directly, drop files into `data/`, add services to the compose file. Kith only rewrites the parts it manages and preserves the rest. Servers are ordinary Docker Compose projects, so `docker compose` commands work in the directory too.

**Removing a server** works the same way: stop it, then delete or move its directory out of `KITH_SERVERS_DIR`. There's no delete command in the app yet. The directory _is_ the server, so removing it removes the server. Backup repositories live separately under `KITH_BASE_BACKUP_DEST` and aren't touched.

## Requirements

- [Bun](https://bun.com) 1.4+ (Node.js is not supported)
- [Docker](https://www.docker.com/) with the Compose plugin

The user running kith needs permission to use Docker. Kith shells out to `docker` and `docker compose` for everything, so add yourself to the `docker` group (or run rootless Docker) before starting.

## Quick start

```bash
bun install -g @foopis23/kith
kith
```

The package is private and hosted on GitHub Packages. See [Installation](docs/installation.md) for registry setup, upgrading, and the two install models (per-user vs. global).

Out of the box kith is a per-user install. Everything lives under your home directory following the XDG Base Directory Specification, with nothing to configure. From the main screen, create a server, pick a modpack or a vanilla version, and start it.

## Usage

Everything happens inside the TUI:

- **Server list.** Live status and player counts for every server. Create, start, and stop servers from here.
- **Server details.** Stream logs, run console commands, edit memory, port, version, and modpack settings.
- **Backups.** Take snapshots on demand, browse snapshot history, restore to any snapshot.
- **Configure.** Per-server settings. Kith rewrites the server's `docker-compose.yml` on changes, preserving anything it doesn't manage.

Configuration is entirely through environment variables: directories, backups, ownership, file modes. See the [configuration reference](docs/configuration.md).

## Documentation

- [Installation](docs/installation.md): registry setup, per-user vs. global install, file ownership and permissions
- [Configuration reference](docs/configuration.md): every environment variable, its default, and what it does
- [Backups](docs/backups.md): enabling backups, schedules and retention, remote backends, restoring, security

## Patching mod configs

Modpack updates overwrite the config files in a server's data directory, wiping any tweaks you made by hand. Config patching solves this. Instead of editing a mod's config directly, you describe your changes as _patches_ that the server image re-applies to the actual config files every time the container starts. The modpack can update and regenerate its defaults as much as it wants. Your changes are re-applied on top, every time.

Every server kith creates ships with a `patches.json` next to its `docker-compose.yml` (in `KITH_SERVERS_DIR/<server id>/`), mounted into the container and wired up via `PATCH_DEFINITIONS`. It starts out as an empty patch set. Edit it on the host and restart the server to apply. If the file is deleted, kith recreates the empty patch set on the next start.

### Format

The file holds a patch set, a list of patch definitions. Each one names a target file (a path **inside the container**, so server files live under `/data`) and a list of operations:

```json
{
  "patches": [
    {
      "file": "/data/config/jei-server.toml",
      "ops": [
        {
          "$set": {
            "path": "$.general.enabled",
            "value": "false",
            "value-type": "bool"
          }
        }
      ]
    },
    {
      "file": "/data/server.properties",
      "ops": [
        {
          "$set": {
            "path": "$.view-distance",
            "value": 12
          }
        }
      ]
    }
  ]
}
```

Three operation types:

- `$set` sets the field at `path` (a JSON path like `$.general.difficulty`) to `value`.
- `$put` sets `key` on the object at `path`. Use this when the key contains characters a JSON path can't express, like dots or slashes.
- `$add` appends `value` to the array at `path`.

Typed configs (TOML, properties) only hold strings in JSON, so `value-type` converts them: `int`, `float`, `bool`, `auto`, or `list of int` / `list of float` / `list of bool` / `list of auto`. Values can also reference container environment variables with `${...}` placeholders. The target format is detected from the file's suffix. Add `"file-format": "json|json5|yaml|toml|properties"` to a patch to override it.

### Caveats

- **Patches apply at container start.** Editing `patches.json` does nothing until the server is restarted.
- **First boot of a fresh modpack skips patches for configs that don't exist yet.** The mod hasn't generated its config on the first start, so the patch is skipped with a warning in the container logs. Restart the server once and it applies.
- **The schema is strict.** An unknown key or a malformed patch fails the whole patch step and stops the container from starting. The reason will be in the server's logs, visible from kith's log view.

For the full reference, see the [itzg docs on patching existing files](https://docker-minecraft-server.readthedocs.io/en/latest/configuration/interpolating/#patching-existing-files).

## Known limitations

- **Java version is not re-resolved on auto-update.** Kith resolves the Java image tag when a server is created and whenever its version is changed from the server's Configure screen. For Modrinth servers tracking "latest", a pack update applied on restart can require a newer Java than the pinned tag provides. If the server fails to start after a pack update, re-apply the version in Configure or set the tag manually.
- **Paper, NeoForge, and Fabric are not supported yet.** Only Vanilla and Modrinth servers can be created.
- **No delete command in the app.** Removing a server means deleting its directory yourself. See [How it works](#how-it-works).
- **Compose files are rewritten on config changes.** Editing a server's settings from the Configure screen rewrites its `docker-compose.yml`. All data is preserved, including services and options kith doesn't manage, but YAML comments and formatting are lost.
- **The Java fallback table can go stale.** When Mojang's metadata is unreachable, Minecraft versions released after the table was written resolve to `latest` instead of a pinned tag.

## Development

```bash
bun install
bun start

bun run lint        # biome lint (with autofix)
bun run format      # biome format
bunx tsc --noEmit   # typecheck
```

### Publishing

`npm publish` compiles the TypeScript to `dist/` (`tsc`, via `prepublishOnly`)
and pushes it to GitHub Packages. Publishing needs a token with
`write:packages` in `~/.npmrc` (same `//npm.pkg.github.com/:_authToken` line
as above), and the repo's remote must point at the matching GitHub
repository. The package scope has to match the repo owner. Bump `version`
in `package.json` first.

```bash
npm publish
```
