// The global daily AI spend kill switch (career-mode.md §7). Spend is counted from each response's real token usage at
// each model's rates and summed in Redis per UTC day, in micro-dollars (integers, so INCRBY stays exact). When it reaches
// CAREER_DAILY_BUDGET_USD (default 1), Career Coach takes a breather until tomorrow; Harnie and the portfolio don't.
import { pipeline, type Redis } from '../redis.ts';

/** USD per million tokens. Haiku for everything but prep guides (Sonnet); web searches cost USD 10 per 1,000. */
export const RATES = { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 } as const;
export const SONNET_RATES = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } as const;
const WEB_SEARCH_MICROS = 10_000;

export type Usage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};
type Rates = { input: number; output: number; cacheWrite: number; cacheRead: number };

const spendKey = (now = new Date()) => `career:spend:${now.toISOString().slice(0, 10)}`;
export const budgetUsd = () => {
  const n = Number(process.env.CAREER_DAILY_BUDGET_USD);
  return Number.isFinite(n) && n >= 0 ? n : 1;
};

/** Micro-dollars: tokens × (USD per million tokens) = millionths of a dollar. */
export function costMicros(u: Usage | null | undefined, rates: Rates = RATES): number {
  if (!u) return 0;
  return Math.ceil(
    (u.input_tokens ?? 0) * rates.input +
      (u.output_tokens ?? 0) * rates.output +
      (u.cache_creation_input_tokens ?? 0) * rates.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * rates.cacheRead +
      (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_MICROS,
  );
}

export async function overBudget(redis: Redis): Promise<boolean> {
  const [spent] = await pipeline(redis, [['GET', spendKey()]]);
  return Number(spent ?? 0) >= budgetUsd() * 1_000_000;
}

/** Adds one response's cost to today's total. Never blocks or fails the visitor's request. */
export function recordSpend(redis: Redis, usage: Usage | null | undefined, rates: Rates = RATES) {
  const micros = costMicros(usage, rates);
  if (!micros) return;
  const key = spendKey();
  pipeline(redis, [['INCRBY', key, micros], ['EXPIRE', key, 3 * 86_400]]).catch(() => {});
}

export const breather = () =>
  new Response(JSON.stringify({ error: 'breather' }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
