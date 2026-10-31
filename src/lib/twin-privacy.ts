// Name privacy for the AI twin: the owner's name and contact details never reach the Claude API.
// The server sees placeholders; the browser swaps them back in at render time.

export const PLACEHOLDERS = ['NAME', 'NICKNAME', 'EMAIL', 'LINKEDIN', 'INSTAGRAM', 'RESUME_PDF'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type Identity = { name: string; nickname?: string; email: string; linkedin?: string; instagram?: string; resume_pdf: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Name fragments worth hiding: the full name, the nickname, and each name part of 3+ letters. */
export function nameParts(identity: Pick<Identity, 'name' | 'nickname'>) {
  const parts = [identity.name, identity.nickname ?? '', ...identity.name.split(/\s+/)];
  return [...new Set(parts.map((p) => p.trim()).filter((p) => p.length >= 3))].sort((a, b) => b.length - a.length);
}

/** Exact values → placeholder, longest first so URLs are replaced before the names inside them. */
export function replacements(identity: Identity): [string, Placeholder][] {
  const exact: [string, Placeholder][] = [
    [identity.linkedin ?? '', 'LINKEDIN'],
    [identity.instagram ?? '', 'INSTAGRAM'],
    [identity.resume_pdf, 'RESUME_PDF'],
    [identity.email, 'EMAIL'],
    [identity.nickname ?? '', 'NICKNAME'],
  ];
  const names = nameParts(identity).filter((p) => p !== identity.nickname).map((p): [string, Placeholder] => [p, 'NAME']);
  return [...exact, ...names].filter(([value]) => value && !/\[[^\]]+\]/.test(value)).sort((a, b) => b[0].length - a[0].length);
}

export function tokenise(text: string, pairs: [string, Placeholder][]) {
  return pairs.reduce((out, [value, token]) => out.replace(new RegExp(escape(value), 'gi'), `{{${token}}}`), text);
}

/** Lower-cased name fragments still present in `text` (used to fail the build and in tests). */
export function leakedNameParts(text: string, identity: Pick<Identity, 'name' | 'nickname'>) {
  const lower = text.toLowerCase();
  return nameParts(identity).filter((p) => lower.includes(p.toLowerCase()));
}

/** Expands placeholders for display. While streaming, a half-received `{{TOK` at the end is held back. */
export function expand(text: string, values: Record<string, string>, final = true) {
  const done = text.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => values[key] ?? m);
  return final ? done : done.replace(/\{\{?[A-Z_]*\}?$/, '');
}
