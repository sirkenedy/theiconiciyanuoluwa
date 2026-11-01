// Shared by the browser (src/lib/device.ts) and the server (src/lib/career/verify.ts), so both sign and check the
// exact same bytes. WebCrypto only: runs in browsers, Node and Vercel functions.

export const HEADER = { device: 'x-device-id', timestamp: 'x-timestamp', nonce: 'x-nonce', signature: 'x-signature' } as const;
export const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
export const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;
/** Max clock difference between the device and the server. */
export const MAX_SKEW_MS = 60_000;
/** How long a used nonce is remembered (longer than the skew window, so a replay can't outlive it). */
export const NONCE_TTL_S = 300;

const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of view) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const sha256 = async (data: string | Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));

export type PublicJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };

/** The public key in a fixed key order, so its hash (the deviceId) is stable. */
export function canonicalJwk(jwk: { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown }): string | null {
  const ok = jwk.kty === 'EC' && jwk.crv === 'P-256' && [jwk.x, jwk.y].every((v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v));
  return ok ? JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y }) : null;
}

export const deviceIdFor = async (canonical: string) => b64url(await sha256(canonical));

/** method + path (with query) + timestamp + nonce + SHA-256(body), one per line. */
export async function signingInput(method: string, pathAndQuery: string, timestamp: string, nonce: string, body: string) {
  return enc.encode([method.toUpperCase(), pathAndQuery, timestamp, nonce, b64url(await sha256(body))].join('\n'));
}
