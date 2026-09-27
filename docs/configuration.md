# Configuration reference

Kith is configured entirely through environment variables. See [Installation](installation.md) for which ones matter per install model. This page lists them all.

## Directories

| Variable            | Default                  | Description                                             |
| ------------------- | ------------------------ | ------------------------------------------------------- |
| `KITH_SERVERS_DIR`  | `$XDG_DATA_HOME/kith/servers` (`~/.local/share/kith/servers`) | Where server compose projects and world data live. Each server gets a subdirectory holding its `docker-compose.yml`, `patches.json`, and `data/` volume. |
| `KITH_LOG_DIR`      | `$XDG_STATE_HOME/kith/logs` (`~/.local/state/kith/logs`) | Application log directory. Kith writes `kith.log` here and rolls it daily into `kith.<yyyy.MM.dd>.log` files, keeping the last 90 and deleting older ones. |
| `KITH_CACHE_DIR`    | `$XDG_CACHE_HOME/kith` (`~/.cache/kith`) | Download cache for version manifests and Java version and image-tag lookups. Everything in it is re-downloaded when missing or stale, so deleting it is always safe. |
| `KITH_TMP_FILE_DIR` | `$TMPDIR/kith`           | Scratch space for genuinely temporary files (backup-migration password files). On the OS tmp dir, so it's wiped on reboot. |

The XDG variables follow the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/). Set `XDG_DATA_HOME`, `XDG_STATE_HOME`, or `XDG_CACHE_HOME` to move all of kith's directories at once, or set the `KITH_*` variables individually to override specific ones.

Kith creates every directory it references at startup if missing. If a directory can't be created or written, kith exits with an error naming the variable to fix.

## Backups

| Variable                    | Default                  | Description                                             |
| --------------------------- | ------------------------ | ------------------------------------------------------- |
| `KITH_BASE_BACKUP_DEST`     | _(unset, backups disabled)_ | Base location for backup repositories. A local directory or a restic repository URL prefix (`s3:`, `b2:`, `rclone:`, and so on). Each server's repo lives at `<dest>/<server id>`. See [Backups](backups.md). |
| `KITH_BACKUP_PASSWORD`      | _(unset)_                | Global restic repository password. Required when `KITH_BASE_BACKUP_DEST` is set. Kith refuses to start without it. |
| `KITH_BACKUP_INTERVAL`      | `24h`                    | How often each server's backup sidecar takes a snapshot (sleep format, for example `24h` or `2h 30m`). |
| `KITH_BACKUP_CRON_SCHEDULE` | _(unset)_                | Cron expression for clock-based backup timing (for example `0 4 * * *`). Overrides `KITH_BACKUP_INTERVAL` inside the sidecar. |
| `KITH_BACKUP_PRUNE_RETENTION` | _(unset)_              | Restic retention policy applied when pruning (for example `--keep-within 7d`). Unset keeps every snapshot. |

### Cloud credentials

When `KITH_BASE_BACKUP_DEST` points at a remote backend, kith forwards the matching credential variables to the backup sidecar:

| Backend      | Variables                                                                 |
| ------------ | ------------------------------------------------------------------------- |
| AWS S3       | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                              |
| Backblaze B2 | `B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY`                                         |
| Azure        | `AZURE_ACCOUNT_NAME`, plus one of `AZURE_ACCOUNT_KEY`, `AZURE_ACCOUNT_SAS`, `AZURE_FORCE_CLI_CREDENTIAL`. Optionally `AZURE_ENDPOINT_SUFFIX`. |
| Google Cloud | `GOOGLE_PROJECT_ID`, plus one of `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_ACCESS_TOKEN` |

Each of these also has a `KITH_`-prefixed override (for example `KITH_AWS_ACCESS_KEY_ID`, `KITH_B2_ACCOUNT_KEY`) that takes precedence when both are set. Use the prefixed form when your shell or host already exports cloud credentials for other tools and you want kith's backups to use a different set.

Scope these to backups only: an IAM user limited to the backup bucket, a B2 _application key_ (never the master key), an Azure SAS limited to the backup container.

## Ownership and file modes

| Variable                | Default      | Description                                             |
| ----------------------- | ------------ | ------------------------------------------------------- |
| `KITH_UID`              | _(your uid)_ | Numeric user id that owns every file and directory kith creates. The containers run as it too. |
| `KITH_GID`              | _(your gid)_ | Numeric group id that owns created files. The containers run as it. Set to the shared group's id for a [global install](installation.md#global-install). |
| `KITH_SECRET_FILE_MODE` | `600`        | Octal mode for files carrying secrets (compose files with backup credentials, password scratch files). Set to `660` or `640` on a global install so group members can read them. |

Both ids are numeric, not names, so they're unambiguous on the host and inside containers. Kith applies the setgid bit to directories it creates so the group propagates to anything created inside them later. See [File ownership and permissions](installation.md#file-ownership-and-permissions).

## Servers

| Variable          | Default       | Description                                             |
| ----------------- | ------------- | ------------------------------------------------------- |
| `KITH_PORT_RANGE` | `25565-25665` | Host ports kith allocates game ports from, in `min-max` form. New servers (and servers whose port is unset) get the first port in the range that no other managed server is using and that is free on the host. Creating a server fails if no port in the range is available. |

## Other

| Variable | Default   | Description                               |
| -------- | --------- | ----------------------------------------- |
| `DEBUG`  | _(unset)_ | Set to any value for debug-level logging to `kith.log`. |
