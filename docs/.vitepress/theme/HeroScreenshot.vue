<script setup lang="ts">
// Imported as a bundled asset so VitePress resolves the URL (and the /kith/
// base path) correctly in the production build. A plain path in the hero
// frontmatter would be emitted as-is and 404 once deployed.
import src from '../../screenshots/kith-home-screen.png'
</script>

<template>
  <img
    :src="src"
    alt="Kith's server list showing offline, starting, and online servers"
    class="hero-screenshot"
  />
</template>
