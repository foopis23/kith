import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Kith',
  description: 'A terminal UI for running persistent containerized Minecraft servers',
  // Repo project page: https://foopis23.github.io/kith/
  base: '/kith/',
  cleanUrls: true,
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
          { text: 'Patching Mod Configs', link: '/patching' },
          { text: 'Known Limitations', link: '/limitations' }
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/configuration' },
          { text: 'Backups', link: '/backups' }
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
