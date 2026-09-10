# Installation

## Requirements

- [Bun](https://bun.com) 1.4+ (Node.js is not supported)
- [Docker](https://www.docker.com/) with the Compose plugin

The user running kith needs permission to use Docker. Kith shells out to `docker` and `docker compose` for everything, so add yourself to the `docker` group (or run rootless Docker) before starting.

Kith is configured entirely through environment variables, and how you install determines which ones you need to set. There are two models:

- **Per-user install (default).** Kith follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/). Everything lives under the invoking user's home directory, with nothing to configure.
- **Global install.** One shared kith for the whole machine, managed by a Unix group. You point the directories at system locations (`/var/lib`, `/var/log`, and so on) and set `KITH_GID` to the managing group.

## Installing the package

Kith is published to GitHub Packages. Point npm at the GitHub registry for the package scope (in `~/.npmrc`):

```
@foopis23:registry=https://npm.pkg.github.com
```

Then:

```bash
bun install -g @foopis23/kith
kith
```

Upgrading is `bun install -g @foopis23/kith` again.

## Per-user install

This is the default and needs no setup. Kith resolves its directories from the XDG environment variables, falling back to the spec's defaults under your home directory:

- Servers and world data: `$XDG_DATA_HOME/kith/servers`, default `~/.local/share/kith/servers`
- Logs: `$XDG_STATE_HOME/kith/logs`, default `~/.local/state/kith/logs`
- Cache: `$XDG_CACHE_HOME/kith`, default `~/.cache/kith`
- Scratch files: `$TMPDIR/kith`, wiped on reboot

Files are owned by you (`KITH_UID`/`KITH_GID` default to your ids), and files carrying secrets (compose files with backup credentials, password scratch files) default to mode `600`, readable by you alone. Nothing to configure.

## Global install

For one kith shared by several admins, a dedicated Unix group is the admin boundary. The directories live at system locations, and group membership plus file permissions do the rest.

Recommended layout, following the [Filesystem Hierarchy Standard](https://refspecs.linuxfoundation.org/FHS_3.0/fhs/index.html):

| Env var                 | Path                    | Used for                                |
| ----------------------- | ----------------------- | --------------------------------------- |
| `KITH_SERVERS_DIR`      | `/var/lib/kith/servers` | Server compose projects and world data  |
| `KITH_LOG_DIR`          | `/var/log/kith`         | Application logs                        |
| `KITH_BASE_BACKUP_DEST` | `/var/backups/kith`     | Backup repositories                     |
| `KITH_CACHE_DIR`        | `/var/cache/kith`       | Cache (version manifests, Java lookups) |

Leave `KITH_TMP_FILE_DIR` at its default (`$TMPDIR/kith`). Scratch files are short-lived, and the OS tmp dir's wipe-on-reboot behavior suits them.

Set it up as root:

```bash
# 1. Create the managing group and add your admins. They also need
#    permission to use Docker, since kith shells out to docker compose.
sudo groupadd kith
sudo usermod -aG kith alice
sudo usermod -aG kith bob
sudo usermod -aG docker alice
sudo usermod -aG docker bob

# 2. Create the directories, owned by the group. The setgid bit (2770)
#    makes anything created inside inherit the kith group.
sudo install -d -o root -g kith -m 2770 \
  /var/lib/kith/servers /var/log/kith /var/backups/kith /var/cache/kith
```

Be aware that `docker` group membership is effectively root on the host, since a docker socket lets you mount anything into a privileged container. Only add people you already trust as admins.

Then configure kith's environment. The variables live in their own file, locked down so only group members can read them. A profile snippet sources it for members only. This keeps the values out of world-readable profile files, which matters once backup credentials join the list.

```bash
# 3. Create the environment file, readable only by root and the kith group.
sudo install -m 0640 -o root -g kith /dev/null /etc/kith/env
```

Put the configuration in `/etc/kith/env`:

```bash
# /etc/kith/env: kith configuration, sourced for kith group members only.
export KITH_SERVERS_DIR=/var/lib/kith/servers
export KITH_LOG_DIR=/var/log/kith
export KITH_BASE_BACKUP_DEST=/var/backups/kith
export KITH_CACHE_DIR=/var/cache/kith
export KITH_GID=$(getent group kith | cut -d: -f3)
# Secret-bearing files (compose files hold backup credentials) must be
# group-readable so every member can manage every server.
export KITH_SECRET_FILE_MODE=660
```

Then add the sourcing logic to `/etc/profile` (or drop a file in `/etc/profile.d/`):

```bash
# Only members of the kith group get kith's configuration.
if id -nG | grep -qw kith; then
  . /etc/kith/env
fi
```

Non-members can't read `/etc/kith/env` (mode `0640`, group `kith`), so the paths and any credentials stay invisible to other users on the machine.

Members log in again and run `kith`. The setgid directories keep new files in the `kith` group no matter who or which container creates them, and the group-read/write modes let any member manage any server. Each member's files are owned by their own uid (`KITH_UID` defaults to whoever is running), so world files show `alice:kith`, `bob:kith`, and so on.

One caveat: **only one kith instance can manage a servers directory at a time.** Kith takes a lock (`$KITH_SERVERS_DIR/.kith.lock`) at startup and refuses to start if another instance holds it, so two admins can't race each other on compose rewrites and port allocation. If kith crashes without releasing the lock, the next start detects the stale lock and reclaims it.

## File ownership and permissions

Everything kith creates (server directories, compose files, logs) is owned by `KITH_UID:KITH_GID`, defaulting to the invoking user, and is group-accessible. Directories are `2770` (setgid, so the group propagates to anything created inside them later) and files are `0660`. Files carrying secrets (compose files with backup credentials, password scratch files) are the exception: they default to `0600`, owner-only, matching the per-user install model. On a global install, set `KITH_SECRET_FILE_MODE` to `660` (group read/write) or `640` (group read-only) so every member can manage every server.

The same ids are passed to the containers. The `itzg/minecraft-server` image re-maps its internal `minecraft` user to `KITH_UID`/`KITH_GID` at startup and `chown`s `/data` to match, and the backup sidecar runs as `KITH_UID:KITH_GID` directly. Files the containers write into the bind-mounted data and backup directories show up on the host with the same ownership as files kith writes itself, so there's no permission drift between the two.
