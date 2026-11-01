// Picks up to 25 candidates for one batched ranking call (career-mode.md §3.3, §3.3a). Pure: no I/O, easy to test.
// Order: freshness tier first (posted ≤ 60 min → today → the rest of the window), then relevance, then recency.
import type { Profile } from '../career/types.ts';
import { dedupeKey } from './store.ts';
import type { Job } from './types.ts';

export const MAX_CANDIDATES = 25;
export type Tier = 1 | 2 | 3;

const STOP = new Set(['and', 'or', 'the', 'of', 'for', 'in', 'at', 'to', 'a', 'an', 'senior', 'sr', 'junior', 'jr', 'lead', 'principal', 'staff', 'head', 'ii', 'iii', 'iv', 'i', 'remote', 'hybrid', 'with', 'new']);
const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}+#]+/gu, ' ').split(' ').filter((w) => w.length > 1 && !STOP.has(w));

export function tierOf(job: Job, now: number): Tier {
  const age = now - job.time.at;
  if (job.time.kind !== 'updated' && age <= 3600_000) return 1; // only a true posting time can claim "≤ 60 min"
  if (age <= 24 * 3600_000) return 2;
  return 3;
}

/** Title words that match what the visitor wants (target roles weigh most), plus a little for skills in the snippet. */
export function relevance(job: Job, p: Profile): number {
  const title = new Set(words(job.title));
  const text = new Set(words(`${job.title} ${job.snippet}`));
  const weigh = (phrases: (string | null | undefined)[], weight: number, bag: Set<string>) =>
    phrases.reduce((sum, phrase) => sum + words(phrase ?? '').filter((w) => bag.has(w)).length * weight, 0);
  const roles = p.targetRoles.length ? p.targetRoles : [p.experience[0]?.role, p.identity.headline];
  return weigh(roles, 3, title) + weigh([p.experience[0]?.role, p.identity.headline], 1, title) + Math.min(3, weigh(p.skills.flatMap((s) => s.items), 0.5, text));
}

/** Remote seekers see remote jobs (and ones in their own area); others see their area first, remote too. */
export function placeFits(job: Job, p: Profile): boolean {
  const home = (p.location ?? p.identity.location ?? '').toLowerCase();
  const near = !!home && home.split(/[,·/]/).map((s) => s.trim()).filter((s) => s.length > 2).some((part) => job.location.toLowerCase().includes(part));
  if (p.remotePreference === 'remote') return job.remote || near;
  if (p.remotePreference === 'onsite' || p.remotePreference === 'hybrid') return near || job.remote;
  return true;
}

export function candidates(all: Job[], profile: Profile, served: Set<string>, now = Date.now()): { job: Job; tier: Tier }[] {
  const seen = new Set<string>();
  return all
    .filter((job) => {
      if (served.has(job.id)) return false; // never show a job twice to the same device
      const k = dedupeKey(job);
      if (seen.has(k)) return false;
      seen.add(k);
      return placeFits(job, profile);
    })
    .map((job) => ({ job, tier: tierOf(job, now), score: relevance(job, profile) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => a.tier - b.tier || b.score - a.score || b.job.time.at - a.job.time.at)
    .slice(0, MAX_CANDIDATES)
    .map(({ job, tier }) => ({ job, tier }));
}
