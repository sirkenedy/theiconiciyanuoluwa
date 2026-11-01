// The code-level no-fabrication check (career-coach skill, non-negotiable 3). After every tailored résumé, improvement
// or cover letter, numbers and names in the output are diffed against what the visitor gave us (their résumé text,
// confirmed profile and their own answers). Anything new is flagged to the visitor instead of being shipped silently.
import type { Answer, Flag, Profile, TailoredResume } from './types.ts';

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 1,200 → 1200; "40%" and "40" are the same number. Single digits count too: "a team of 5" is a fact. */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0].replace(/,(?=\d{3}\b)/g, ''));
}

// Ordinary words that are often capitalised mid-sentence in résumés and letters but are never facts on their own.
const COMMON = new Set(
  'i a an the and or of for to in on at by with from as my our your their his her its we you they this that these those dear sincerely regards best thank thanks hello hi summary experience skills education certifications projects january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday present current today remote hybrid onsite hiring team teams warm kind yours faithfully truly us uk eu usa pm apm ux ui qa kpi kpis okr okrs'.split(' '),
);

/** Names worth checking: acronyms (SQL), CamelCase (JavaScript), names with digits (S3) or dots (Node.js), and
 *  capitalised words that don't start a sentence (Kubernetes in "…using Kubernetes…"). */
export function namesIn(text: string, { titleCase = true } = {}): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9&+#]{1,}(?:\/[A-Z0-9]+)?\b|\b[A-Z][a-z]+[A-Z][A-Za-z]+\b|\b[A-Za-z]+\d[\w]*\b|\b\w+\.(?:js|io|ai|net|ts)\b/g)) {
    if (!COMMON.has(fold(m[0]))) out.add(m[0]);
  }
  if (!titleCase) return [...out];
  for (const sentence of text.split(/(?<=[.!?:;•\n])\s+|\n/)) {
    const words = sentence.trim().split(/\s+/);
    words.slice(1).forEach((raw) => {
      // "Headway's" is the name Headway.
      const w = raw.replace(/['’]s$/i, '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#.]+$/gu, '').replace(/[.]$/, '');
      if (/^\p{Lu}[\p{Ll}]{2,}/u.test(w) && !COMMON.has(fold(w))) out.add(w);
    });
  }
  return [...out];
}

export function sourceOf(parts: (string | null | undefined)[]) {
  const text = fold(parts.filter(Boolean).join('\n'));
  const numbers = new Set(numbersIn(text));
  return {
    hasNumber: (n: string) => numbers.has(n),
    hasName: (name: string) => new RegExp(`(^|[^a-z0-9])${escape(fold(name))}($|[^a-z0-9])`).test(text),
  };
}

function scan(text: string, source: ReturnType<typeof sourceOf>, flags: Map<string, Flag>, titleCase = true) {
  for (const n of numbersIn(text)) if (!source.hasNumber(n)) flags.set(`number:${n}`, { kind: 'number', text: n });
  for (const name of namesIn(text, { titleCase })) if (!source.hasName(name)) flags.set(`name:${fold(name)}`, { kind: 'name', text: name });
}

const same = (a: string, b: string) => {
  const x = fold(a).replace(/[^a-z0-9]+/g, ' ').trim();
  const y = fold(b).replace(/[^a-z0-9]+/g, ' ').trim();
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

const answersText = (answers: Answer[]) => answers.map((a) => a.answer);

/** Every employer, title and date must come from the profile; every number and name from the visitor's own words. */
export function checkResume(t: TailoredResume, profile: Profile, resumeText: string, answers: Answer[] = [], allowed: string[] = []): Flag[] {
  const flags = new Map<string, Flag>();
  for (const exp of t.experience) {
    const match = profile.experience.find((e) => e.id === exp.id && same(e.company, exp.company)) ?? profile.experience.find((e) => same(e.company, exp.company));
    if (!match) {
      flags.set(`employer:${fold(exp.company)}`, { kind: 'employer', text: exp.company });
      continue;
    }
    if (!same(match.role, exp.role)) flags.set(`title:${fold(exp.role)}`, { kind: 'title', text: exp.role });
    if (!same(match.dates, exp.dates)) flags.set(`date:${fold(exp.dates)}`, { kind: 'date', text: exp.dates });
  }
  const source = sourceOf([resumeText, JSON.stringify(profile), ...answersText(answers), ...allowed]);
  const texts = [t.headline, t.summary, ...t.experience.flatMap((e) => e.bullets), ...t.education, ...t.certifications];
  for (const text of texts) if (text) scan(text, source, flags);
  // Skills are written in Title Case ("MCP Servers"), so only acronyms, versions and numbers are checked word by word…
  for (const item of t.skills.flatMap((s) => s.items)) scan(item, source, flags, false);
  // A skill is a single word or phrase, so sentence rules miss it: at least one real word of it must be theirs.
  for (const item of t.skills.flatMap((s) => s.items)) {
    const words = item.split(/[\s,()]+/).filter((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length >= 2);
    if (words.length && !words.some((w) => source.hasName(w))) flags.set(`name:${fold(item)}`, { kind: 'name', text: item });
  }
  return [...flags.values()];
}

/** Cover letters: the target company and role may appear (`allowed`); every other number and name must be theirs. */
export function checkText(text: string, profile: Profile | null, resumeText: string, answers: Answer[] = [], allowed: string[] = []): Flag[] {
  const flags = new Map<string, Flag>();
  scan(text, sourceOf([resumeText, profile ? JSON.stringify(profile) : '', ...answersText(answers), ...allowed]), flags);
  return [...flags.values()];
}
