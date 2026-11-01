// Live keyword search (Adzuna + Jooble) for when the shared pool has nothing good for someone. Both are job-search APIs
// built for this: a role + place query, structured results with posting dates (and, on Adzuna, pay). Only the role,
// level and place from the visitor's profile are sent, never their name or contact details. Results older than a month
// are dropped. Remotive and Jobicy are not searched live: their terms cap how often they may be called.
import type { Profile } from '../career/types.ts';
import type { Place } from './geo.ts';
import { SourceError } from './sources.ts';
import { looksRemote, plainText, snippet } from './text.ts';
import { USER_AGENT, WINDOW_MS, type Fetched } from './types.ts';

export type SearchSource = 'adzuna' | 'jooble';
export type SearchQuery = { what: string; where: string; country: string | null; countryName: string | null; remote: boolean; label: string; key: string };

const ADZUNA = () => process.env.ADZUNA_API_URL ?? 'https://api.adzuna.com/v1/api';
const JOOBLE = () => process.env.JOOBLE_API_URL ?? 'https://jooble.org/api';

/** JOB_SEARCH_SOURCES: comma-separated sources to use ("adzuna,jooble", "jooble", or empty for none). Unset = all with keys. */
export const searchEnabled = (s: SearchSource) => {
  const list = process.env.JOB_SEARCH_SOURCES;
  return list === undefined || list.split(',').map((x) => x.trim().toLowerCase()).includes(s);
};

export const searchConfigured = (s: SearchSource) =>
  searchEnabled(s) && (s === 'adzuna' ? !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) : !!process.env.JOOBLE_API_KEY);

/** Adzuna serves one site per country; these are the ones it covers. */
const ADZUNA_COUNTRIES: Record<string, string> = { gb: 'GBP', us: 'USD', ca: 'CAD', au: 'AUD', nz: 'NZD', za: 'ZAR', in: 'INR', sg: 'SGD', de: 'EUR', fr: 'EUR', nl: 'EUR', be: 'EUR', at: 'EUR', es: 'EUR', it: 'EUR', pl: 'PLN', ch: 'CHF', mx: 'MXN', br: 'BRL' };
const COUNTRY_WORDS: [RegExp, string, string][] = [
  [/\b(canada|ontario|quebec|qu[ée]bec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|toronto|ottawa|vancouver|montr[ée]al|calgary|edmonton|waterloo|mississauga)\b/i, 'ca', 'Canada'],
  [/\b(united states|usa|u\.s\.|new york|california|texas|washington|massachusetts|florida|illinois|seattle|san francisco|boston|chicago|austin)\b/i, 'us', 'United States'],
  [/\b(united kingdom|uk|england|scotland|wales|london|manchester|edinburgh)\b/i, 'gb', 'United Kingdom'],
  [/\b(australia|sydney|melbourne|brisbane)\b/i, 'au', 'Australia'],
  [/\b(new zealand|auckland|wellington)\b/i, 'nz', 'New Zealand'],
  [/\b(south africa|cape town|johannesburg)\b/i, 'za', 'South Africa'],
  [/\b(india|bengaluru|bangalore|mumbai|delhi|hyderabad|pune)\b/i, 'in', 'India'],
  [/\b(singapore)\b/i, 'sg', 'Singapore'],
  [/\b(germany|berlin|munich|hamburg)\b/i, 'de', 'Germany'],
  [/\b(france|paris)\b/i, 'fr', 'France'],
  [/\b(netherlands|amsterdam|rotterdam)\b/i, 'nl', 'Netherlands'],
  [/\b(spain|madrid|barcelona)\b/i, 'es', 'Spain'],
  [/\b(nigeria|lagos|abuja)\b/i, 'ng', 'Nigeria'],
  [/\b(kenya|nairobi)\b/i, 'ke', 'Kenya'],
];

export function countryOf(place: string): { code: string; name: string } | null {
  const hit = COUNTRY_WORDS.find(([re]) => re.test(place));
  return hit ? { code: hit[1], name: hit[2] } : null;
}

const LEVEL_WORDS: Partial<Record<NonNullable<Profile['seniority']>, string>> = { junior: 'junior', senior: 'senior', lead: 'lead', principal: 'principal', intern: 'intern' };

/** Up to two searches: the visitor's top target roles in their place (remote seekers: their whole country). */
export function queriesFor(p: Profile, opts: { anywhere?: boolean; place?: Place } = {}): SearchQuery[] {
  const roles = [...new Set((p.targetRoles.length ? p.targetRoles : [p.experience[0]?.role ?? p.identity.headline ?? '']).map((r) => r.trim()).filter(Boolean))].slice(0, 2);
  // No location on the résumé: search in the country the visitor's network is in.
  const place = (p.location ?? p.identity.location ?? '').trim() || (opts.place?.from === 'network' ? (opts.place.name ?? '') : '');
  const country = countryOf(place);
  const remote = opts.anywhere || p.remotePreference === 'remote';
  const city = place.split(/[,·/]/)[0]?.trim() ?? '';
  const where = opts.anywhere ? '' : remote ? (country?.name ?? '') : city;
  const level = p.seniority ? LEVEL_WORDS[p.seniority] : undefined;
  return roles.map((role) => {
    const what = level && !new RegExp(`\\b${level}\\b`, 'i').test(role) ? `${level} ${role}` : role;
    const label = `${role}${where ? ` in ${where}` : remote ? ', remote' : ''}`;
    // "Anywhere" drops the city, not the country: Adzuna searches one country at a time.
    const code = country?.code ?? null;
    return { what, where, country: code, countryName: code ? (country?.name ?? null) : null, remote, label, key: [what, where, code ?? ''].join('|').toLowerCase() };
  });
}

const recent = (at: number, now: number) => Number.isFinite(at) && at <= now + 5 * 60_000 && now - at <= WINDOW_MS;
const money = (n: number) => Math.round(n).toLocaleString('en');

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new SourceError(res.status, url.replace(/(app_key=|api\/)[^&/]+/g, '$1…'));
  return (await res.json()) as T;
}

type AdzunaJob = {
  id: string;
  title: string;
  description?: string;
  created: string;
  redirect_url: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string | number;
  contract_time?: string;
};
/** Adzuna: `created` is the posting date. "Open job" and the attribution go to Adzuna's own listing link (its terms). */
export async function adzuna(q: SearchQuery, now = Date.now()): Promise<Fetched[]> {
  const country = q.country && ADZUNA_COUNTRIES[q.country] ? q.country : null;
  if (!country || !searchConfigured('adzuna')) return [];
  const params = new URLSearchParams({
    app_id: process.env.ADZUNA_APP_ID!,
    app_key: process.env.ADZUNA_APP_KEY!,
    what: q.what,
    max_days_old: '30',
    results_per_page: '50',
    sort_by: 'date',
    'content-type': 'application/json',
  });
  if (q.where && q.where.toLowerCase() !== countryOf(q.where)?.name.toLowerCase()) params.set('where', q.where);
  const { results = [] } = await call<{ results?: AdzunaJob[] }>(`${ADZUNA()}/jobs/${country}/search/1?${params}`);
  const currency = ADZUNA_COUNTRIES[country];
  return results.flatMap((j) => {
    const at = Date.parse(j.created);
    if (!recent(at, now) || !j.redirect_url) return [];
    const description = plainText(j.description ?? '');
    const location = j.location?.display_name ?? '';
    const predicted = String(j.salary_is_predicted ?? '0') === '1';
    const salary = !predicted && j.salary_min && j.salary_max ? `${currency} ${money(j.salary_min)}–${money(j.salary_max)}` : undefined;
    const title = plainText(j.title);
    return [{
      job: {
        id: `adzuna:${j.id}`,
        title,
        company: j.company?.display_name ?? 'Company not listed',
        location,
        remote: looksRemote(location, title, description),
        time: { kind: 'posted', at },
        applyUrl: j.redirect_url,
        sourceUrl: j.redirect_url,
        attribution: { source: 'Adzuna', label: 'via Adzuna' },
        salary,
        snippet: snippet(description),
      },
      description,
    }];
  });
}

type JoobleJob = { id: string | number; title: string; location?: string; snippet?: string; salary?: string; type?: string; link: string; company?: string; updated?: string };
/** Jooble: `updated` is the listing's last update ("updated", never "posted"). "Open job" goes to Jooble's link. */
export async function jooble(q: SearchQuery, now = Date.now()): Promise<Fetched[]> {
  if (!searchConfigured('jooble')) return [];
  const location = q.where || q.countryName || '';
  const { jobs = [] } = await call<{ jobs?: JoobleJob[] }>(`${JOOBLE()}/${encodeURIComponent(process.env.JOOBLE_API_KEY!)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keywords: q.remote && !q.where ? `${q.what} remote` : q.what, location, page: '1' }),
  });
  return jobs.flatMap((j) => {
    const at = Date.parse(j.updated ?? '');
    if (!recent(at, now) || !j.link) return [];
    const description = plainText(j.snippet ?? '');
    const title = plainText(j.title);
    const place = j.location ?? '';
    return [{
      job: {
        id: `jooble:${j.id}`,
        title,
        company: j.company || 'Company not listed',
        location: place,
        remote: looksRemote(place, title, j.type, description),
        time: { kind: 'updated', at },
        applyUrl: j.link,
        sourceUrl: j.link,
        attribution: { source: 'Jooble', label: 'via Jooble' },
        salary: j.salary?.trim() || undefined,
        snippet: snippet(description),
      },
      description,
    }];
  });
}

export const SEARCH: Record<SearchSource, { name: string; run: (q: SearchQuery, now?: number) => Promise<Fetched[]>; dailyCap: number }> = {
  adzuna: { name: 'Adzuna', run: adzuna, dailyCap: 200 },
  jooble: { name: 'Jooble', run: jooble, dailyCap: 300 },
};
