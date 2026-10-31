export type Segment = { text: string; placeholder: boolean };

/** Splits copy into plain text and `[placeholder]` runs; an empty value becomes `[fallback]`. */
export function segments(value: string | undefined, fallback: string): Segment[] {
  const text = value?.trim() || `[${fallback}]`;
  return text
    .split(/(\[[^\]]+\])/)
    .filter(Boolean)
    .map((part) => ({ text: part, placeholder: /^\[[^\]]+\]$/.test(part) }));
}

/** First four-digit year in a date range, or "Now" for an ongoing role. */
export const startYear = (dates: string) => dates.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? '[Year]'; // content-check: fallback
export const isCurrent = (dates: string) => /present|now|current/i.test(dates);

/** "https://www.instagram.com/handle?x=1" → "handle" */
export const handleFromUrl = (url: string) => new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? url;

/** The hero headline is written in the résumé as three lines separated by `|`. */
export const heroLines = (hero: string) => {
  const lines = hero.split('|').map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines : ['[hero line]']; // content-check: fallback
};
