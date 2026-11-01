import { defineMiddleware } from 'astro:middleware';

// /career is rendered on demand so every response gets a fresh CSP nonce (career-mode.md §4.4). Prerendered portfolio
// pages pass straight through. Turnstile (challenges.cloudflare.com) is the one allowed third party.
const csp = (n: string) =>
  [
    "default-src 'self'",
    `script-src 'self' 'nonce-${n}' https://challenges.cloudflare.com`,
    'frame-src https://challenges.cloudflare.com',
    "connect-src 'self'",
    "img-src 'self' data:",
    `style-src 'self' 'nonce-${n}'`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "require-trusted-types-for 'script'",
  ].join('; ');

export const onRequest = defineMiddleware(async (context, next) => {
  if (context.isPrerendered || !/^\/career(\/|$)/.test(context.url.pathname)) return next();
  const response = await next();
  if (!response.headers.get('content-type')?.includes('text/html')) return response;

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...bytes));
  // Every <script> and <style> in this server-rendered HTML is ours; anything injected later has no nonce and won't run.
  const html = (await response.text()).replace(/<(script|style)\b(?![^>]*\bnonce=)/g, `<$1 nonce="${nonce}"`);
  const headers = new Headers(response.headers);
  // Vite injects styles through JS in dev, which a nonce can't cover: report there, enforce in production.
  headers.set(import.meta.env.DEV ? 'content-security-policy-report-only' : 'content-security-policy', csp(nonce));
  headers.set('referrer-policy', 'no-referrer');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('cache-control', 'no-store');
  headers.delete('content-length');
  return new Response(html, { status: response.status, headers });
});
