# kith

A terminal UI for running Minecraft servers that are meant to *stay* running. Kith handles the upkeep: installing and updating modpacks, matching Java versions, keeping backups, re-applying your config tweaks after every pack update. It's built on the [itzg/minecraft-server](https://docker-minecraft-server.readthedocs.io/) image and wraps each server in a plain Docker Compose project.

## Requirements

- [Bun](https://bun.com) 1.4+ (Node.js is not supported)
- [Docker](https://www.docker.com/) with the Compose plugin

## Install

Kith is published to GitHub Packages as a private package. Point npm at the
GitHub registry for the package scope (in `~/.npmrc`):

```
@foopis23:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

The token needs the `read:packages` scope. Then:

```bash
bun install -g @foopis23/kith
kith
```

Upgrading is `bun install -g @foopis23/kith` again.

## Development setup

```bash
bun install
bun start
```

## Features

- **Modrinth modpacks without the manual labor.** Paste a modpack link and kith validates it, lists every published version with its loader and release channel, and installs it. Track "Latest release" and the pack updates itself on restart, stable releases only. Vanilla servers work too: pick any Minecraft release and go.
- **Config tweaks that survive modpack updates.** Updating a pack regenerates its config files and wipes your hand-made changes. Every kith server is wired up for patch definitions out of the box. Describe your tweaks once in `patches.json` and they're re-applied on every start. See [Patching mod configs](#patching-mod-configs).
- **The right Java, every time.** Each server gets a JVM matched to its Minecraft version. No "unsupported class file version" crashes after an update, no juggling JDK installs.
- **Backups you don't have to remember.** Snapshots run on a schedule with retention pruning, and you can take one on demand before doing anything risky. Restoring to any snapshot takes a few keystrokes. Backups live on local disk or off-site on S3, Backblaze B2, Azure, or GCS.
- **Every server on one screen.** Live status and player counts for all your servers. Start and stop them, watch logs stream by, run console commands, all without leaving the app.
- **Sensible defaults, nothing locked away.** Memory, port, version, and modpack are configurable per server from inside the app. Underneath, each server is a plain `docker-compose.yml` you can open and edit. Kith preserves anything it doesn't manage, so the escape hatch is always open.

## Patching mod configs

Modpack updates overwrite the config files in a server's data directory, wiping any tweaks you made by hand. Config patching solves this: instead of editing a mod's config directly, you describe your changes as *patches* that the server image re-applies to the actual config files every time the container starts. The modpack can update and regenerate its defaults as much as it wants — your changes are re-applied on top, every time.

Every server kith creates ships with a `patches.json` next to its `docker-compose.yml` (in `KITH_SERVERS_DIR/<server id>/`), mounted into the container and wired up via `PATCH_DEFINITIONS`. It starts out as an empty patch set; edit it on the host and restart the server to apply. If the file is deleted, kith recreates the empty patch set on the next start.

### Format

The file holds a patch set — a list of patch definitions, each naming a target file (a path **inside the container**, so server files live under `/data`) and a list of operations:

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

- **`$set`** — set the field at `path` (a JSON path like `$.general.difficulty`) to `value`.
- **`$put`** — set `key` on the object at `path`. Use this when the key contains characters a JSON path can't express (dots, slashes).
- **`$add`** — append `value` to the array at `path`.

Typed configs (TOML, properties) only hold strings in JSON, so `value-type` converts them: `int`, `float`, `bool`, `auto`, or `list of int` / `list of float` / `list of bool` / `list of auto`. Values can also reference container environment variables with `${...}` placeholders. The target format is detected from the file's suffix; add `"file-format": "json|json5|yaml|toml|properties"` to a patch to override it.

### Caveats

- **Patches apply at container start.** Editing `patches.json` does nothing until the server is restarted.
- **First boot of a fresh modpack skips patches for configs that don't exist yet.** The mod hasn't generated its config on the first start, so the patch is skipped with a warning in the container logs. Restart the server once and it applies.
- **The schema is strict.** An unknown key or a malformed patch fails the whole patch step and stops the container from starting — the reason will be in the server's logs (visible from kith's log view).

For the full reference, see the [itzg docs on patching existing files](https://docker-minecraft-server.readthedocs.io/en/latest/configuration/interpolating/#patching-existing-files).

## Configuration

Kith reads its configuration from environment variables:

| Variable                | Default                  | Description                                             |
| ----------------------- | ------------------------ | ------------------------------------------------------- |
| `KITH_SERVERS_DIR`      | `/var/kith/servers`      | Where server compose projects and data live             |
| `KITH_BASE_BACKUP_DEST` | _(unset — disables backups)_ | Base directory for backup repositories             |
| `KITH_LOG_DIR`          | `/var/kith/logs`         | Application log directory                               |
| `KITH_TMP_FILE_DIR`     | `$TMPDIR/kith`           | Cache directory (version manifests, Java version cache) |
| `KITH_UID`              | _(your uid)_             | Numeric user id that owns created files; containers run as it |
| `KITH_GID`              | _(your gid)_             | Numeric group id that owns created files; containers run as it |
| `KITH_SECRET_FILE_MODE` | `660`                    | Octal mode for files carrying secrets (compose files, password scratch) |

Backups run on the configured schedule only (`KITH_BACKUP_INTERVAL`, or `KITH_BACKUP_CRON_SCHEDULE` for clock-based timing) — starting a server does not trigger a backup, so frequently started and stopped servers don't pile up snapshots. The first backup lands one interval after the server starts.

## File ownership and permissions

Everything kith creates — server directories, compose files, logs — is owned by `KITH_UID:KITH_GID` (defaulting to the invoking user) and group-accessible: directories are `2770` (setgid, so the group propagates to anything created inside them later) and files are `0660`, including files carrying secrets (compose files with backup credentials, password scratch files). The default modes assume the primary install model — a shared group whose members all manage the servers — so group members get write access to everything. For a per-user install, set `KITH_SECRET_FILE_MODE` to `600` (owner-only) or `640` (group-read-only) to keep backup credentials to yourself.

The same ids are passed to the containers: the `itzg/minecraft-server` image re-maps its internal `minecraft` user to `KITH_UID`/`KITH_GID` at startup and `chown`s `/data` to match, and the backup sidecar runs as `KITH_UID:KITH_GID` directly. Files the containers write into the bind-mounted data and backup directories therefore show up on the host with the same ownership as files kith writes itself — no permission drift between the two.

### Shared multi-user setup

To let several host users manage the same servers, put them in a shared group and point kith at it:

```bash
sudo groupadd minecraft
sudo usermod -aG minecraft alice
sudo usermod -aG minecraft bob
sudo mkdir -p /var/kith/{servers,logs}
sudo chown root:minecraft /var/kith/{servers,logs}
```

Then every user runs kith with `KITH_GID` set to the group's id (`getent group minecraft`):

```bash
export KITH_GID=1001   # the minecraft group's gid
kith
```

The setgid bit on the directories keeps new files in the `minecraft` group no matter who (or which container) creates them, and the group-read/write modes let any member manage any server. Each user's files are owned by their own uid — `KITH_UID` defaults to whoever is running — so the world files show `alice:minecraft`, `bob:minecraft`, and so on.

One caveat: **only one kith instance can manage a servers directory at a time.** Kith takes a lock (`$KITH_SERVERS_DIR/.kith.lock`) at startup and refuses to start if another instance holds it, so two admins can't race each other on compose rewrites and port allocation. If kith crashes without releasing the lock, the next start detects the stale lock and reclaims it automatically.

## Security

Kith stores backup secrets — the restic repository password and any cloud backend credentials (AWS, B2, Azure, GCS) — in **plaintext in each server's `docker-compose.yml`**. The compose file's mode is `KITH_SECRET_FILE_MODE` (`0660` by default — group-writable, matching the shared-group install model), but anyone who can read it holds those credentials, and anyone who can run `docker` on the host can extract them from the sidecar container's config regardless of file permissions.

Practical guidance:

- **Single-user machine (typical homelab).** The defaults are fine. Run kith as your own user, keep the config dirs in your home or under `/var` owned by you, and don't stress about it — the threat model is "someone with a shell on this box," and at that point the machine is already theirs.
- **Shared / multi-user host.** Run kith under a dedicated user, and make sure only that user can read the config dirs:
  ```bash
  sudo useradd -r -m -d /var/lib/kith kith
  sudo mkdir -p /var/kith/{servers,backups,logs}
  sudo chown -R kith:kith /var/kith
  sudo chmod 700 /var/kith/backups
  ```
  Note that "dedicated user" only meaningfully separates you from *other unprivileged users*. Anyone in the `docker` group is effectively root on the host — group-based access to docker is not a security boundary.
- **Server-wide, multiple admins.** Use a shared group (e.g. `minecraft`) with `KITH_GID` pointed at it — see [File ownership and permissions](#file-ownership-and-permissions). Kith's files are group-accessible and its directories setgid, so any group member can manage any server. Treat group membership as the admin boundary: a member can manage every server, and can read the backup credentials in the compose files (or pull them from the sidecar with `docker inspect`). Only add people you'd trust with both. Note that anyone in the `docker` group is effectively root on the host regardless — group-based access to docker is not a security boundary.
- **Use least-privilege backup credentials.** The cloud credentials kith forwards to the backup sidecar should be scoped to backups only: an IAM user limited to the backup bucket, a B2 *application key* (never the master key), an Azure SAS limited to the backup container. If they leak, the blast radius is your backup storage, not your cloud account.
- **Don't reuse the restic password.** The restic password alone can't reach a remote repo (restic doesn't store backend credentials), but if you've reused it anywhere else, it just became a credential for those systems too.

## Known limitations

- **Java version is not re-resolved on auto-update.** Kith resolves the Java image tag when a server is created and whenever its version is changed from the server's Configure screen. For Modrinth servers tracking "latest", a pack update applied on restart can require a newer Java than the pinned tag provides; if the server fails to start after a pack update, re-apply the version in Configure (or set the tag manually).
- **Paper, NeoForge, and Fabric are not supported yet.** Only Vanilla and Modrinth servers can be created.
- **Compose files are rewritten on config changes.** Editing a server's settings from the Configure screen rewrites its `docker-compose.yml`. All data is preserved — including services and options kith doesn't manage — but YAML comments and formatting are lost.
- **The Java fallback table can go stale.** When Mojang's metadata is unreachable, Minecraft versions released after the table was written resolve to `latest` instead of a pinned tag.

## Development

```bash
bun run lint        # biome lint (with autofix)
bun run format      # biome format
bunx tsc --noEmit   # typecheck
```

### Publishing

`npm publish` compiles the TypeScript to `dist/` (`tsc`, via `prepublishOnly`)
and pushes it to GitHub Packages. Publishing needs a token with
`write:packages` in `~/.npmrc` (same `//npm.pkg.github.com/:_authToken` line
as above) and the repo's remote must point at the matching GitHub
repository — the package scope has to match the repo owner. Bump `version`
in `package.json` first.

```bash
npm publish
```
