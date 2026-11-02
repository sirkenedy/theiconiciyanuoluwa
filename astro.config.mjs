import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';

// The API routes read secrets from process.env (that's where Vercel puts them). `astro dev` only exposes .env through
// import.meta.env, so load it into process.env here for local runs. Variables already set are never overridden.
try {
  process.loadEnvFile('.env');
} catch {}

// Production origin for canonical URLs, Open Graph, JSON-LD and the sitemap. Override with SITE_URL in Vercel if the domain differs.
const site = process.env.SITE_URL ?? 'https://theiconiciyanuoluwa.com';

export default defineConfig({
  site,
  output: 'static',
  integrations: [preact(), sitemap({ filter: (page) => !/\/404\/?$/.test(page) })],
  // Tailoring takes ~30–50 s and a live job search (several job APIs, then ranking) can take longer. With Fluid Compute
  // (on by default for Vercel projects) the Hobby plan allows up to 300 s; each route still has its own tighter budget.
  adapter: vercel({
    maxDuration: 300,
    webAnalytics: {
      enabled: true,
    },
  }),
  build: { inlineStylesheets: 'always' },
  devToolbar: { enabled: false },
  // Dev only. Vite pre-bundles dependencies it finds by crawling from the pages; libraries that only lazy code imports
  // (the chat island, /career) were found mid-session instead, re-bundled, and open tabs then got
  // "504 Outdated Optimize Dep" (chat button missing, "couldn't open that file"). Crawl all browser code at startup
  // and name the lazy libraries, so the bundle is complete before the first page loads.
  vite: {
    ...(process.env.VITE_CACHE_DIR ? { cacheDir: process.env.VITE_CACHE_DIR } : {}),
    optimizeDeps: {
      entries: ['src/islands/**/*.{ts,tsx}'],
      include: ['preact', 'preact/hooks', 'preact/jsx-dev-runtime', 'pdfjs-dist', 'mammoth', 'docx', 'pdf-lib', 'dompurify'],
    },
  },
});
