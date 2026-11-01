// Verifies every ATS board in src/content/companies.json (career-mode.md §3.3): tries the listed ATS, falls back to the
// other two, records whichever answers, and sets `active: false` on boards that 404 everywhere. Many companies use ATSs
// without a free API; those simply stay inactive. `node scripts/check-boards.ts` (add `--seed` to start from CANDIDATES).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { USER_AGENT, type Company } from '../src/lib/jobs/types.ts';

const FILE = 'src/content/companies.json';
type Ats = Company['ats'];
const URLS: Record<Ats, (t: string) => string> = {
  greenhouse: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
  lever: (t) => `https://api.lever.co/v0/postings/${t}?mode=json&limit=1`,
  ashby: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
};

// Companies hiring product, design and engineering, remote-first and African startups included. Guesses are fine: the
// check below decides.
const CANDIDATES: [string, Ats, string, string[]][] = [
  ['Stripe', 'greenhouse', 'stripe', ['global']], ['Airbnb', 'greenhouse', 'airbnb', ['global']], ['Figma', 'greenhouse', 'figma', ['global']],
  ['Discord', 'greenhouse', 'discord', ['us']], ['Dropbox', 'greenhouse', 'dropbox', ['global']], ['GitLab', 'greenhouse', 'gitlab', ['remote']],
  ['Coinbase', 'greenhouse', 'coinbase', ['global']], ['Robinhood', 'greenhouse', 'robinhood', ['us']], ['Reddit', 'greenhouse', 'reddit', ['global']],
  ['Instacart', 'greenhouse', 'instacart', ['us']], ['Pinterest', 'greenhouse', 'pinterest', ['global']], ['Duolingo', 'greenhouse', 'duolingo', ['global']],
  ['Asana', 'greenhouse', 'asana', ['global']], ['Cloudflare', 'greenhouse', 'cloudflare', ['global']], ['Datadog', 'greenhouse', 'datadog', ['global']],
  ['Airtable', 'greenhouse', 'airtable', ['global']], ['Gusto', 'greenhouse', 'gusto', ['us']], ['Brex', 'greenhouse', 'brex', ['global']],
  ['Twilio', 'greenhouse', 'twilio', ['global']], ['Lyft', 'greenhouse', 'lyft', ['us']], ['Flexport', 'greenhouse', 'flexport', ['global']],
  ['Chime', 'greenhouse', 'chime', ['us']], ['Anthropic', 'greenhouse', 'anthropic', ['global']], ['Andela', 'greenhouse', 'andela', ['africa', 'remote']],
  ['Flutterwave', 'greenhouse', 'flutterwave', ['africa']], ['Moniepoint', 'greenhouse', 'moniepoint', ['africa']], ['Paystack', 'greenhouse', 'paystack', ['africa']],
  ['Chipper Cash', 'greenhouse', 'chippercash', ['africa']], ['Kuda', 'greenhouse', 'kuda', ['africa']], ['Wave', 'lever', 'wave', ['africa']],
  ['Yoco', 'lever', 'yoco', ['africa']], ['Mono', 'ashby', 'mono', ['africa']], ['Paga', 'lever', 'paga', ['africa']],
  ['Spotify', 'lever', 'spotify', ['global']], ['Plaid', 'lever', 'plaid', ['global']], ['Palantir', 'lever', 'palantir', ['global']],
  ['Wealthsimple', 'ashby', 'wealthsimple', ['ca']], ['Kraken', 'ashby', 'kraken.com', ['remote']], ['Mistral AI', 'lever', 'mistral', ['eu']],
  ['Ashby', 'ashby', 'ashby', ['remote']], ['Notion', 'ashby', 'notion', ['global']], ['Ramp', 'ashby', 'ramp', ['us']],
  ['Linear', 'ashby', 'linear', ['remote']], ['Vercel', 'ashby', 'vercel', ['remote']], ['OpenAI', 'ashby', 'openai', ['global']],
  ['Deel', 'ashby', 'deel', ['remote']], ['Supabase', 'ashby', 'supabase', ['remote']], ['PostHog', 'ashby', 'posthog', ['remote']],
  ['Replit', 'ashby', 'replit', ['us']], ['Cohere', 'ashby', 'cohere', ['global']], ['Zapier', 'ashby', 'zapier', ['remote']],
  ['Retool', 'ashby', 'retool', ['us']], ['Mercury', 'ashby', 'mercury', ['us']], ['Perplexity', 'ashby', 'perplexity', ['global']],
  ['Runway', 'ashby', 'runway', ['us']], ['Lattice', 'ashby', 'lattice', ['us']], ['Multiverse', 'ashby', 'multiverse', ['uk']],
];

async function answers(ats: Ats, token: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(URLS[ats](encodeURIComponent(token)), { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (res?.status === 429) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    return !!res?.ok;
  }
  return false;
}

const seed = process.argv.includes('--seed') || !existsSync(FILE);
const list: Company[] = seed
  ? CANDIDATES.map(([company, ats, token, regions]) => ({ company, ats, token, regions, active: true }))
  : JSON.parse(readFileSync(FILE, 'utf8'));

const checked: Company[] = [];
for (const c of list) {
  let found: Ats | null = null;
  for (const ats of [c.ats, ...(['greenhouse', 'lever', 'ashby'] as const).filter((a) => a !== c.ats)]) {
    if (await answers(ats, c.token)) {
      found = ats;
      break;
    }
  }
  checked.push({ ...c, ats: found ?? c.ats, active: !!found });
  console.log(`${found ? '✓' : '✗'} ${c.company.padEnd(16)} ${found ?? c.ats}/${c.token}`);
}
writeFileSync(FILE, JSON.stringify(checked, null, 2) + '\n');
console.log(`${checked.filter((c) => c.active).length} of ${checked.length} boards active → ${FILE}`);
