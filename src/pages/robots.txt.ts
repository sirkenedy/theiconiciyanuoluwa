import type { APIRoute } from 'astro';

export const prerender = true;

export const GET: APIRoute = ({ site }) =>
  new Response(['User-agent: *', 'Allow: /', 'Disallow: /api/', '', `Sitemap: ${new URL('sitemap-index.xml', site)}`, ''].join('\n'), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
