---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "Kith"
  # Required so the hero renders its image container, but the actual <img>
  # comes from the home-hero-image slot (docs/.vitepress/theme/), which
  # bundles the screenshot so the URL resolves in the production build.
  image: ./screenshots/kith-home-screen.png
  tagline: A terminal UI for running Minecraft servers on the itzg/minecraft-server image. Modpacks, Java, backups, and config patches handled.
  actions:
    - theme: brand
      text: Get Started
      link: /installation
    - theme: alt
      text: View on GitHub
      link: https://github.com/foopis23/kith

features:
  - title: Modpack Installation
    details: Paste a modpack link, select a version, and kith will do the rest. Track "Latest release" and the pack updates itself on restart.
  - title: Config Patching
    details: Describe your config changes once in patches.json. They won't be overwritten by pack updates.
  - title: Java Version Matching
    details: Each server gets a JVM matched to its Minecraft version. No "unsupported class file version" crashes, no juggling JDK installs.
  - title: Automatic Backups
    details: Schedule backups with retention polices. Restores are a simple click of a button. Backups can be stored on local disk or off-site on S3, B2, Azure, or GCS.
  - title: Unified Dashboard
    details: See status and player counts for all your servers at a glance. Manage ports, memory, versions. Send console commands. All without leaving the app.
  - title: Plain Docker Compose
    details: Each server is a plain docker-compose.yml and a data directory. Kith preserves anything it doesn't manage, so the escape hatch is always open.
---

::: warning Pre-release
Kith is under active development. Configuration formats, behavior, and on-disk layouts can change between releases, and a future update could lose your data or leave your servers unusable with kith. Back up anything you can't afford to lose before upgrading or changing global settings.
:::
