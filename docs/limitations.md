# Known limitations

- **Java version is not re-resolved on auto-update.** Kith resolves the Java image tag when a server is created and whenever its version is changed from the server's Configure screen. For Modrinth servers tracking "latest", a pack update applied on restart can require a newer Java than the pinned tag provides. If the server fails to start after a pack update, re-apply the version in Configure or set the tag manually.
- **Paper, NeoForge, and Fabric are not supported yet.** Only Vanilla and Modrinth servers can be created.
- **No delete command in the app.** Removing a server means deleting its directory yourself. See [How it works](usage.md#how-it-works).
- **Compose files are rewritten on config changes.** Editing a server's settings from the Configure screen rewrites its `docker-compose.yml`. All data is preserved, including services and options kith doesn't manage, but YAML comments and formatting are lost.
- **The Java fallback table can go stale.** When Mojang's metadata is unreachable, Minecraft versions released after the table was written resolve to `latest` instead of a pinned tag.
