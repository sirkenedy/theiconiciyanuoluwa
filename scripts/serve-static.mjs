// Serves the Vercel static output with CDN-like compression and caching, since `astro preview`
// isn't supported by @astrojs/vercel. Used by `npm run preview`, Lighthouse and Playwright.
// /api/react and /api/twin answer as a deployment without Redis or an API key; use `npm run dev` for the real routes.
// Career Coach (/career, /api/device/*, /api/career/*) runs through the built Vercel function itself, so its CSP
// headers and request signing are tested as deployed (point UPSTASH_REDIS_REST_* at a Redis, or the test fake).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

const ROOT = new URL('../.vercel/output/static/', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.png': 'image/png', '.avif': 'image/avif', '.webp': 'image/webp',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.xml']);

async function resolveFile(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  for (const candidate of [clean, join(clean, 'index.html'), `${clean}.html`]) {
    const full = join(ROOT, candidate);
    if (!full.startsWith(ROOT)) return null;
    try {
      if ((await stat(full)).isFile()) return full;
    } catch {}
  }
  return null;
}

// Same routing as .vercel/output/config.json: on-demand pages build their images at runtime through /_image.
// /career itself is on demand; /career/privacy is a static file (Vercel serves files first, so must we).
const ON_DEMAND = /^\/(career\/?(\?|$)|career\/card\/|api\/device\/|api\/career\/|_image\?)/;
let renderFn;
const render = async (req, res) => {
  renderFn ??= (await import(new URL('../.vercel/output/functions/_render.func/dist/server/entry.mjs', import.meta.url))).default;
  return renderFn(req, res);
};

export function startServer(port = Number(process.env.PORT) || 4321) {
  const server = createServer(async (req, res) => {
    if (ON_DEMAND.test(req.url ?? '')) return render(req, res);
    // Vercel serves Analytics/Speed Insights itself; locally they're empty scripts (no 404s, nothing sent).
    if (/^\/_vercel\/(insights|speed-insights)\/script\.js$/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end('');
    }
    // Server routes don't exist in the static output; answer like a deployment without Redis configured.
    if (req.url?.startsWith('/api/twin')) {
      if (req.method === 'HEAD') return res.writeHead(204).end();
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }).end('event: error\ndata: {"code":"upstream"}\n\n');
      return;
    }
    if (req.url?.startsWith('/api/react')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{"enabled":false}');
      return;
    }
    const file = await resolveFile(req.url ?? '/');
    const found = file ?? (await resolveFile('/404.html'));
    if (!found) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = extname(found);
    let body = await readFile(found);
    const headers = {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'cache-control': found.includes('/_astro/') ? 'public, max-age=31536000, immutable'
        : ext === '.html' ? 'public, max-age=0, must-revalidate' : 'public, max-age=86400',
    };
    if (COMPRESSIBLE.has(ext) && /\bbr\b/.test(req.headers['accept-encoding'] ?? '')) {
      body = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
      headers['content-encoding'] = 'br';
      headers.vary = 'accept-encoding';
    }
    res.writeHead(file ? 200 : 404, headers).end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startServer();
  console.log(`Serving .vercel/output/static at http://localhost:${server.address().port}`);
}
