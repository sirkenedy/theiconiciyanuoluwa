// Content guard: fails the build if demo or placeholder content would ship.
// `node scripts/check-content.ts` scans the sources (before astro build); `--dist` scans the built site.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

// Owner-approved exception: the Writing section keeps its sample posts until real ones exist.
const ALLOWED = [
  'Writing PRDs for features that think',
  'Evals are the new acceptance criteria',
  'What shipping my first LLM feature taught me',
  '[Date] · [X] min read',
  '[Read link]',
  '[one line]',
  '/blog/[slug]',
];

const WORDS: [RegExp, string][] = [
  [/sirkay/i, '"Sirkay"'],
  [/\blorem\b/i, 'lorem ipsum'],
  [/\bTODO\b/, 'TODO'],
  [/\bTBD\b/, 'TBD'],
  [/example\.com/i, 'example.com'],
  [/href="#"/, 'href="#"'],
  [/you@email/i, 'sample email'],
  [/\bJohn Doe\b|\bJane Doe\b|\bAcme\b/, 'sample name'],
];
// In source, placeholders look like [Year], [Product Name], [how you evaluated it] or [X]; code like rec[key] or arr[0] doesn't match.
const SRC_BRACKET = /\[(?:X|[A-Z][A-Za-z]+(?: [A-Za-z/'.,-]+)*|[a-z]+(?: [A-Za-z/'.,-]+)+|you@[^\]]*)\]/;
// In built HTML, any bracketed words left in visible text or attributes are a placeholder.
const DIST_BRACKET = /\[[^\]["{}<>\n]*[A-Za-z][^\]["{}<>\n]*\]/;

const TEXT_EXT = new Set(['.astro', '.ts', '.tsx', '.md', '.json', '.css', '.html', '.svg', '.txt', '.xml', '.js', '.mjs']);
const dist = process.argv.includes('--dist');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : TEXT_EXT.has(extname(name)) ? [path] : [];
  });
}

function visible(html: string) {
  return html
    .replace(/<script(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
    .replace(/<(?!a\s)[^>]*\b(?:content|alt|title|aria-label)="([^"]*)"[^>]*>/g, ' $1 ')
    .replace(/<(?!a\s)[^>]+>/g, ' ')
    .replace(/&middot;|&#183;/g, '·')
    .replace(/\s+/g, ' ');
}

const distRoot = existsSync('dist/client') ? 'dist/client' : 'dist';
const files = dist
  ? walk(distRoot).filter((f) => /\.(html|xml|txt)$/.test(f))
  : [...walk('src').filter((f) => !f.startsWith('src/content/')), ...walk('public'), 'ai/resume.template.md'];

const problems: string[] = [];
for (const file of files) {
  let text = readFileSync(file, 'utf8');
  if (dist && file.endsWith('.html')) text = visible(text);
  for (const allowed of ALLOWED) text = text.split(allowed).join(' ');
  text.split('\n').forEach((line, i) => {
    const found = WORDS.filter(([re]) => re.test(line)).map(([, label]) => label);
    const bracket = line.match(dist ? DIST_BRACKET : SRC_BRACKET);
    // Lines marked `content-check: fallback` render only when résumé data is missing; the --dist scan still catches them if they ship.
    const fallback = !dist && /content-check: fallback/.test(line);
    if (bracket && !fallback && !/\b(?:as|keyof|typeof)\b/.test(bracket[0])) found.push(`placeholder ${bracket[0]}`);
    for (const label of found) problems.push(`${file}:${dist ? '' : i + 1 + ':'} ${label}`);
  });
}

if (problems.length) {
  console.error(`Content check failed (${dist ? 'built site' : 'sources'}): demo or placeholder content found\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`content check: ${files.length} ${dist ? 'built' : 'source'} files clean`);
