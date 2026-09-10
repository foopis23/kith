# Patching mod configs

Modpack updates overwrite the config files in a server's data directory, wiping any tweaks you made by hand. Config patching solves this. Instead of editing a mod's config directly, you describe your changes as _patches_ that the server image re-applies to the actual config files every time the container starts. The modpack can update and regenerate its defaults as much as it wants. Your changes are re-applied on top, every time.

Every server kith creates ships with a `patches.json` next to its `docker-compose.yml` (in `KITH_SERVERS_DIR/<server id>/`), mounted into the container and wired up via `PATCH_DEFINITIONS`. It starts out as an empty patch set. Edit it on the host and restart the server to apply. If the file is deleted, kith recreates the empty patch set on the next start.

## Format

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

## Caveats

- **Patches apply at container start.** Editing `patches.json` does nothing until the server is restarted.
- **First boot of a fresh modpack skips patches for configs that don't exist yet.** The mod hasn't generated its config on the first start, so the patch is skipped with a warning in the container logs. Restart the server once and it applies.
- **The schema is strict.** An unknown key or a malformed patch fails the whole patch step and stops the container from starting. The reason will be in the server's logs, visible from kith's log view.

For the full reference, see the [itzg docs on patching existing files](https://docker-minecraft-server.readthedocs.io/en/latest/configuration/interpolating/#patching-existing-files).
