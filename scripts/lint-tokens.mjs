// Fails when a component or stylesheet in src/ uses a raw colour instead of a design token.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// rgb(0 0 0 / …) is allowed: it is the neutral inner shade of the clay recipe in tokens.css, scaled by --clay-shade.
const RAW_COLOUR = /(?<![\w&-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?)\((?!0 0 0 \/)/gi;
const EXTS = /\.(astro|css|ts|tsx|js|mjs)$/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTS.test(name)) yield full;
  }
}

const problems = [];
for (const file of walk('src')) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(RAW_COLOUR)) problems.push(`${file}:${i + 1}  ${m[0]}  ${line.trim().slice(0, 90)}`);
  });
}
if (problems.length) {
  console.error(`Raw colour values found (use tokens from design/tokens.css):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('tokens: no raw colour values in src/');
