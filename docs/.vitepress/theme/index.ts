import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import HeroScreenshot from './HeroScreenshot.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      // Replace the hero's <img> with one whose src is a bundled asset.
      // The frontmatter `image:` stays set so the hero renders its image
      // container (and the has-image class the CSS hooks into), but this
      // slot's content is what actually renders inside it.
      'home-hero-image': () => h(HeroScreenshot)
    })
  }
}
