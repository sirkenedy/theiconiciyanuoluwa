// Free job sources behind one shape (career-mode.md §3.3, §3.3b). Each adapter keeps only jobs inside the 48 h window
// and records which timestamp kind the source really provides. One request per board per run, identified by User-Agent.
import { SOURCES, USER_AGENT, WINDOW_MS, attribution, type Company, type Fetched, type Job, type SourceId, type TimeKind } from './types.ts';
import { looksRemote, plainText, snippet } from './text.ts';

export class SourceError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`${status} ${url}`);
    this.status = status;
  }
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new SourceError(res.status, url);
  return (await res.json()) as T;
}

const fresh = (at: number, now: number, window = WINDOW_MS) => Number.isFinite(at) && at <= now + 5 * 60_000 && now - at <= window;

function make(source: SourceId, nativeId: string | number, fields: Omit<Job, 'id' | 'attribution' | 'snippet'>, html: string): Fetched {
  const description = plainText(html);
  return { job: { id: `${source}:${nativeId}`, attribution: attribution(source), snippet: snippet(description), ...fields }, description };
}

// ---------- ATS boards (company list in src/content/companies.json) ----------

type GreenhouseJob = { id: number; title: string; updated_at: string; first_published?: string; location?: { name?: string }; absolute_url: string; content?: string };
/** `first_published` is a real posting time ("posted"); a job only re-touched recently shows its `updated_at` ("updated"). */
export async function greenhouse(c: Company, now = Date.now()): Promise<Fetched[]> {
  const { jobs } = await getJson<{ jobs: GreenhouseJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.token)}/jobs?content=true`);
  return jobs.flatMap((j) => {
    const posted = Date.parse(j.first_published ?? '');
    const updated = Date.parse(j.updated_at);
    const time: { kind: TimeKind; at: number } | null = fresh(posted, now) ? { kind: 'posted', at: posted } : fresh(updated, now) ? { kind: 'updated', at: updated } : null;
    if (!time) return [];
    const location = j.location?.name ?? '';
    return [make('greenhouse', `${c.token}:${j.id}`, { title: j.title, company: c.company, location, remote: looksRemote(location, j.title), time, applyUrl: j.absolute_url, sourceUrl: j.absolute_url }, j.content ?? '')];
  });
}

type LeverJob = { id: string; text: string; createdAt?: number; categories?: { location?: string; allLocations?: string[] }; workplaceType?: string; hostedUrl: string; descriptionPlain?: string; description?: string };
/** Lever's `createdAt` is undocumented but present on live boards: treated as "posted". */
export async function lever(c: Company, now = Date.now()): Promise<Fetched[]> {
  const jobs = await getJson<LeverJob[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(c.token)}?mode=json`);
  return jobs.flatMap((j) => {
    if (!j.createdAt || !fresh(j.createdAt, now)) return [];
    const location = j.categories?.allLocations?.join(' / ') || j.categories?.location || '';
    return [
      make('lever', `${c.token}:${j.id}`, {
        title: j.text,
        company: c.company,
        location,
        remote: j.workplaceType === 'remote' || looksRemote(location),
        time: { kind: 'posted', at: j.createdAt },
        applyUrl: j.hostedUrl,
        sourceUrl: j.hostedUrl,
      }, j.description ?? j.descriptionPlain ?? ''),
    ];
  });
}

type AshbyJob = { id: string; title: string; publishedAt: string; isListed: boolean; isRemote?: boolean; workplaceType?: string; location?: string; jobUrl: string; descriptionHtml?: string; compensation?: { compensationTierSummary?: string } };
/** Ashby's `publishedAt` is the last publish time: labelled "published", never "posted". Unlisted jobs are skipped. */
export async function ashby(c: Company, now = Date.now()): Promise<Fetched[]> {
  const { jobs } = await getJson<{ jobs: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.token)}?includeCompensation=true`);
  return jobs.flatMap((j) => {
    const at = Date.parse(j.publishedAt);
    if (!j.isListed || !fresh(at, now)) return [];
    const location = j.location ?? '';
    return [
      make('ashby', `${c.token}:${j.id}`, {
        title: j.title,
        company: c.company,
        location,
        remote: !!j.isRemote || j.workplaceType === 'Remote' || looksRemote(location),
        time: { kind: 'published', at },
        applyUrl: j.jobUrl,
        sourceUrl: j.jobUrl,
        salary: j.compensation?.compensationTierSummary || undefined,
      }, j.descriptionHtml ?? ''),
    ];
  });
}

export const BOARDS = { greenhouse, lever, ashby };

// ---------- job boards ----------

type HimalayasJob = { title: string; companyName: string; locationRestrictions?: string[]; timezoneRestrictions?: number[]; pubDate: number; expiryDate?: number; applicationLink: string; guid: string; description?: string; minSalary?: number; maxSalary?: number; currency?: string };
/** Himalayas `pubDate` is the last update ("updated"). Apply uses `applicationLink` unchanged; expired jobs are dropped. */
export async function himalayas(now = Date.now(), maxPages = 10): Promise<Fetched[]> {
  const out: Fetched[] = [];
  let cursor = '';
  const key = process.env.HIMALAYAS_API_KEY;
  for (let page = 0; page < maxPages; page++) {
    const url = `https://himalayas.app/jobs/api?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const data = await getJson<{ jobs: HimalayasJob[]; nextCursor?: string | null }>(url, key ? { authorization: `Bearer ${key}` } : {});
    let older = false;
    for (const j of data.jobs) {
      const at = j.pubDate * 1000;
      if (!fresh(at, now)) {
        older = older || now - at > WINDOW_MS;
        continue;
      }
      if (j.expiryDate && j.expiryDate * 1000 < now) continue;
      const location = j.locationRestrictions?.length ? j.locationRestrictions.join(', ') : 'Worldwide';
      const salary = j.minSalary && j.maxSalary ? `${j.currency ?? ''} ${j.minSalary.toLocaleString('en')}–${j.maxSalary.toLocaleString('en')}`.trim() : undefined;
      const timezones = j.timezoneRestrictions?.filter((n) => Number.isFinite(n));
      out.push(make('himalayas', j.guid.split('/').at(-1) ?? j.guid, { title: j.title, company: j.companyName, location, remote: true, time: { kind: 'updated', at }, applyUrl: j.applicationLink, sourceUrl: j.guid, salary, ...(timezones?.length ? { timezones } : {}) }, j.description ?? ''));
    }
    if (older || !data.nextCursor) break;
    cursor = data.nextCursor;
  }
  return out;
}

type RemotiveJob = { id: number; url: string; title: string; company_name: string; publication_date: string; candidate_required_location?: string; salary?: string; description?: string };
/** Remotive listings are delayed 24 h by design; "Open job" and the attribution both go to the Remotive job page. */
export async function remotive(now = Date.now()): Promise<Fetched[]> {
  const { jobs } = await getJson<{ jobs: RemotiveJob[] }>('https://remotive.com/api/remote-jobs');
  return jobs.flatMap((j) => {
    const at = Date.parse(`${j.publication_date}Z`);
    if (!fresh(at, now, SOURCES.remotive.windowMs)) return [];
    return [make('remotive', j.id, { title: j.title, company: j.company_name, location: j.candidate_required_location || 'Worldwide', remote: true, time: { kind: 'posted', at }, applyUrl: j.url, sourceUrl: j.url, salary: j.salary || undefined }, j.description ?? '')];
  });
}

type JobicyJob = { id: number; url: string; jobTitle: string; companyName: string; jobGeo?: string; pubDate: string; jobDescription?: string; salaryMin?: number; salaryMax?: number; salaryCurrency?: string };
/** Jobicy: credit Jobicy and send "Open job" to the Jobicy job URL from the feed. */
export async function jobicy(now = Date.now()): Promise<Fetched[]> {
  const { jobs } = await getJson<{ jobs: JobicyJob[] }>('https://jobicy.com/api/v2/remote-jobs?count=100');
  return jobs.flatMap((j) => {
    const at = Date.parse(j.pubDate);
    if (!fresh(at, now)) return [];
    const salary = j.salaryMin && j.salaryMax ? `${j.salaryCurrency ?? ''} ${j.salaryMin.toLocaleString('en')}–${j.salaryMax.toLocaleString('en')}`.trim() : undefined;
    return [make('jobicy', j.id, { title: j.jobTitle, company: j.companyName, location: j.jobGeo || 'Anywhere', remote: true, time: { kind: 'posted', at }, applyUrl: j.url, sourceUrl: j.url, salary }, j.jobDescription ?? '')];
  });
}
