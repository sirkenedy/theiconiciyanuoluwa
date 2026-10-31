import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';

// Production origin for canonical URLs, Open Graph, JSON-LD and the sitemap. Override with SITE_URL in Vercel if the domain differs.
const site = process.env.SITE_URL ?? 'https://theiconiciyanuoluwa.com';

export default defineConfig({
  site,
  output: 'static',
  integrations: [preact(), sitemap({ filter: (page) => !/\/404\/?$/.test(page) })],
  // The twin's upstream timeout is 15s; the function gets headroom beyond it.
  adapter: vercel({ maxDuration: 30 }),
  build: { inlineStylesheets: 'always' },
  devToolbar: { enabled: false },
});
