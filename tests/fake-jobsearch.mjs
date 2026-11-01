// In-memory stand-in for the live job-search APIs (Adzuna and Jooble) for Playwright: the built Career Coach function
// is pointed here with ADZUNA_API_URL / JOOBLE_API_URL, so no test ever calls a real job site.
// `node tests/fake-jobsearch.mjs 4333` serves it. Answers a few recent designer and product roles in Toronto.
import { createServer } from 'node:http';

const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const ROLES = [
  ['Senior Product Designer', 'Maple Studio', 2, 'Design systems in Figma; research and prototyping with product teams.'],
  ['Product Designer', 'Lakeshore Health', 4, 'Own discovery, prototyping and usability testing for patient apps.'],
  ['Product Manager, Payments', 'Northern Pay', 3, 'Own discovery, the roadmap and A/B testing for checkout.'],
];

export function startFakeJobSearch(port = 0) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ url: req.url, body });
      if (req.url === '/__calls') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(calls));
      if (req.url?.startsWith('/adzuna/')) {
        const results = ROLES.map(([title, company, days, description], i) => ({ id: `fake${i}`, title, company: { display_name: company }, location: { display_name: 'Toronto, Ontario' }, created: ago(days), redirect_url: `https://www.adzuna.ca/land/ad/fake${i}`, description, salary_min: 95000, salary_max: 120000, salary_is_predicted: '0' }));
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results }));
      }
      if (req.url?.startsWith('/jooble/')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jobs: [] }));
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) startFakeJobSearch(Number(process.argv[2]) || 4333).then(({ url }) => console.log(`fake job search on ${url}`));
