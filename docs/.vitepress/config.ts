import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Kith',
  description: 'A terminal UI for running persistent containerized Minecraft servers',
  // Repo project page: https://foopis23.github.io/kith/
  base: '/kith/',
  cleanUrls: true,

  // Inject a pre-release notice at the top of every page body. The home
  // page carries its own warning block outside the hero, so it's skipped.
  markdown: {
    config(md) {
      const notice = '::: warning Pre-release\nKith is under active development. Formats and behavior can change between releases, and mistakes can break your servers. Back up anything you can\'t afford to lose.\n:::'
      const defaultRender = md.render.bind(md)
      md.render = (src, env) => {
        const isHome = env?.path?.endsWith('index.md')
        return defaultRender(isHome ? src : `${notice}\n\n${src}`, env)
      }
    }
  },
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Why kith?', link: '/why' },
      { text: 'Installation', link: '/installation' },
      { text: 'Configuration', link: '/configuration' },
      { text: 'Backups', link: '/backups' }
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Why kith?', link: '/why' },
          { text: 'Installation', link: '/installation' }
        ]
      },
      {
        text: 'Guide',
        items: [
          { text: 'Usage', link: '/usage' },
          { text: 'Backups', link: '/backups' },
          { text: 'Patching Mod Configs', link: '/patching' },
          { text: 'Known Limitations', link: '/limitations' }
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/configuration' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/foopis23/kith' }
    ],

    editLink: {
      pattern: 'https://github.com/foopis23/kith/edit/main/docs/:path',
      text: 'Edit this page on GitHub'
    },

    search: {
      provider: 'local'
    }
  }
})
