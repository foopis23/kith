# Why kith?

Server panels promise to simplify server management, but every one I tried was missing something I needed. One did everything but back up Minecraft worlds. Another did everything except install or update modpacks. I even tried forking one to add the feature I wanted, and it turned out to be a lot more work than just adding the feature. Web panels just weren't that helpful to me in practice, so I went looking for something simpler and more direct.

That landed me on the [itzg/minecraft-server](https://docker-minecraft-server.readthedocs.io/) image, which already does almost everything a Minecraft server needs: modpack installs and updates, config patching, automated backups. What I didn't enjoy was setting up and maintaining Docker Compose stacks for all my servers by hand. I actually like Docker, but I wanted all of this at a level where I manage the servers directly, without keeping every detail of the Compose setup in my head.

## Who is kith for

Kith is for the hobbyist homelab and Minecraft server admin. You probably run a handful of servers, off and on, as the two-week Minecraft phase comes back around. It's not meant for large-scale or enterprise deployments on Kubernetes. But it's not a plug-and-play solution like Realms either. You get control and flexibility without the repetitive work of maintaining multiple Docker Compose projects.

## What kith is not

- **Not a server panel.** There's no daemon, no database, no web UI. Kith is a terminal app that reads and writes the same files you would.
- **Not a lock-in.** Remove kith and your servers keep running. They're plain Docker Compose projects, so `docker compose` commands work in their directories without kith installed at all.
