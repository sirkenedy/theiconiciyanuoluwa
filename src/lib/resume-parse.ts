import { z } from 'astro/zod';

const text = z.string();
const list = z.array(z.string());
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-\\d+$`), `id must look like ${prefix}-1`);

const ResumeSchema = z.object({
  identity: z.object({
    name: z.string().min(1),
    nickname: text.default(''),
    headline: z.string().min(1),
    location: text.default(''),
    availability: text.default(''),
    email: z.string().min(1),
    linkedin: text.default(''),
    instagram: text.default(''),
    resume_pdf: z.string().startsWith('/'),
    one_liner: text.default(''),
  }),
  about: text,
  experience: z.array(z.object({
    id: id('exp'), role: text, company: text, dates: text, stage_label: text,
    summary: text, highlights: list, skills: list,
  })).min(1),
  projects: z.array(z.object({ id: id('proj'), name: text, link: text, what: text, ai_angle: text })),
  skills: z.record(list),
  education_and_certs: list,
  writing: z.array(z.object({ id: id('post'), title: text, url: text, tldr: text })),
  faq: z.array(z.object({ q: z.string().min(1), a: text })),
  boundaries: list,
});

export type Resume = z.infer<typeof ResumeSchema>;

const LIST_FIELDS = new Set(['highlights', 'skills']);

/** Splits on commas that are not inside parentheses: "A (x, y), B" → ["A (x, y)", "B"]. */
export function splitList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

type Block = { heading: string; lines: string[] };

function blocks(lines: string[], marker: string): Block[] {
  const out: Block[] = [];
  for (const line of lines) {
    if (line.startsWith(marker)) out.push({ heading: line.slice(marker.length).trim(), lines: [] });
    else out.at(-1)?.lines.push(line);
  }
  return out;
}

/** `- key: value` lines, with indented `  - item` lines collected under an empty `- key:`. */
function keyValues(lines: string[]): Record<string, string | string[]> {
  const rec: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of lines) {
    const nested = line.match(/^\s{2,}-\s?(.*)$/);
    if (nested && listKey) {
      const item = nested[1].trim();
      if (item) (rec[listKey] as string[]).push(item);
      continue;
    }
    const kv = line.match(/^-\s+([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === '' && LIST_FIELDS.has(key)) {
      rec[key] = [];
      listKey = key;
    } else {
      rec[key] = LIST_FIELDS.has(key) ? splitList(value) : value.trim();
      listKey = null;
    }
  }
  return rec;
}

const bullets = (lines: string[]) =>
  lines.map((l) => l.match(/^-\s+(.*)$/)?.[1].trim()).filter((v): v is string => Boolean(v));

function faq(lines: string[]) {
  const out: { q: string; a: string }[] = [];
  for (const line of lines) {
    const q = line.match(/^-\s+q:\s*(.*)$/);
    const a = line.match(/^\s+a:\s*(.*)$/);
    if (q) out.push({ q: q[1].trim(), a: '' });
    else if (a && out.length) out[out.length - 1].a = a[1].trim();
  }
  return out;
}

export function parseResume(markdown: string): Resume {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const sections = Object.fromEntries(blocks(lines, '## ').map((b) => [b.heading, b.lines]));
  const items = (name: string) =>
    blocks(sections[name] ?? [], '### ').map((b) => ({ id: b.heading, ...keyValues(b.lines) }));

  const raw = {
    identity: keyValues(sections.identity ?? []),
    about: (sections.about ?? []).join(' ').replace(/\s+/g, ' ').trim(),
    experience: items('experience').map((e) => ({ highlights: [], skills: [], ...e })),
    projects: items('projects'),
    skills: Object.fromEntries(
      bullets(sections.skills ?? []).map((l) => {
        const [k, ...rest] = l.split(':');
        return [k.trim(), splitList(rest.join(':'))];
      }),
    ),
    education_and_certs: bullets(sections.education_and_certs ?? []),
    writing: items('writing'),
    faq: faq(sections.faq ?? []),
    boundaries: bullets(sections.boundaries ?? []),
  };

  const resume = ResumeSchema.parse(raw);
  const ids = [...resume.experience, ...resume.projects, ...resume.writing].map((i) => i.id);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (dupes.length) throw new Error(`Duplicate résumé ids: ${[...new Set(dupes)].join(', ')}`);
  return resume;
}

/** True when a value is empty or still contains a `[placeholder]`. */
export const isPlaceholder = (value: string) => !value || /\[[^\]]+\]/.test(value);
