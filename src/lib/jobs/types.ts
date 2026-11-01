// One normalised job shape for every free source (career-mode.md §3.3a). No dependencies: the hourly GitHub Actions
// ingest runs these files directly with Node.

export type SourceId = 'greenhouse' | 'lever' | 'ashby' | 'himalayas' | 'remotive' | 'jobicy';

/** What the source's timestamp really means. Never call an update time "posted". */
export type TimeKind = 'posted' | 'published' | 'updated';

export type Job = {
  id: string; // `${source}:${native id}`
  title: string;
  company: string;
  location: string;
  remote: boolean;
  time: { kind: TimeKind; at: number }; // ms since epoch
  /** The link the source's terms require for "Open job" (Himalayas applicationLink unchanged, Remotive/Jobicy job page…). */
  applyUrl: string;
  /** The listing on the source itself, for the visible "via X" attribution. */
  sourceUrl: string;
  attribution: { source: string; label: string };
  salary?: string;
  snippet: string;
};

/** A fetched job plus its full description (stored separately, for the source's window). */
export type Fetched = { job: Job; description: string };

export const SOURCES: Record<SourceId, { name: string; everyMinutes: number; windowMs?: number }> = {
  greenhouse: { name: 'Greenhouse', everyMinutes: 60 },
  lever: { name: 'Lever', everyMinutes: 60 },
  ashby: { name: 'Ashby', everyMinutes: 60 },
  himalayas: { name: 'Himalayas', everyMinutes: 24 * 60 }, // its data refreshes daily
  // ≤ 4 calls a day, per its terms. Its listings are delayed ≥ 24 h by design, so it fills the "this week" tier.
  remotive: { name: 'Remotive', everyMinutes: 6 * 60, windowMs: 7 * 24 * 3600_000 },
  jobicy: { name: 'Jobicy', everyMinutes: 60 }, // never more than once an hour
};

/** Only recent roles: nothing posted (or last updated) more than a month ago. */
export const WINDOW_MS = 30 * 24 * 3600_000;
/** Descriptions are stored trimmed: enough for tailoring and cover letters, small enough for the free Upstash plan. */
export const MAX_DESCRIPTION = 8000;
// Job boards see the site's address (how to reach us), never the owner's name.
export const USER_AGENT = 'career-coach/1.0 (+https://theiconiciyanuoluwa.com/career)';

export type Company = { company: string; ats: 'greenhouse' | 'lever' | 'ashby'; token: string; regions: string[]; active: boolean };

export const attribution = (source: SourceId) => ({ source: SOURCES[source].name, label: `via ${SOURCES[source].name}` });
