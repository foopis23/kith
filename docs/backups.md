# Backups

Kith backs servers up with [restic](https://restic.net/), running in a sidecar container alongside each server via the itzg mc-backup image. Snapshots are deduplicated, incremental, and encrypted. Restoring to any snapshot takes a few keystrokes from the server's screen in the app.

Backups are opt-in globally. Nothing is backed up until you set a destination.

## Enabling backups

Two variables turn backups on:

```bash
export KITH_BASE_BACKUP_DEST=/var/backups/kith   # or a restic URL, see below
export KITH_BACKUP_PASSWORD='a-long-random-password'
```

- `KITH_BASE_BACKUP_DEST` sets where repositories live. Each server gets its own repository at `<dest>/<server id>`. A plain path is a local directory. A URL with a scheme prefix (`s3:`, `b2:`, `azure:`, `gs:`, `rclone:`) is a remote restic repository.
- `KITH_BACKUP_PASSWORD` is the password every repository is encrypted with. Required when a destination is set, and kith refuses to start without it. Don't reuse this password anywhere else.

Servers created after this is set get a backup sidecar automatically. For existing servers, kith detects that the global backup config changed and offers to migrate them, including moving an existing repository's history to the new destination.

## Schedule and retention

Backups run on the configured schedule only. Starting a server does not trigger a backup, so frequently started and stopped servers don't pile up snapshots. The first backup lands one interval after the server starts.

| Variable                      | Default   | Description                                     |
| ----------------------------- | --------- | ----------------------------------------------- |
| `KITH_BACKUP_INTERVAL`        | `24h`     | Snapshot interval (sleep format, for example `2h 30m`). |
| `KITH_BACKUP_CRON_SCHEDULE`   | _(unset)_ | Cron expression (for example `0 4 * * *`). Overrides the interval for clock-based timing. |
| `KITH_BACKUP_PRUNE_RETENTION` | _(unset)_ | Restic retention policy (for example `--keep-within 7d`). Unset keeps every snapshot. |

You can also take a snapshot on demand from the app's backup screen, useful before doing anything risky. Individual servers can opt out of backups entirely.

## Remote backends

Point `KITH_BASE_BACKUP_DEST` at a restic URL and export the matching credentials. Kith forwards them to the backup sidecar:

```bash
# S3
export KITH_BASE_BACKUP_DEST=s3:s3.amazonaws.com/my-backup-bucket
export AWS_ACCESS_KEY_ID=…
export AWS_SECRET_ACCESS_KEY=…

# Backblaze B2
export KITH_BASE_BACKUP_DEST=b2:my-backup-bucket
export B2_ACCOUNT_ID=…
export B2_ACCOUNT_KEY=…
```

Azure (`azure:`) and Google Cloud (`gs:`) work the same way. See the [configuration reference](configuration.md#cloud-credentials) for the full variable list per backend.

Scope cloud credentials to backups only: an IAM user limited to the backup bucket, a B2 _application key_ (never the master key), an Azure SAS limited to the backup container. If they leak, the blast radius is your backup storage, not your cloud account.

## Restoring

Restore from the server's backup screen in the app. Pick a snapshot and kith rolls the server's data directory back to exactly that state. A restore can't run while the server is up, so stop it first.

## Security

Backup secrets (the restic password and any cloud credentials) are stored **in plaintext in each server's `docker-compose.yml`**. Anyone who can read that file holds the credentials, and anyone who can run `docker` on the host can extract them from the sidecar container's config regardless of file permissions. Practical guidance:

- **Per-user install.** Nothing to do. Compose files default to mode `600`, readable by you alone.
- **Global install.** Set `KITH_SECRET_FILE_MODE=660` so group members can read the compose files, and treat group membership as the admin boundary. Only add people you'd trust with the credentials.
- Anyone in the `docker` group is effectively root on the host regardless. Group-based access to docker is not a security boundary.
