// Job fixtures for Career Coach tests: fresh, sample-only listings in the shape the hourly ingest stores.
// Company names are illustrations, never shipped.
const min = 60_000;
const make = (n, title, company, kind, ageMin, source = 'greenhouse', extra = {}) => ({
  id: `${source}:sample:${n}`,
  title,
  company,
  location: extra.location ?? 'Lagos, Nigeria',
  remote: extra.remote ?? true,
  time: { kind, at: Date.now() - ageMin * min },
  applyUrl: extra.applyUrl ?? `https://jobs.sample.test/${n}?utm_source=api`,
  sourceUrl: extra.sourceUrl ?? `https://board.sample.test/${n}`,
  attribution: { source: source[0].toUpperCase() + source.slice(1), label: `via ${source[0].toUpperCase() + source.slice(1)}` },
  snippet: `${title} role. Work with design and engineering on product discovery, roadmaps and launches.`,
});

export function sampleIndexes() {
  return {
    greenhouse: [
      make(1, 'Product Manager, Payments', 'Sample Pay', 'posted', 18),
      make(2, 'Associate Product Manager', 'Sample Health', 'posted', 42),
      make(3, 'Senior Product Designer', 'Sample Studio', 'updated', 180, 'greenhouse', { remote: false }),
      make(4, 'Backend Engineer', 'Sample Infra', 'posted', 30),
    ],
    himalayas: [make(5, 'Product Manager, Growth', 'Sample Growth', 'updated', 300, 'himalayas', { applyUrl: 'https://himalayas.app/companies/sample/jobs/pm-growth?utm_source=api', sourceUrl: 'https://himalayas.app/companies/sample/jobs/pm-growth' })],
    jobicy: [make(6, 'Product Owner', 'Sample Retail', 'posted', 600, 'jobicy'), make(7, 'Product Manager, Platform', 'Sample Cloud', 'posted', 900, 'jobicy')],
  };
}

/** Seeds the fake Upstash (tests/fake-upstash.mjs) with job indexes, as the ingest would. */
export async function seedJobs(redisUrl, token = 'test-token') {
  const cmds = Object.entries(sampleIndexes()).map(([source, jobs]) => ['SET', `jobs:idx:${source}`, JSON.stringify(jobs)]);
  // Freshly ingested: the jobs route must not fall back to a live fetch of the real job boards in tests.
  for (const source of ['greenhouse', 'lever', 'ashby', 'himalayas', 'remotive', 'jobicy']) cmds.push(['SET', `jobs:last:${source}`, String(Date.now())]);
  await fetch(`${redisUrl}/pipeline`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(cmds) });
}
