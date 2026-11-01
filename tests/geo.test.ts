// Only jobs the visitor can apply for: country/region restrictions, hiring time zones, country first, and the network
// country when the résumé names none. Pure functions. `npm run test:unit`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleFrom, inCountry, placeFor, placeOf, timezoneFits } from '../src/lib/jobs/geo.ts';
import { candidates } from '../src/lib/jobs/select.ts';
import type { Profile } from '../src/lib/career/types.ts';
import type { Job } from '../src/lib/jobs/types.ts';

const ibadan = placeOf('Ibadan, Nigeria');

test('place: city and country, with regions and UTC offset', () => {
  assert.deepEqual([ibadan.country, ibadan.name, ibadan.utc, ibadan.from], ['ng', 'Nigeria', 1, 'profile']);
  assert.ok(ibadan.regions.includes('africa') && ibadan.regions.includes('emea'));
  assert.deepEqual([placeOf('Ibadan').country, placeOf('Toronto, Ontario').utc, placeOf('Vancouver, Canada').utc], ['ng', -5, -8]);
  assert.equal(placeOf('').country, null);
});

test('remote restrictions: "Colombia only" is not for Ibadan; worldwide, Africa, EMEA and Nigeria are', () => {
  for (const [where, want] of [
    ['Colombia', 'no'], ['France', 'no'], ['United States', 'no'], ['Remote - US', 'no'], ['Philippines', 'no'], ['LATAM', 'no'], ['Europe', 'no'],
    ['Worldwide', 'yes'], ['Anywhere', 'yes'], ['', 'yes'], ['Africa', 'yes'], ['EMEA', 'yes'], ['Nigeria, Ghana, Kenya', 'yes'], ['Lagos', 'yes'], ['Remote (Africa)', 'yes'],
    ['Remote', 'unknown'], ['Flexible', 'unknown'],
  ] as const) assert.equal(eligibleFrom(where, ibadan), want, where);
});

test('hiring time zones: within 3 hours of theirs; none listed = no limit', () => {
  assert.equal(timezoneFits([8], ibadan), false, 'Philippines ± 0 h is 7 h away from Ibadan');
  assert.equal(timezoneFits([0, 2], ibadan), true);
  assert.equal(timezoneFits([-2], ibadan), true);
  assert.equal(timezoneFits(undefined, ibadan), true);
  assert.equal(timezoneFits([8], placeOf('')), true, 'unknown visitor time zone: not filtered');
});

test('network fallback: a résumé without a country uses Vercel\'s geo headers (country + time zone)', () => {
  const h = new Headers({ 'x-vercel-ip-country': 'NG', 'x-vercel-ip-timezone': 'Africa/Lagos' });
  assert.deepEqual(Object.values(placeFor('', h)).slice(0, 2), ['ng', 'Nigeria']);
  assert.equal(placeFor('', h).utc, 1);
  assert.equal(placeFor('', h).from, 'network');
  assert.equal(placeFor('Toronto, Canada', h).country, 'ca', 'the résumé wins when it names a country');
  assert.equal(placeFor('', new Headers()).country, null);
  assert.equal(inCountry('Lagos, Nigeria', ibadan), true);
  assert.equal(inCountry('Remote - Worldwide', ibadan), false);
});

const job = (id: string, title: string, location: string, remote: boolean, extra: Partial<Job> = {}): Job => ({
  id, title, company: 'Co', location, remote, time: { kind: 'posted', at: Date.now() - 3 * 86_400_000 }, applyUrl: 'https://x.test', sourceUrl: 'https://x.test', attribution: { source: 'X', label: 'via X' }, snippet: '', ...extra,
});
const support = { identity: { name: 'Sample', headline: 'Customer Support Assistant', location: 'Ibadan, Nigeria' }, summary: '', experience: [{ id: 'e', role: 'Customer Support Assistant', company: 'X', dates: '', highlights: [] }], skills: [], education: [], certifications: [], targetRoles: ['Customer Support'], seniority: 'junior', location: 'Ibadan, Nigeria', remotePreference: 'remote', yearsExperience: 2 } as unknown as Profile;

test('candidates for an Ibadan visitor: no Colombia-only, no Philippine-hours, no Berlin office; Nigeria first', () => {
  const pool = [
    job('colombia', 'Travel Customer Support Representative', 'Colombia', true),
    job('ph-hours', 'Customer Support Assistant', 'Worldwide', true, { timezones: [8] }),
    job('berlin', 'Customer Support Lead', 'Berlin, Germany', false),
    job('worldwide', 'Customer Support Specialist', 'Worldwide', true),
    job('lagos', 'Customer Support Officer', 'Lagos, Nigeria', false),
    job('africa', 'Customer Support Agent', 'Africa', true),
  ];
  const ids = candidates(pool, support, new Set()).map((c) => c.job.id);
  assert.deepEqual(new Set(ids), new Set(['worldwide', 'lagos', 'africa']));
  assert.equal(ids[0], 'lagos', 'a job in their own country comes first');
});
