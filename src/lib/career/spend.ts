// The global daily AI spend kill switch (career-mode.md §7). Spend is counted from each response's real token usage at
// Haiku-class rates and summed in Redis per UTC day, in micro-dollars (integers, so INCRBY stays exact). When it reaches
// CAREER_DAILY_BUDGET_USD (default 1), Career Coach takes a breather until tomorrow; Harnie and the portfolio don't.
import { pipeline, type Redis } from '../redis.ts';

/** claude-haiku-5-5, USD per million tokens (prompts up to 100K tokens; ours are far smaller). */
export const RATES = { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 } as const;

export type Usage = { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };

const spendKey = (now = new Date()) => `career:spend:${now.toISOString().slice(0, 10)}`;
export const budgetUsd = () => {
  const n = Number(process.env.CAREER_DAILY_BUDGET_USD);
  return Number.isFinite(n) && n >= 0 ? n : 1;
};

/** Micro-dollars: tokens × (USD per million tokens) = millionths of a dollar. */
export function costMicros(u: Usage | null | undefined): number {
  if (!u) return 0;
  return Math.ceil(
    (u.input_tokens ?? 0) * RATES.input +
      (u.output_tokens ?? 0) * RATES.output +
      (u.cache_creation_input_tokens ?? 0) * RATES.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * RATES.cacheRead,
  );
}

export async function overBudget(redis: Redis): Promise<boolean> {
  const [spent] = await pipeline(redis, [['GET', spendKey()]]);
  return Number(spent ?? 0) >= budgetUsd() * 1_000_000;
}

/** Adds one response's cost to today's total. Never blocks or fails the visitor's request. */
export function recordSpend(redis: Redis, usage: Usage | null | undefined) {
  const micros = costMicros(usage);
  if (!micros) return;
  const key = spendKey();
  pipeline(redis, [['INCRBY', key, micros], ['EXPIRE', key, 3 * 86_400]]).catch(() => {});
}

export const breather = () =>
  new Response(JSON.stringify({ error: 'breather' }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
