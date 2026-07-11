import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Sentinel',
  tagline: 'Decentralized parametric insurance on Stellar',
  favicon: 'favicon.ico',

  future: {
    v4: true,
  },

  // Production URL of the docs site.
  // When switching to a custom domain, change url to the domain
  // and baseUrl to '/'.
  url: 'https://sentinelfi.github.io',
  baseUrl: '/sentinel_soroban_v3/',

  organizationName: 'SentinelFi',
  projectName: 'sentinel_soroban_v3',

  onBrokenLinks: 'throw',

  markdown: {
    mermaid: true,
  },
  themes: ['@docusaurus/theme-mermaid'],

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl:
            'https://github.com/SentinelFi/sentinel_soroban_v3/tree/main/docs/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/sentinelBanner.png',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Sentinel',
      logo: {
        alt: 'Sentinel logo',
        src: 'img/sentinelLogo.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Documentation',
        },
        {
          href: 'https://github.com/SentinelFi',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Documentation',
          items: [
            {
              label: 'Introduction',
              to: '/docs/intro',
            },
            {
              label: 'Smart Contracts',
              to: '/docs/contracts/overview',
            },
            {
              label: 'Developers',
              to: '/docs/developers/build-and-test',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'X (Twitter)',
              href: 'https://x.com/sentinel_fi/',
            },
            {
              label: 'Medium',
              href: 'https://medium.com/@sentineldefi/',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/SentinelFi',
            },
            {
              label: 'Stellar',
              href: 'https://stellar.org',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} SentinelFi. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['rust', 'bash', 'toml', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
