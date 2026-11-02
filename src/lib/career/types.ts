// Career Coach data shapes (career-mode.md §6). One schema, two uses: the JSON Schema constrains Claude's structured
// output for task = "profile", and the zod schema re-validates it on the server.
import { z } from 'astro/zod';
import { REMOTE, SENIORITY } from './constants.ts';

export { REMOTE, SENIORITY };

const text = z.string().max(400);
const nullableText = text.nullable();

// Structured outputs can't enforce string or array lengths, so model-only text (analysis, change log, critique) is
// trimmed to the limit instead of rejected. Résumé content stays strict: cutting it would silently lose facts.
const clip = (max: number) => z.string().transform((s) => s.slice(0, max));
const upTo = <T extends z.ZodTypeAny>(item: T, max: number, min = 0) => z.array(item).min(min).transform((a) => a.slice(0, max));

export const ProfileSchema = z.object({
  identity: z.object({ name: nullableText, headline: nullableText, location: nullableText }),
  summary: z.string().max(1200).nullable(),
  experience: z
    .array(z.object({ id: z.string().max(20), role: text, company: text, dates: text, highlights: z.array(z.string().max(600)).max(12) }))
    .max(20),
  skills: z.array(z.object({ group: text, items: z.array(text).max(40) })).max(12),
  education: z.array(text).max(10),
  certifications: z.array(text).max(20),
  targetRoles: z.array(text).max(8),
  seniority: z.enum(SENIORITY).nullable(),
  location: nullableText,
  remotePreference: z.enum(REMOTE).nullable(),
  yearsExperience: z.number().min(0).max(60).nullable(),
});
export type Profile = z.infer<typeof ProfileSchema>;

const str = { type: 'string' } as const;
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const obj = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

/** The same shape for structured outputs (`output_config.format`): every field required, unknowns as null. */
export const PROFILE_JSON_SCHEMA = obj({
  identity: obj({ name: nullable(str), headline: nullable(str), location: nullable(str) }),
  summary: nullable(str),
  experience: { type: 'array', items: obj({ id: str, role: str, company: str, dates: str, highlights: { type: 'array', items: str } }) },
  skills: { type: 'array', items: obj({ group: str, items: { type: 'array', items: str } }) },
  education: { type: 'array', items: str },
  certifications: { type: 'array', items: str },
  targetRoles: { type: 'array', items: str },
  seniority: nullable({ type: 'string', enum: [...SENIORITY] }),
  location: nullable(str),
  remotePreference: nullable({ type: 'string', enum: [...REMOTE] }),
  yearsExperience: nullable({ type: 'number' }),
});

/** What the device keeps (encrypted) about the visitor's résumé. */
export type StoredProfile = { profile: Profile; fileName: string; resumeText: string; confirmed: boolean; updatedAt: number };

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

// message: one chat turn: a full pasted job posting fits (Ami reads it and picks the tool).
export const LIMITS_INPUT = { resume: 20_000, message: 15_000, answer: 6_000, summary: 2_000, turns: 40, summarize: 24 } as const;

// ---- job ranking (task = "rank_jobs") ----
export const RankSchema = z.object({
  results: z.array(z.object({ jobId: z.string().max(200), fit: z.number().int().min(0).max(100), why: z.array(z.string().max(160)).max(2), gaps: z.array(z.string().max(160)).max(2) })).max(40),
});
export const RANK_JSON_SCHEMA = obj({
  results: { type: 'array', items: obj({ jobId: str, fit: { type: 'integer' }, why: { type: 'array', items: str }, gaps: { type: 'array', items: str } }) },
});

/** A job card as the visitor sees it (and as the chat may reference it). */
export type RankedJob = import('../jobs/types.ts').Job & { fit: number; why: string[]; gaps: string[]; eligibility?: import('../jobs/eligibility.ts').Eligibility };
export const MIN_FIT = 55;

/** Compact job context for the chat: what's on screen, so "why is X the top match?" can be answered. */
/** Jobs the visitor saved (any time, any chat). */
/** Times are "YYYY-MM-DD HH:MM" UTC. `status`/`applied`: where their application is, from the tracker on their device. */
const stamp = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
export const SavedJobsSchema = z
  .array(
    z.object({
      title: z.string().max(200),
      company: z.string().max(200),
      location: z.string().max(200),
      fit: z.number().int().min(0).max(100),
      saved: z.boolean(),
      source: z.string().max(40),
      status: z.enum(['applied', 'interview', 'offer', 'rejected']).nullable().optional(),
      applied: stamp.nullable().optional(),
    }),
  )
  .max(25);

/** Jobs shown in the last 7 days (any chat), newest first, with when "Open job" was clicked. */
export const RecentJobsSchema = z
  .array(z.object({ title: z.string().max(200), company: z.string().max(200), location: z.string().max(200), fit: z.number().int().min(0).max(100), shown: stamp, opened: stamp.nullable(), source: z.string().max(40) }))
  .max(25);

export const ChatJobsSchema = z
  .array(z.object({ title: text, company: text, location: text, fit: z.number().int().min(0).max(100), why: z.array(text).max(2), gaps: z.array(text).max(2) }))
  .max(10);

// ---- tailoring, improving, cover letters (career-mode.md §3.4–3.5) ----
const line = z.string().max(600);
export const TailoredSchema = z.object({
  name: nullableText,
  headline: nullableText,
  location: nullableText,
  summary: z.string().max(1200),
  skills: z.array(z.object({ group: text, items: z.array(text).max(40) })).max(12),
  experience: z.array(z.object({ id: z.string().max(20), role: text, company: text, dates: text, bullets: z.array(line).max(12) })).max(20),
  education: z.array(text).max(10),
  certifications: z.array(text).max(20),
});
export type TailoredResume = z.infer<typeof TailoredSchema>;
const TAILORED_JSON = obj({
  name: nullable(str),
  headline: nullable(str),
  location: nullable(str),
  summary: str,
  skills: { type: 'array', items: obj({ group: str, items: { type: 'array', items: str } }) },
  experience: { type: 'array', items: obj({ id: str, role: str, company: str, dates: str, bullets: { type: 'array', items: str } }) },
  education: { type: 'array', items: str },
  certifications: { type: 'array', items: str },
});

export const MATCH_KINDS = ['strong', 'added', 'missing'] as const;
/**
 * Chat tools: Ami reads the whole message and either answers or picks one of these; the browser then runs the flow.
 * `job`: "pasted" = a job description they pasted in this chat (their latest message, or an earlier one), "current" = the
 * job this chat is already about (<job>), "none" = no job yet (the visitor is asked to paste it).
 */
export const ToolCallSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('find_jobs'), input: z.object({ anywhere: z.boolean().optional() }) }),
  z.object({ name: z.literal('show_jobs'), input: z.object({ which: z.enum(['saved', 'recent', 'applied']) }) }),
  z.object({
    name: z.literal('mock_interview'),
    input: z.object({ job: z.enum(['pasted', 'current', 'none']), instructions: z.string().max(1000).nullable().optional(), title: z.string().max(200).nullable().optional(), company: z.string().max(200).nullable().optional() }),
  }),
  z.object({
    name: z.literal('prep_guide'),
    input: z.object({ job: z.enum(['pasted', 'current', 'none']), instructions: z.string().max(1000).nullable().optional(), title: z.string().max(200).nullable().optional(), company: z.string().max(200).nullable().optional() }),
  }),
  z.object({
    name: z.literal('make_document'),
    input: z.object({
      kind: z.enum(['tailor', 'letter', 'both', 'improve']),
      job: z.enum(['pasted', 'current', 'none']),
      title: z.string().max(200).nullable().optional(),
      company: z.string().max(200).nullable().optional(),
      tone: z.string().max(500).nullable().optional(),
    }),
  }),
]);
export type ToolCall = z.infer<typeof ToolCallSchema>;
export const CHAT_TOOLS = [
  {
    name: 'find_jobs',
    description: 'Show the visitor NEW job cards matched to their profile (title, fit, apply link). Use when they ask to find, show or get new jobs, roles or openings for themselves. Not for jobs they have already seen, saved or opened (answer those from <recent_jobs> and <saved_jobs>), and not for advice about job hunting.',
    input_schema: { type: 'object', properties: { anywhere: { type: 'boolean', description: 'true only if they ask for remote roles anywhere / outside their area' } }, additionalProperties: false },
  },
  {
    name: 'show_jobs',
    description: 'Show job CARDS (with apply links, tailor and cover-letter buttons) for jobs the visitor already has: "saved" = jobs they saved, "recent" = jobs shown to them in the last 7 days, "applied" = jobs they are tracking as applied, interviewing, offer or not selected. Use when they want to see, get or open those jobs as cards. Free: no new search.',
    input_schema: { type: 'object', properties: { which: { type: 'string', enum: ['saved', 'recent', 'applied'] } }, required: ['which'], additionalProperties: false },
  },
  {
    name: 'mock_interview',
    description:
      'Start a live practice (mock) interview: Ami plays the interviewer for a job, asks one question at a time, follows up on their answers, and scores them at the end. Use when they want to practise or simulate an interview, or be interviewed. Not for a written list of likely questions (prep_guide).',
    input_schema: {
      type: 'object',
      properties: {
        job: { type: 'string', enum: ['pasted', 'current', 'none'], description: 'as for make_document: the job description pasted in this conversation, the job in <job>, or none' },
        instructions: { type: ['string', 'null'], description: 'anything they asked for about the interview, in their own words ("focus on payments", "no behavioural questions"), else null' },
        title: { type: ['string', 'null'] },
        company: { type: ['string', 'null'] },
      },
      required: ['job'],
      additionalProperties: false,
    },
  },
  {
    name: 'prep_guide',
    description:
      'Build a detailed, downloadable interview preparation guide for a job: likely questions with answer outlines from their real experience, what the interviewer is testing, gaps and how to address them, questions to ask, and anything else they asked for. Use whenever they ask for interview prep, a prep guide, likely questions or a study plan for an interview.',
    input_schema: {
      type: 'object',
      properties: {
        job: { type: 'string', enum: ['pasted', 'current', 'none'], description: 'as for make_document: the job description pasted in this conversation, the job in <job>, or none' },
        instructions: { type: ['string', 'null'], description: 'everything they asked for about the guide, in their own words, so it can be followed exactly: length or schedule ("a 3-day plan"), focus ("payments questions"), exclusions ("no behavioural questions"), level of detail, format' },
        title: { type: ['string', 'null'] },
        company: { type: ['string', 'null'] },
      },
      required: ['job'],
      additionalProperties: false,
    },
  },
  {
    name: 'make_document',
    description:
      'Build a downloadable document: "tailor" = their résumé tailored to a job, "letter" = a cover letter for a job, "both" = tailored résumé + cover letter, "improve" = their résumé made stronger for their target role (no job needed). Use when they ask for one of these, however they phrase it. Not for questions about how to write them.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['tailor', 'letter', 'both', 'improve'] },
        job: { type: 'string', enum: ['pasted', 'current', 'none'], description: '"pasted" if they pasted a job description or posting in this conversation (their latest message or an earlier one: judge the content, not the length); "current" if they mean the job in <job>; "none" if there is no job yet. Use "none" for improve.' },
        title: { type: ['string', 'null'], description: 'the role title, if a job is pasted or known' },
        company: { type: ['string', 'null'], description: 'the company, if stated' },
        tone: { type: ['string', 'null'], description: 'for a cover letter: the tone or anything they asked for ("warm and short", "mention my relocation"), else null' },
      },
      required: ['kind', 'job'],
      additionalProperties: false,
    },
  },
] as const;

// ---- interview prep guides (Sonnet + web research) ----
/** A flexible guide: the visitor's instructions decide its shape (a 3-day plan, no behavioural questions, …). */
const GuideItemSchema = z.object({
  kind: z.enum(['text', 'bullets', 'question', 'step']),
  title: clip(300).nullable(),
  text: clip(2500).nullable(),
  bullets: upTo(clip(500), 12),
  why: clip(600).nullable(),
  answer: upTo(clip(600), 8),
});
export const GuideSchema = z.object({
  title: clip(200),
  subtitle: clip(300),
  note: clip(500),
  sections: upTo(z.object({ heading: clip(160), intro: clip(1500).nullable(), items: upTo(GuideItemSchema, 40) }), 16, 1),
  sources: upTo(z.object({ title: clip(200), url: clip(500) }), 12),
});
export type Guide = z.infer<typeof GuideSchema>;
const strArr = { type: 'array', items: str } as const;
export const GUIDE_JSON_SCHEMA = obj({
  title: str,
  subtitle: str,
  note: str,
  sections: {
    type: 'array',
    items: obj({
      heading: str,
      intro: nullable(str),
      items: { type: 'array', items: obj({ kind: { type: 'string', enum: ['text', 'bullets', 'question', 'step'] }, title: nullable(str), text: nullable(str), bullets: strArr, why: nullable(str), answer: strArr }) },
    }),
  },
  sources: { type: 'array', items: obj({ title: str, url: str }) },
});

export const AnalysisSchema = z.object({
  role: clip(400).nullable(),
  company: clip(400).nullable(),
  match: upTo(z.object({ kind: z.enum(MATCH_KINDS), text: clip(300) }), 5, 1),
  questions: upTo(z.object({ id: clip(20), question: clip(300) }), 3),
});
export type Analysis = z.infer<typeof AnalysisSchema>;
export const ANALYSIS_JSON_SCHEMA = obj({
  role: nullable(str),
  company: nullable(str),
  match: { type: 'array', items: obj({ kind: { type: 'string', enum: [...MATCH_KINDS] }, text: str }) },
  questions: { type: 'array', items: obj({ id: str, question: str }) },
});

export const CRITIQUE_AREAS = ['clarity', 'impact', 'keywords', 'structure', 'length'] as const;
export const WriteSchema = z.object({
  tailored: TailoredSchema,
  changes: upTo(z.object({ section: clip(400), before: clip(600), after: clip(600), why: clip(300) }), 12),
  ats: z.object({ before: z.number().int().min(0).max(100), after: z.number().int().min(0).max(100), addedKeywords: upTo(clip(400), 20), stillMissing: upTo(clip(400), 20) }),
  critique: upTo(z.object({ area: z.enum(CRITIQUE_AREAS), note: clip(300) }), 5),
});
export type WriteResult = z.infer<typeof WriteSchema>;
export const WRITE_JSON_SCHEMA = obj({
  tailored: TAILORED_JSON,
  changes: { type: 'array', items: obj({ section: str, before: str, after: str, why: str }) },
  ats: obj({ before: { type: 'integer' }, after: { type: 'integer' }, addedKeywords: { type: 'array', items: str }, stillMissing: { type: 'array', items: str } }),
  critique: { type: 'array', items: obj({ area: { type: 'string', enum: [...CRITIQUE_AREAS] }, note: str }) },
});

export const AnswersSchema = z.array(z.object({ question: z.string().max(300), answer: z.string().max(500) })).max(3);
export type Answer = z.infer<typeof AnswersSchema>[number];
export const JobInputSchema = z.object({ jobId: z.string().max(200).optional(), title: text.optional(), company: text.optional(), description: z.string().max(15_000).optional() });

/** Something in the output that isn't in the résumé, the profile or the visitor's answers. */
export type Flag = { kind: 'number' | 'name' | 'employer' | 'title' | 'date'; text: string };

// ---- mock interviews ----
/** What the interviewer does next: a new main question, a follow-up on the last answer, a reply to their question, or the close. */
export const IV_ACTIONS = ['ask', 'follow_up', 'reply', 'end'] as const;
export type IvAction = (typeof IV_ACTIONS)[number];
export const IV_STYLES = ['friendly', 'neutral', 'tough'] as const;
export const IV_LENGTHS = [4, 6, 8] as const;
export const InterviewSetupSchema = z.object({
  questions: z.union([z.literal(4), z.literal(6), z.literal(8)]),
  style: z.enum(IV_STYLES),
  instructions: z.string().max(1000),
});
export type InterviewSetup = z.infer<typeof InterviewSetupSchema>;
/** The whole interview so far, sent every turn (the server keeps nothing): Ami's lines and the candidate's answers, each
 * answer with Ami's private note on it. */
export const TranscriptSchema = z
  .array(
    z.discriminatedUnion('who', [
      z.object({ who: z.literal('ami'), kind: z.enum(IV_ACTIONS), text: z.string().max(1200) }),
      z.object({
        who: z.literal('you'),
        text: z.string().min(1).max(4000),
        note: z.string().max(600).nullable().optional(),
        /** A spoken answer's delivery, measured on the device (no audio is ever sent). */
        voice: z.object({ seconds: z.number().min(0).max(3600), words: z.number().int().min(0).max(20_000), wpm: z.number().min(0).max(400), fillers: z.number().int().min(0).max(1000), longPauses: z.number().int().min(0).max(200) }).nullable().optional(),
      }),
    ]),
  )
  .max(64);
export type Transcript = z.infer<typeof TranscriptSchema>;
/** How Ami's face reacts to their answer (the orb shows it). */
export const IV_REACTIONS = ['neutral', 'smile', 'nod', 'impressed', 'thoughtful', 'amused'] as const;
export type IvReaction = (typeof IV_REACTIONS)[number];
export const InterviewTurnSchema = z.object({
  say: clip(900),
  action: z.enum(IV_ACTIONS),
  react: z.enum(IV_REACTIONS).catch('neutral').optional(),
  note: clip(500).nullable(),
  heard: clip(4000).nullable().optional(),
});
export type InterviewTurn = z.infer<typeof InterviewTurnSchema>;
/** Only the actions allowed right now (question budget, follow-up cap): the model can't pick anything else. */
/** `say` first: it streams out (and Ami starts speaking) while the rest is still being written. */
export const interviewTurnJsonSchema = (allowed: readonly IvAction[]) =>
  obj({ say: str, action: { type: 'string', enum: [...allowed] }, react: { type: 'string', enum: [...IV_REACTIONS] }, note: nullable(str), heard: nullable(str) });

const score = z.number().transform((n) => Math.min(5, Math.max(1, Math.round(n * 2) / 2)));
export const FeedbackSchema = z.object({
  score,
  readiness: z.enum(['ready', 'almost', 'not_yet']),
  summary: clip(1200),
  strengths: upTo(clip(400), 3),
  fixes: upTo(clip(400), 3),
  practise: upTo(clip(400), 3),
  questions: upTo(
    z.object({ question: clip(600), score: score.transform((n) => Math.round(n)), strong: upTo(clip(400), 3), missing: upTo(clip(400), 3), followups: clip(600).nullable(), better: upTo(clip(600), 6) }),
    10,
  ),
});
export type Feedback = z.infer<typeof FeedbackSchema>;
export const FEEDBACK_JSON_SCHEMA = obj({
  score: { type: 'number' },
  readiness: { type: 'string', enum: ['ready', 'almost', 'not_yet'] },
  summary: str,
  strengths: strArr,
  fixes: strArr,
  practise: strArr,
  questions: { type: 'array', items: obj({ question: str, score: { type: 'number' }, strong: strArr, missing: strArr, followups: nullable(str), better: strArr }) },
});
