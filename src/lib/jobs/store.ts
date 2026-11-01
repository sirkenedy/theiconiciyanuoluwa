// Redis layout for jobs (career-mode.md §3.3a), shared by the hourly ingest and /api/career/jobs.
// Budget: one index per source per run, one write per *new* job's description, nothing per unchanged job.
import type { Job, SourceId } from './types.ts';

export const KEY = {
  index: (s: SourceId) => `jobs:idx:${s}`, // JSON Job[] (no descriptions), rebuilt from each fetch so expired jobs drop out
  lastRun: (s: SourceId) => `jobs:last:${s}`, // ms of the last successful fetch, for each source's polling cadence
  description: (id: string) => `jobs:desc:${id}`, // plain text, kept for the source's window (48 h; Remotive 7 days)
  served: (deviceId: string) => `career:served:${deviceId}`, // job ids already shown to this device, 30 days
};
export const DEMAND = 'search:demand'; // country code → times nothing fit (hash), for the hourly board discovery
export const DEMAND_LAST = 'search:demand:last'; // country code → ms of the latest
export const demandRoles = (country: string) => `search:demand:roles:${country}`; // target roles asked for there
export const INDEX_TTL_S = 50 * 3600; // Remotive's index is rewritten every 6 h, so the TTL never cuts its week short
export const SERVED_TTL_S = 30 * 86_400;
export const MAX_PER_SOURCE = 600;

/** Same job seen twice (e.g. on a board and on an aggregator): company + title + location, case and spacing ignored. */
export const dedupeKey = (j: Pick<Job, 'company' | 'title' | 'location'>) =>
  [j.company, j.title, j.location].map((s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).join('|');

export function parseIndex(raw: unknown): Job[] {
  if (typeof raw !== 'string') return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? (list as Job[]) : [];
  } catch {
    return [];
  }
}
