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
  - title: Modpack Management
    details: Paste a modpack link and kith validates it, lists every published version, and installs it. Track "Latest release" and the pack updates itself on restart. Vanilla servers work too.
  - title: Config Patching
    details: Describe your tweaks once in patches.json and they're re-applied on every start, even after a modpack update regenerates its configs.
  - title: Java Version Matching
    details: Each server gets a JVM matched to its Minecraft version. No "unsupported class file version" crashes, no juggling JDK installs.
  - title: Automatic Backups
    details: Scheduled snapshots with retention pruning, on-demand snapshots, and one-screen restores. Local disk or off-site on S3, B2, Azure, or GCS.
  - title: Unified Dashboard
    details: Live status and player counts for all your servers. Start and stop them, watch logs stream by, run console commands, all without leaving the app.
  - title: Plain Docker Compose
    details: Each server is a plain docker-compose.yml and a data directory. Kith preserves anything it doesn't manage, so the escape hatch is always open.
---

::: warning Pre-release
Kith is under active development. Configuration formats, behavior, and on-disk layouts can change between releases, and mistakes can break your servers. Back up anything you can't afford to lose before upgrading or changing global settings.
:::
