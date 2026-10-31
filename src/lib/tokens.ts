import tokens from '../../design/tokens.css?raw';

// Places that need literal colours (theme-color meta, the Satori OG image) read them from the tokens,
// so design/tokens.css stays the only source.
const blocks = tokens.split(/:root\[data-theme="dark"\]/);

function read(css: string) {
  const out: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[name] ??= value.trim();
  return out;
}

export const lightTokens = read(blocks[0]);
export const darkTokens = { ...lightTokens, ...read(blocks[1] ?? '') };
