// Hourly board discovery: grows the company list without anyone editing companies.json. Two leads, both free:
//  1. apply links already in the pool that point at a company's hiring page (boards.greenhouse.io/<token>, …);
//  2. company names from live searches (Adzuna/Jooble), tried as tokens on the public job-board APIs.
// Policy is decided per hiring system: only systems that publish an official public job API are used, and the API
// host's robots.txt must allow it. Everything decided is recorded in Redis, so nothing is checked twice:
//   boards:added   ats:token → { company, ats, token, foundAt, via }
//   boards:skipped key       → { reason, policy, at }   (policy skips are permanent; others retried after 90 days)
import { pipeline, type Redis } from '../redis.ts';
import { countryPlace, inCountry } from './geo.ts';
import { BOARDS } from './sources.ts';
import { USER_AGENT, type Company, type Job } from './types.ts';

export const ADDED = 'boards:added';
export const SKIPPED = 'boards:skipped';
export const MAX_CHECKS_PER_RUN = 30;
export const MAX_DISCOVERED = 400;
const RETRY_MS = 90 * 86_400_000;

type Ats = Company['ats'];
export type Lead = { ats: Ats; token: string; company: string; via: string } | { skip: string; reason: string; policy: boolean };

/** Hiring systems we can read through an official public API (and how to spot their links). */
const SUPPORTED: [RegExp, Ats][] = [
  [/^https?:\/\/(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i, 'greenhouse'],
  [/^https?:\/\/jobs(?:\.eu)?\.lever\.co\/([a-z0-9_.-]+)/i, 'lever'],
  [/^https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/i, 'ashby'],
];
/** Never touched: no public job API, or terms that forbid automated access. Recorded once, never retried. */
const POLICY: [RegExp, string][] = [
  [/(^|\.)(linkedin|indeed|glassdoor|ziprecruiter|monster|simplyhired|careerbuilder)\.[a-z.]+$/i, 'job site whose terms forbid automated access'],
  [/(^|\.)myworkdayjobs\.com$|(^|\.)workday\.com$/i, 'Workday: no public job API'],
  [/(^|\.)icims\.com$/i, 'iCIMS: no public job API'],
  [/(^|\.)taleo\.net$/i, 'Taleo: no public job API'],
  [/(^|\.)successfactors\.(com|eu)$|(^|\.)sapsf\.com$/i, 'SuccessFactors: no public job API'],
  [/(^|\.)(oraclecloud|brassring|jobvite|ultipro|ukg|adp|paylocity|bamboohr)\.[a-z.]+$/i, 'hiring system without a public job API we may use'],
];
/** Public job APIs exist, but no adapter yet: recorded (not a policy block) so they can be added later. */
const LATER: [RegExp, string][] = [
  [/(^|\.)smartrecruiters\.com$/i, 'SmartRecruiters: public API, adapter not built yet'],
  [/(^|\.)workable\.com$/i, 'Workable: public API, adapter not built yet'],
  [/(^|\.)recruitee\.com$/i, 'Recruitee: public API, adapter not built yet'],
  [/(^|\.)teamtailor\.com$/i, 'Teamtailor: public feed, adapter not built yet'],
  [/(^|\.)personio\.(de|com)$/i, 'Personio: public feed, adapter not built yet'],
];

export const boardKey = (ats: Ats, token: string) => `${ats}:${token.toLowerCase()}`;

/** What an apply link tells us about the company's hiring system. Null for company sites we can't classify. */
export function leadFromUrl(url: string, company: string): Lead | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  for (const [re, ats] of SUPPORTED) {
    const token = url.match(re)?.[1];
    if (token && !['embed', 'jobs', 'api'].includes(token.toLowerCase())) return { ats, token: decodeURIComponent(token), company, via: host };
  }
  for (const [re, reason] of POLICY) if (re.test(host)) return { skip: host.replace(/^www\./, ''), reason, policy: true };
  for (const [re, reason] of LATER) if (re.test(host)) return { skip: host.replace(/^www\./, ''), reason, policy: false };
  return null;
}

/** Likely board tokens for a company name ("North Star Health Inc." → northstarhealth, north-star-health). */
export function guessTokens(company: string): string[] {
  const base = company
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|technologies|technology|labs|group)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!base || base.length < 2 || /company not listed|confidential|anonymous/.test(base)) return [];
  return [...new Set([base.replace(/ /g, ''), base.replace(/ /g, '-')])].filter((t) => t.length >= 2 && t.length <= 40);
}

const API_HOST: Record<Ats, { origin: string; path: string }> = {
  greenhouse: { origin: 'https://boards-api.greenhouse.io', path: '/v1/boards/' },
  lever: { origin: 'https://api.lever.co', path: '/v0/postings/' },
  ashby: { origin: 'https://api.ashbyhq.com', path: '/posting-api/job-board/' },
};

/** robots.txt for the API host, `User-agent: *` group: true when the board API path is allowed (or no robots.txt). */
export async function robotsAllow(ats: Ats, cache: Map<string, boolean>): Promise<boolean> {
  const { origin, path } = API_HOST[ats];
  if (cache.has(origin)) return cache.get(origin)!;
  let allowed = true;
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      let applies = false;
      for (const raw of (await res.text()).split('\n')) {
        const line = raw.split('#')[0].trim();
        const [field, ...rest] = line.split(':');
        const value = rest.join(':').trim();
        if (/^user-agent$/i.test(field)) applies = value === '*';
        else if (applies && /^disallow$/i.test(field) && value && path.startsWith(value)) allowed = false;
      }
    }
  } catch {}
  cache.set(origin, allowed);
  return allowed;
}

type Decision = { added: Company[]; skipped: { key: string; reason: string; policy: boolean }[]; checked: number };

/**
 * One discovery pass. `jobs` = everything in the pool (apply links), `searchCompanies` = company names from live
 * searches. `known` = boards already in companies.json. Checks at most MAX_CHECKS_PER_RUN new leads.
 */
export async function discover(
  redis: Redis,
  jobs: Job[],
  searchCompanies: string[],
  known: Company[],
  log: (line: string) => void = () => {},
  /** Companies to try for countries people searched from (src/lib/jobs/regions.ts): checked first. */
  regionCompanies: { company: string; country: string }[] = [],
): Promise<Decision> {
  const now = Date.now();
  type NameLead = { ats: null; tokens: string[]; company: string; via: string; country?: string };
  const leads = new Map<string, { ats: Ats; token: string; company: string; via: string } | NameLead>();
  // Countries with demand go first: they are why this run matters most.
  for (const { company, country } of regionCompanies) {
    const tokens = guessTokens(company);
    if (tokens.length) leads.set(`company:${tokens[0]}`, { ats: null, tokens, company, via: `demand from ${country.toUpperCase()}`, country });
  }
  const policySkips = new Map<string, { reason: string; policy: boolean }>();
  for (const j of jobs) {
    for (const url of [j.applyUrl, j.sourceUrl]) {
      const lead = leadFromUrl(url, j.company);
      if (!lead) continue;
      if ('skip' in lead) policySkips.set(lead.skip, { reason: lead.reason, policy: lead.policy });
      else leads.set(boardKey(lead.ats, lead.token), lead);
    }
  }
  for (const company of searchCompanies) {
    const tokens = guessTokens(company);
    if (tokens.length && !leads.has(`company:${tokens[0]}`)) leads.set(`company:${tokens[0]}`, { ats: null, tokens, company, via: 'live search' });
  }

  const knownKeys = new Set(known.map((c) => boardKey(c.ats, c.token)));
  const leadKeys = [...leads.keys()].filter((k) => !knownKeys.has(k));
  const skipKeys = [...policySkips.keys()];
  const [added, skipped] = (await pipeline(redis, [['HMGET', ADDED, '_', ...leadKeys], ['HMGET', SKIPPED, '_', ...leadKeys, ...skipKeys]], 10_000)) as (string | null)[][];
  const addedNow = new Set(leadKeys.filter((_, i) => added[i + 1]));
  const skippedAt = new Map<string, { at: number; policy: boolean }>();
  [...leadKeys, ...skipKeys].forEach((k, i) => {
    const raw = skipped[i + 1];
    if (raw) {
      const v = JSON.parse(raw) as { at: number; policy: boolean };
      skippedAt.set(k, v);
    }
  });
  const due = (k: string) => {
    const s = skippedAt.get(k);
    return !s || (!s.policy && now - s.at > RETRY_MS);
  };

  const out: Decision = { added: [], skipped: [], checked: 0 };
  // Policy skips cost nothing to record; only new ones are written.
  for (const [key, v] of policySkips) if (!skippedAt.has(key)) out.skipped.push({ key, ...v });

  const robots = new Map<string, boolean>();
  for (const key of leadKeys) {
    if (out.checked >= MAX_CHECKS_PER_RUN) break;
    if (addedNow.has(key) || !due(key)) continue;
    const lead = leads.get(key)!;
    const tries: [Ats, string][] = lead.ats ? [[lead.ats, lead.token]] : lead.tokens.flatMap((t) => (['greenhouse', 'lever', 'ashby'] as Ats[]).map((a): [Ats, string] => [a, t]));
    // A company guessed from its name may already be on the list under one of these tokens: nothing to do.
    if (tries.some(([ats, token]) => knownKeys.has(boardKey(ats, token)) || addedNow.has(boardKey(ats, token)))) continue;
    out.checked++;
    let found: Company | null = null;
    let blocked = false;
    let elsewhere = false;
    const country = lead.ats === null ? lead.country : undefined;
    for (const [ats, token] of tries) {
      if (!(await robotsAllow(ats, robots))) {
        blocked = true;
        continue;
      }
      const company: Company = { company: lead.company, ats, token, regions: country ? [country] : [], active: true };
      try {
        const rows = await BOARDS[ats](company, now); // throws on 404 (no such board) or an error
        // A name guessed for a country must hire there: a same-named company elsewhere is not the one we want.
        if (country && !rows.some((r) => inCountry(r.job.location, countryPlace(country)))) {
          elsewhere = true;
          continue;
        }
        found = company;
        break;
      } catch {}
    }
    if (found) {
      out.added.push(found);
      log(`  + ${found.ats}/${found.token} (${found.company}, via ${lead.via})`);
    } else {
      const reason = blocked ? "the board API's robots.txt disallows it" : elsewhere ? `board found, but no recent roles in ${country!.toUpperCase()}` : 'no public job board found';
      out.skipped.push({ key, reason, policy: blocked });
    }
  }

  const writes: (string | number)[][] = [];
  for (const c of out.added) writes.push(['HSET', ADDED, boardKey(c.ats, c.token), JSON.stringify({ ...c, foundAt: now })]);
  for (const s of out.skipped) writes.push(['HSET', SKIPPED, s.key, JSON.stringify({ reason: s.reason, policy: s.policy, at: now })]);
  if (writes.length) await pipeline(redis, writes, 10_000);
  return out;
}

/** Boards found so far (capped), for the hourly ingest. */
export async function discoveredBoards(redis: Redis): Promise<Company[]> {
  const [raw] = (await pipeline(redis, [['HVALS', ADDED]], 10_000)) as [string[] | null];
  return (raw ?? [])
    .map((v): Company | null => {
      try {
        const c = JSON.parse(v) as Company & { foundAt?: number };
        return { company: c.company, ats: c.ats, token: c.token, regions: c.regions ?? [], active: true };
      } catch {
        return null;
      }
    })
    .filter((c): c is Company => !!c)
    .slice(0, MAX_DISCOVERED);
}
