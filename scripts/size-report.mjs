// Budget report for the built site: gzip sizes of JS/CSS (inline + external), fonts, first-visit transfer,
// and a secrets / name-privacy grep. Exits non-zero when a budget fails.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const STATIC = '.vercel/output/static';
const FUNCTIONS = '.vercel/output/functions';
const KB = 1024;
const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const kb = (n) => `${(n / KB).toFixed(1)} KB`;

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const html = readFileSync(join(STATIC, 'index.html'), 'utf8');
const inline = (tag) => [...html.matchAll(new RegExp(`<${tag}(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const linked = (re) => [...html.matchAll(re)].map((m) => readFileSync(join(STATIC, m[1])));

const jsInline = inline('script').filter((s) => !s.trim().startsWith('{'));
// Initial JS = scripts in the HTML plus everything they import statically; lazy chunks are reported separately.
const staticImports = (file) => [...readFileSync(join(STATIC, file), 'utf8').matchAll(/(?:^|[;}\s])import\s*(?:[\w{}\s,*$]+from\s*)?"(\.\/[^"]+\.js)"/g)].map((m) => join('/_astro', m[1].slice(2)));
const closure = (entries, seen = new Set()) => {
  for (const f of entries) if (!seen.has(f)) (seen.add(f), closure(staticImports(f), seen));
  return seen;
};
const initialFiles = closure([...html.matchAll(/<script[^>]*\bsrc="(\/[^"]+\.js)"/g)].map((m) => m[1]));
const jsFiles = [...initialFiles].map((f) => readFileSync(join(STATIC, f)));
// Several lazy chunks are named index.*.js (the chat island, Career Coach's docx/pdf libraries): find the chat by its code.
const chatEntry = [...walk(join(STATIC, '_astro'))]
  .map((f) => '/' + relative(STATIC, f))
  .find((f) => /\/index\.[\w-]+\.js$/.test(f) && readFileSync(join(STATIC, f), 'utf8').includes('askChip'));
const chatFiles = chatEntry ? [...closure([chatEntry])].filter((f) => !initialFiles.has(f)) : [];
const chatGz = chatFiles.reduce((n, f) => n + gz(readFileSync(join(STATIC, f))), 0);
const cssInline = inline('style');
const cssFiles = linked(/<link[^>]*rel="stylesheet"[^>]*href="(\/[^"]+\.css)"/g);
const preloadedFonts = linked(/<link[^>]*rel="preload"[^>]*href="(\/[^"]+\.woff2)"/g);
const fallback = [...walk(join(STATIC, '_astro'))].find((f) => /motion-fallback.*\.js$/.test(f));
const fonts = [...walk(join(STATIC, 'fonts'))].filter((f) => f.endsWith('.woff2'));

const jsGz = gz(Buffer.from(jsInline.join('\n'))) + jsFiles.reduce((n, b) => n + gz(b), 0);
const cssGz = gz(Buffer.from(cssInline.join('\n'))) + cssFiles.reduce((n, b) => n + gz(b), 0);
const htmlGz = gz(Buffer.from(html));
const fontBytes = fonts.reduce((n, f) => n + statSync(f).size, 0);
const transfer = htmlGz + jsFiles.reduce((n, b) => n + gz(b), 0) + cssFiles.reduce((n, b) => n + gz(b), 0) + fontBytes;

const clientText = [...walk(STATIC)].filter((f) => /\.(html|js|css|json)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
const secretHits = clientText.match(/ANTHROPIC|sk-ant/g) ?? [];

const resume = JSON.parse(readFileSync('src/content/resume.json', 'utf8'));
const nameParts = [resume.identity.name, resume.identity.nickname].join(' ').split(/\s+/).filter((p) => p.length > 2);
const serverFiles = [...walk(FUNCTIONS)].filter((f) => /\.(m?js|json)$/.test(f));
if (existsSync('src/content/resume.twin.json')) serverFiles.push('src/content/resume.twin.json');
// Build paths (the checkout folder may contain the owner's name), the manifest's static-asset list (the CV's
// filename) and the site domain are not content and are never sent to the API; strip them before matching.
// The site's own domain (it can contain the nickname) is embedded by Astro as config; it is never part of a prompt.
const siteHost = readFileSync(join(STATIC, 'robots.txt'), 'utf8').match(/Sitemap: https?:\/\/([^/\s]+)/)?.[1] ?? '';
const withoutPaths = (text) =>
  (siteHost ? text.split(siteHost).join('') : text)
    .replace(/(?:file:\/\/)?\/(?:Users|home|private|tmp|var|vercel)\/[^"'`\s)]*/g, '')
    .replace(/\\?"\/[\w./-]+\.(?:pdf|woff2|txt|js|css|svg|html|png|avif|webp)\\?"/g, '""');
// /career renders per request and shows the owner's display name (src/content/owner.json, name only): that page
// module may contain it. Every API route and shared chunk must not.
const DISPLAY_ONLY = /[\\/]pages[\\/]career(\.astro)?\.mjs$/;
// When more than one page imports owner.json, the bundler splits it into its own chunk: allowed only while it holds
// nothing but the display name (no email, links or anything else from the résumé).
const ownerOnly = (f) => /[\\/]chunks[\\/]owner_[\w-]+\.mjs$/.test(f) && !/@|https?:|linkedin|instagram/i.test(readFileSync(f, 'utf8')) && readFileSync(f, 'utf8').length < 400;
const nameHits = serverFiles.filter((f) => {
  if (DISPLAY_ONLY.test(f) || ownerOnly(f)) return false;
  const text = withoutPaths(readFileSync(f, 'utf8')).toLowerCase();
  return nameParts.some((p) => text.includes(p.toLowerCase()));
});

const rows = [
  ['Initial JS (gzip)', '≤ 30 KB', kb(jsGz), jsGz <= 30 * KB],
  ['CSS (gzip, inlined)', '≤ 22 KB', kb(cssGz), cssGz <= 22 * KB],
  ['HTML document (gzip)', '—', kb(htmlGz), true],
  ['Chat island (gzip, lazy: idle or intent)', '≤ 25 KB, not in initial graph', chatEntry ? `${kb(chatGz)} (${chatFiles.length} files)` : 'missing', !!chatEntry && chatGz <= 25 * KB && !html.includes(chatEntry)],
  ['Motion fallback chunk (gzip, lazy)', '≤ 3 KB, not in initial HTML', fallback ? `${kb(gz(readFileSync(fallback)))}${html.includes('motion-fallback') ? ' — referenced by HTML!' : ''}` : 'missing', !!fallback && gz(readFileSync(fallback)) <= 3 * KB && !html.includes('motion-fallback')],
  ['Font files', '2 WOFF2', `${fonts.length} (${kb(fontBytes)})`, fonts.length === 2],
  ['Preloaded fonts', 'display only', preloadedFonts.length === 1 ? 'Bricolage only' : `${preloadedFonts.length}`, preloadedFonts.length === 1],
  ['First-visit transfer', '≤ 150 KB', kb(transfer), transfer <= 150 * KB],
  ['Client grep ANTHROPIC / sk-ant', '0 hits', `${secretHits.length} hits`, secretHits.length === 0],
  ['Server bundle grep owner name', '0 hits', serverFiles.length ? `${nameHits.length} hits in ${serverFiles.length} files` : 'no server code yet', nameHits.length === 0],
];

console.log('| Check | Budget | Result | Pass |\n|---|---|---|---|');
for (const [check, budget, result, ok] of rows) console.log(`| ${check} | ${budget} | ${result} | ${ok ? '✅' : '❌'} |`);
if (nameHits.length) console.log('Name found in:', nameHits.map((f) => relative('.', f)).join(', '));
process.exit(rows.every((r) => r[3]) ? 0 : 1);
