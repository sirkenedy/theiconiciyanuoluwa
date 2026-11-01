// Tailored documents on the device: the "before" version from the confirmed profile, which lines changed, the contact
// line (rebuilt locally from the original résumé, because email and phone are never sent to the model), file names.
import type { Flag, Profile, TailoredResume } from './types.ts';

export type ResumeDoc = {
  id: string;
  kind: 'resume';
  mode: 'tailor' | 'improve';
  title: string; // e.g. "Product Manager, Payments · Sample Pay"
  fileBase: string;
  contact: string;
  before: TailoredResume;
  tailored: TailoredResume;
  changed: string[];
  flags: Flag[];
  createdAt: number;
};
export type LetterDoc = { id: string; kind: 'letter'; title: string; fileBase: string; name: string; contact: string; letter: string; flags: Flag[]; createdAt: number };
export type Doc = ResumeDoc | LetterDoc;

export function profileToResume(p: Profile): TailoredResume {
  return {
    name: p.identity.name,
    headline: p.identity.headline,
    location: p.location ?? p.identity.location,
    summary: p.summary ?? '',
    skills: p.skills,
    experience: p.experience.map((e) => ({ id: e.id, role: e.role, company: e.company, dates: e.dates, bullets: e.highlights })),
    education: p.education,
    certifications: p.certifications,
  };
}

const flat = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Keys of lines that differ from the "before" résumé: they're highlighted in lilac in the preview. */
export function changedKeys(before: TailoredResume, after: TailoredResume): string[] {
  const keys: string[] = [];
  if (flat(before.summary) !== flat(after.summary)) keys.push('summary');
  if (flat(before.headline ?? '') !== flat(after.headline ?? '')) keys.push('headline');
  const oldBullets = new Set(before.experience.flatMap((e) => e.bullets).map(flat));
  after.experience.forEach((e, i) => e.bullets.forEach((b, j) => !oldBullets.has(flat(b)) && keys.push(`exp.${i}.bullets.${j}`)));
  const oldSkills = new Set(before.skills.flatMap((s) => s.items).map(flat));
  after.skills.forEach((g, i) => g.items.forEach((item, j) => !oldSkills.has(flat(item)) && keys.push(`skills.${i}.items.${j}`)));
  return keys;
}

/** "Lagos, Nigeria · name@mail · +234… · linkedin.com/in/…", from the visitor's own file, on the device. */
export function contactLine(resumeText: string, location: string | null) {
  const email = resumeText.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0];
  const phone = resumeText.match(/(?<![\w/])\+?\d[\d\s().-]{7,}\d(?![\w/])/)?.[0]?.trim();
  const linkedin = resumeText.match(/(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/in\/[\w%-]+/i)?.[0]?.replace(/^https?:\/\/(www\.)?/i, '');
  return [location, email, phone && phone.replace(/\D/g, '').length >= 9 ? phone : null, linkedin].filter(Boolean).join(' · ');
}

const slug = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** firstname-lastname-resume-company-role (career-mode.md §3.4). */
export function fileBase(name: string | null, what: 'resume' | 'cover-letter', company?: string | null, role?: string | null) {
  return [slug(name) || 'my', what, slug(company), slug(role)].filter(Boolean).join('-');
}

/** Read or write a line by its key ("summary", "exp.0.bullets.2", "skills.1.items.0", "education.0"…). */
export function getLine(r: TailoredResume, key: string): string {
  const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k === 'exp' ? 'experience' : k], r);
  return typeof v === 'string' ? v : '';
}
export function setLine(r: TailoredResume, key: string, value: string): TailoredResume {
  const copy = structuredClone(r);
  const path = key.split('.').map((k) => (k === 'exp' ? 'experience' : k));
  const last = path.pop()!;
  const parent = path.reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, copy as unknown as Record<string, unknown>);
  parent[last] = value;
  return copy;
}
