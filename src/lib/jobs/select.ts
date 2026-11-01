// Picks up to 25 candidates for one batched ranking call (career-mode.md §3.3, §3.3a). Pure: no I/O, easy to test.
// Order: freshness tier first (posted ≤ 60 min → today → the rest of the window), then relevance, then recency.
import type { Profile } from '../career/types.ts';
import { eligibleFrom, inCountry, placeOf, timezoneFits, type Place } from './geo.ts';
import { dedupeKey } from './store.ts';
import type { Job } from './types.ts';

// Ranked per search: enough that up to 10 jobs clear the 55-fit bar.
export const MAX_CANDIDATES = 40;
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

/**
 * Only jobs the visitor can actually apply for. A remote job must be open to their country or region ("Colombia only"
 * is not) and, when the source gives hiring time zones, within 3 h of theirs. An office job must be in their area.
 * Then: remote seekers see remote jobs and local ones; everyone else sees local jobs and remote ones.
 */
export function placeFits(job: Job, p: Profile, place: Place = placeOf(p.location ?? p.identity.location)): boolean {
  const home = (p.location ?? p.identity.location ?? '').toLowerCase();
  const near = !!home && home.split(/[,·/]/).map((s) => s.trim()).filter((s) => s.length > 2).some((part) => job.location.toLowerCase().includes(part));
  if (job.remote) return eligibleFrom(job.location, place) !== 'no' && timezoneFits(job.timezones, place);
  return near || inCountry(job.location, place) || !job.location.trim();
}

/** `place`: where the visitor is (profile first, else their network); jobs in their own country rank first in each tier. */
export function candidates(all: Job[], profile: Profile, served: Set<string>, now = Date.now(), place: Place = placeOf(profile.location ?? profile.identity.location)): { job: Job; tier: Tier }[] {
  const seen = new Set<string>();
  return all
    .filter((job) => {
      if (served.has(job.id)) return false; // never show a job twice to the same device
      const k = dedupeKey(job);
      if (seen.has(k)) return false;
      seen.add(k);
      return placeFits(job, profile, place);
    })
    .map((job) => ({ job, tier: tierOf(job, now), score: relevance(job, profile), home: inCountry(job.location, place) ? 1 : 0 }))
    .filter((c) => c.score > 0)
    .sort((a, b) => a.tier - b.tier || b.home - a.home || b.score - a.score || b.job.time.at - a.job.time.at)
    .slice(0, MAX_CANDIDATES)
    .map(({ job, tier }) => ({ job, tier }));
}
