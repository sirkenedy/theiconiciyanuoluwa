// Minimal Upstash Redis REST client (pipeline endpoint) shared by the API routes.

export type Redis = { url: string; token: string };

// Vercel's Upstash integration sets KV_REST_API_*; a direct Upstash database uses UPSTASH_REDIS_REST_*.
export function redisConfig(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

export async function pipeline(redis: Redis, commands: (string | number)[][]): Promise<unknown[]> {
  const res = await fetch(`${redis.url}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${redis.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  const rows = (await res.json()) as { result?: unknown; error?: string }[];
  return rows.map((r) => {
    if (r.error) throw new Error(r.error);
    return r.result;
  });
}

/** Short, salted SHA-256 so raw IPs and questions never become Redis keys. */
export async function digest(scope: string, value: string, bytes = 8) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${scope}:${value}`));
  return [...new Uint8Array(hash).slice(0, bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function clientIp(request: Request, fallback: () => string) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0].trim();
  if (forwarded) return forwarded;
  try {
    return fallback() || 'unknown';
  } catch {
    return 'unknown';
  }
}
