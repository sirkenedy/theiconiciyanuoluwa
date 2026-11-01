// Device identity for Career Coach's API (career-mode.md §4.3): a non-extractable ECDSA P-256 key pair in IndexedDB.
// The server knows only the public key; every request is signed, so there is no cookie, token or ID worth stealing.
import { ECDSA, ECDSA_SIGN, HEADER, b64url, canonicalJwk, signingInput } from './career/signing.ts';
import { getKey, putKey } from './vault.ts';

let pair: CryptoKeyPair | null = null;
let deviceId: string | null = null;
/** Server clock minus ours, learned from a "stale" rejection, so a wrong device clock doesn't lock the visitor out. */
let skew = 0;

async function keys(): Promise<CryptoKeyPair> {
  if (pair) return pair;
  pair = (await getKey<CryptoKeyPair>('device')) ?? null;
  if (!pair) {
    pair = await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']);
    await putKey('device', pair);
  }
  return pair;
}

type Turnstile = {
  render(el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; 'error-callback': () => void; 'timeout-callback'?: () => void; appearance?: string; execution?: string }): string;
  execute(el: HTMLElement): void;
  reset(id: string): void;
  remove(id: string): void;
};

/** An invisible Turnstile token, when the page offers a site key (the server then requires it). */
async function turnstileToken(): Promise<string | undefined> {
  const box = document.querySelector<HTMLElement>('[data-turnstile-sitekey]');
  const sitekey = box?.dataset.turnstileSitekey;
  if (!box || !sitekey) return undefined;
  const ts = await new Promise<Turnstile>((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const t = (window as unknown as { turnstile?: Turnstile }).turnstile;
      if (t) return resolve(t);
      if (Date.now() - started > 15_000) return reject(new Error('turnstile unavailable'));
      setTimeout(poll, 100);
    };
    poll();
  });
  return new Promise((resolve, reject) => {
    // Once it has answered (either way) the widget is removed, so it can never sit on top of the page's buttons.
    const done = () => setTimeout(() => ts.remove(id));
    const id = ts.render(box, {
      sitekey,
      appearance: 'interaction-only',
      execution: 'execute',
      callback: (t) => (resolve(t), done()),
      'error-callback': () => (reject(new Error('turnstile')), done()),
      'timeout-callback': () => ts.reset(id),
    });
    ts.execute(box);
  });
}

/** This network already set up today's new devices (e.g. after "Delete everything"): limits can't be reset that way. */
export class TooManyDevices extends Error {}

async function register(): Promise<string> {
  // Public keys stay exportable even when the pair is generated non-extractable; the private key never leaves.
  const jwk = canonicalJwk(await crypto.subtle.exportKey('jwk', (await keys()).publicKey));
  const res = await fetch('/api/device/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jwk: jwk && JSON.parse(jwk), turnstile: await turnstileToken() }),
  });
  if (res.status === 429) throw new TooManyDevices();
  if (!res.ok) throw new Error(`register ${res.status}`);
  ({ deviceId } = (await res.json()) as { deviceId: string });
  await putKey('deviceId', deviceId);
  return deviceId!;
}

export async function getDeviceId(): Promise<string> {
  return deviceId ?? (deviceId = (await getKey<string>('deviceId')) ?? null) ?? register();
}

async function send(path: string, method: string, body: string) {
  const id = await getDeviceId();
  const timestamp = String(Date.now() + skew);
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const signature = b64url(await crypto.subtle.sign(ECDSA_SIGN, (await keys()).privateKey, await signingInput(method, path, timestamp, nonce, body)));
  return fetch(path, {
    method,
    headers: {
      [HEADER.device]: id,
      [HEADER.timestamp]: timestamp,
      [HEADER.nonce]: nonce,
      [HEADER.signature]: signature,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: method === 'GET' ? undefined : body,
  });
}

/** A signed request to /api/career/*. `path` includes any query string: it is part of what's signed. */
export async function deviceFetch(path: string, opts: { method?: string; body?: string } = {}): Promise<Response> {
  try {
    return await signedFetch(path, opts);
  } catch (err) {
    if (err instanceof TooManyDevices) return new Response(JSON.stringify({ error: 'devices' }), { status: 429, headers: { 'content-type': 'application/json' } });
    throw err;
  }
}

async function signedFetch(path: string, { method = 'GET', body = '' }: { method?: string; body?: string }): Promise<Response> {
  const res = await send(path, method, body);
  if (res.status !== 401) return res;
  const { error, now } = (await res.clone().json().catch(() => ({}))) as { error?: string; now?: number };
  if (error === 'unknown-device') {
    // The server forgot this key (expired after 90 days idle): register it again and retry once.
    await register();
    return send(path, method, body);
  }
  if (error === 'stale' && now) {
    skew = now - Date.now();
    return send(path, method, body);
  }
  return res;
}
