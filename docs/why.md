# Why kith?

The [itzg/minecraft-server](https://docker-minecraft-server.readthedocs.io/) image already does almost everything a Minecraft server needs: modpack installs and updates, Java version matching, config patching, automated backups. But you only create a new server every few months, so each one starts the same way: back to the image's docs to re-learn how the compose file goes together and which environment variables do what.

Server panels solve the remembering, but replace your files with their own abstractions and databases. Kith takes a different path. It's a thin layer on top of the Docker image. It knows the image's knobs so you don't have to. Paste a modpack link, pick a version, set a backup destination. When you need to go deeper, each server is still an ordinary `docker-compose.yml` and a data directory you can open and edit by hand. Kith does the simple things fast and stays out of the way when you want to get involved.

## What kith is not

- **Not a server panel.** There's no daemon, no database, no web UI. Kith is a terminal app that reads and writes the same files you would.
- **Not a wrapper around your files.** The directory _is_ the server. Stop kith, edit anything by hand, start it again. Nothing breaks.
- **Not a lock-in.** Remove kith and your servers keep running. They're plain Docker Compose projects; `docker compose` commands work in their directories without kith installed at all.
