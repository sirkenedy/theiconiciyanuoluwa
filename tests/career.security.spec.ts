// Career Coach C1 in a real browser, against the built Vercel function + an in-memory Upstash (playwright.config.ts).
import { test, expect, type Page, type Request } from '@playwright/test';

const usageRequest = (page: Page) => page.waitForRequest((r) => r.url().includes('/api/career/usage'));

async function openCareer(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  const captured = usageRequest(page);
  const res = await page.goto('/career');
  const signedReq = await captured;
  await expect(page.locator('[data-usage-ready]')).toHaveCount(1);
  await expect(page.locator('[data-usage="messages"] [data-left]')).toHaveText('20 of 20 left');
  return { res: res!, signedReq, errors };
}

/** Raw rows straight from IndexedDB, as an attacker with disk access (or DevTools) would see them. */
const rawRows = (page: Page, store: string) =>
  page.evaluate(
    (store) =>
      new Promise<{ id: string; iv: number; ct: string }[]>((resolve) => {
        const r = indexedDB.open('career-coach');
        r.onsuccess = () => {
          const get = r.result.transaction(store).objectStore(store).getAll();
          get.onsuccess = () => {
            resolve(get.result.map((row: { id: string; iv: Uint8Array; ct: ArrayBuffer }) => ({ id: row.id, iv: row.iv.length, ct: new TextDecoder('latin1').decode(row.ct) })));
            r.result.close();
          };
        };
      }),
    store,
  );

const keyInfo = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ deviceId: string; vaultExtractable: boolean; privateExtractable: boolean; exportBlocked: boolean }>((resolve) => {
        const r = indexedDB.open('career-coach');
        r.onsuccess = () => {
          const s = r.result.transaction('keys').objectStore('keys');
          const out: Record<string, unknown> = {};
          let n = 0;
          for (const k of ['deviceId', 'vault', 'device']) {
            const g = s.get(k);
            g.onsuccess = async () => {
              out[k] = g.result;
              if (++n < 3) return;
              const exportBlocked = await crypto.subtle.exportKey('jwk', (out.device as CryptoKeyPair).privateKey).then(() => false, () => true);
              r.result.close();
              resolve({
                deviceId: out.deviceId as string,
                vaultExtractable: (out.vault as CryptoKey).extractable,
                privateExtractable: (out.device as CryptoKeyPair).privateKey.extractable,
                exportBlocked,
              });
            };
          }
        };
      }),
  );

async function headersOf(r: Request) {
  const h = await r.allHeaders();
  return Object.fromEntries(['x-device-id', 'x-timestamp', 'x-nonce', 'x-signature'].map((k) => [k, h[k]]));
}


// One network per test: the server allows only 3 new devices per network per day.
let netSeq = 0;
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `203.0.113.${(++netSeq % 250) + 1}-w${test.info().workerIndex}-${Date.now()}` });
});

test('CSP: per-request nonce, Trusted Types, no portfolio script, clean console', async ({ page }) => {
  const { res, errors } = await openCareer(page);
  const csp = res.headers()['content-security-policy'];
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' https:\/\/challenges\.cloudflare\.com/);
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res.headers()['referrer-policy']).toBe('no-referrer');
  const again = await page.request.get('/career');
  expect(again.headers()['content-security-policy']).not.toBe(csp);

  // The portfolio's entry script (hero, Journey, reactions, chat) never loads here.
  const home = await (await page.request.get('/')).text();
  const portfolioScripts = [...home.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const careerHtml = await (await page.request.get('/career')).text();
  for (const src of portfolioScripts) expect(careerHtml).not.toContain(src);
  expect(errors).toEqual([]);
});

test('CSP blocks an injected inline script; Trusted Types blocks innerHTML', async ({ page }) => {
  await openCareer(page);
  const result = await page.evaluate(async () => {
    const out = { inline: 'ran', html: 'allowed' };
    try {
      const s = document.createElement('script');
      s.textContent = 'window.__pwned = true';
      document.body.append(s);
    } catch {
      out.inline = 'threw';
    }
    await new Promise((r) => setTimeout(r, 50));
    if (!(window as unknown as { __pwned?: boolean }).__pwned) out.inline = out.inline === 'threw' ? 'threw' : 'blocked';
    try {
      document.body.insertAdjacentHTML('beforeend', '<img src=x onerror="window.__pwned2=1">');
    } catch {
      out.html = 'threw';
    }
    return out;
  });
  expect(result.inline).not.toBe('ran');
  expect(result.html).toBe('threw');
});

test('keys are non-extractable; stored chat is ciphertext', async ({ page }) => {
  await openCareer(page);
  await page.locator('#cc-input').fill('My secret plan is ZEBRA-42');
  await page.locator('#cc-input').press('Enter');
  await expect(page.locator('.cc-msg--coach:not(.is-live)')).toHaveCount(1);

  const keys = await keyInfo(page);
  expect(keys.vaultExtractable).toBe(false);
  expect(keys.privateExtractable).toBe(false);
  expect(keys.exportBlocked).toBe(true);

  const rows = [...(await rawRows(page, 'messages')), ...(await rawRows(page, 'conversations'))];
  expect(rows.length).toBe(3);
  for (const row of rows) {
    expect(row.iv).toBe(12);
    expect(row.ct).not.toContain('ZEBRA');
    expect(row.ct).not.toContain('secret');
  }
});

test('conversation restores exactly on reload, with "Welcome back"', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await openCareer(page);
  for (let i = 1; i <= 5; i++) {
    await page.locator('#cc-input').fill(`Question number ${i}: what should my résumé say about leading a team of designers through a long product launch?`);
    await page.locator('#cc-input').press('Enter');
    await expect(page.locator('.cc-msg--coach:not(.is-live)')).toHaveCount(i);
  }
  const log = page.locator('[data-log]');
  const target = await log.evaluate((el) => {
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
    return el.scrollTop;
  });
  expect(target).toBeGreaterThan(50);
  await page.waitForTimeout(400); // the scroll position is saved after a short pause
  const before = await page.locator('.cc-msg').allTextContents();

  await page.reload();
  await expect(page.locator('[data-welcome]')).toBeVisible();
  await expect(page.locator('[data-welcome]')).toContainText('Welcome back');
  await expect(page.locator('.cc-msg')).toHaveCount(before.length);
  expect(await page.locator('.cc-msg').allTextContents()).toEqual(before);
  expect(Math.abs((await log.evaluate((el) => el.scrollTop)) - target)).toBeLessThanOrEqual(1);
  await expect(page.locator('.cc-chat[aria-current="true"]')).toHaveCount(1);
});

test('signed requests: replayed, re-pointed, re-signed with another key or stale → all rejected', async ({ page }) => {
  const { signedReq } = await openCareer(page);
  const original = await headersOf(signedReq);
  const url = signedReq.url();

  // 1. Replay the browser's own request byte for byte.
  const replay = await page.request.get(url, { headers: original });
  expect(replay.status()).toBe(401);
  expect((await replay.json()).error).toBe('replay');

  // 2. Same headers, different query (the path is signed).
  const repointed = await page.request.get(url.replace(/day=[^&]+/, 'day=2000-01-01'), { headers: { ...original, 'x-nonce': 'AAAAAAAAAAAAAAAAAAAAAA' } });
  expect(repointed.status()).toBe(401);
  expect((await repointed.json()).error).toBe('bad-signature');

  // 3. A key that isn't this device's, claiming this device's id.
  const other = await page.evaluate(async ({ id, url }) => {
    const enc = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const u = new URL(url);
    const ts = String(Date.now());
    const nonce = enc(crypto.getRandomValues(new Uint8Array(16)));
    const bodyHash = enc(await crypto.subtle.digest('SHA-256', new Uint8Array()));
    const input = new TextEncoder().encode(['GET', u.pathname + u.search, ts, nonce, bodyHash].join('\n'));
    const sig = enc(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, input));
    return { 'x-device-id': id, 'x-timestamp': ts, 'x-nonce': nonce, 'x-signature': sig };
  }, { id: original['x-device-id'], url });
  const foreign = await page.request.get(url, { headers: other });
  expect(foreign.status()).toBe(401);
  expect((await foreign.json()).error).toBe('bad-signature');

  // 4. Signed by this device's real key, but 2 minutes old.
  const stale = await page.evaluate(async (url) => {
    const enc = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const db = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('career-coach');
      r.onsuccess = () => res(r.result);
    });
    const get = (k: string) => new Promise<unknown>((res) => {
      const g = db.transaction('keys').objectStore('keys').get(k);
      g.onsuccess = () => res(g.result);
    });
    const pair = (await get('device')) as CryptoKeyPair;
    const id = (await get('deviceId')) as string;
    const u = new URL(url);
    const ts = String(Date.now() - 120_000);
    const nonce = enc(crypto.getRandomValues(new Uint8Array(16)));
    const bodyHash = enc(await crypto.subtle.digest('SHA-256', new Uint8Array()));
    const input = new TextEncoder().encode(['GET', u.pathname + u.search, ts, nonce, bodyHash].join('\n'));
    const sig = enc(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, input));
    return { 'x-device-id': id, 'x-timestamp': ts, 'x-nonce': nonce, 'x-signature': sig };
  }, url);
  const old = await page.request.get(url, { headers: stale });
  expect(old.status()).toBe(401);
  expect((await old.json()).error).toBe('stale');
});

test('"Delete everything" clears chats but keeps the device, so today\'s usage survives', async ({ page }) => {
  await openCareer(page);
  await page.locator('#cc-input').fill('Something to delete');
  await page.locator('#cc-input').press('Enter');
  await expect(page.locator('.cc-msg--coach:not(.is-live)')).toHaveCount(1);
  const before = (await keyInfo(page)).deviceId;

  await page.locator('[data-delete]').click();
  const reloaded = page.waitForNavigation();
  await page.locator('[data-delete-yes]').click();
  await reloaded;
  await expect(page.locator('[data-usage-ready]')).toHaveCount(1);
  await expect(page.locator('.cc-msg')).toHaveCount(0);
  await expect(page.locator('[data-welcome]')).toBeHidden();
  expect((await keyInfo(page)).deviceId).toBe(before);
  await expect(page.locator('[data-usage="messages"] [data-left]')).toHaveText('19 of 20 left');
});

test('phone: the rail is a panel the hamburger opens and Escape closes (no peek bar)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCareer(page);
  const menu = page.getByRole('button', { name: 'Chats, résumé and usage' });
  await expect(page.locator('.cc-peek')).toHaveCount(0);
  await expect(page.locator('[data-new-chat]')).not.toBeInViewport();
  await menu.click();
  await expect(page.locator('[data-new-chat]')).toBeInViewport();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeFocused();
});

test('isolation: "/" never requests Career Coach code, even after the chat island loads', async ({ page }) => {
  const careerHtml = await (await page.request.get('/career')).text();
  const careerEntry = careerHtml.match(/<script[^>]+src="(\/_astro\/[^"]+)"/)![1];
  const urls: string[] = [];
  page.on('request', (r) => urls.push(new URL(r.url()).pathname));
  await page.goto('/');
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await page.locator('.twin').hover();
  await page.waitForTimeout(1500);
  expect(urls.length).toBeGreaterThan(3);
  expect(urls).not.toContain(careerEntry);
  expect(urls.filter((u) => /pdf|mammoth|\/api\/career|\/api\/device/.test(u))).toEqual([]);
});

test('model output is sanitised: no <img onerror>, no <script>, no javascript: links; real links get rel=noopener', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `xss-${Date.now()}` });
  await openCareer(page);
  await page.locator('#cc-input').fill('XSS-TEST please');
  await page.locator('#cc-input').press('Enter');
  const answer = page.locator('.cc-msg--coach:not(.is-live) .cc-msg__text').last();
  await expect(answer).toContainText('Safe bold.');
  await expect(answer.locator('strong')).toHaveText('bold');
  await expect(answer.locator('img, script')).toHaveCount(0);
  await expect(answer.locator('a[href^="javascript"]')).toHaveCount(0);
  const link = answer.locator('a', { hasText: 'a real link' });
  await expect(link).toHaveAttribute('href', 'https://example.org/guide');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  await expect(link).toHaveAttribute('target', '_blank');
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  // Survives a reload too (restored messages are sanitised the same way).
  await page.reload();
  await expect(page.locator('.cc-msg--coach .cc-msg__text').last().locator('img, script, a[href^="javascript"]')).toHaveCount(0);
});

// Uses the second server (playwright.config.ts): Cloudflare's always-pass Turnstile test keys and a $0 budget.
// It talks to the real challenges.cloudflare.com, so it needs network access.
test('Turnstile under the strict CSP + Trusted Types registers the device; a spent budget shows the breather state', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  const registered = page.waitForResponse((r) => r.url().includes('/api/device/register'));
  const res = await page.goto('http://localhost:4325/career');
  expect(res!.headers()['content-security-policy']).toContain('script-src \'self\' \'nonce-');
  // Browsers hide nonce attributes after parsing; the property still holds it.
  expect(await page.locator('script[src^="https://challenges.cloudflare.com/turnstile/"]').evaluate((el) => (el as HTMLScriptElement).nonce)).toBeTruthy();
  const reg = await registered;
  expect(reg.status()).toBe(200);
  expect(JSON.parse(reg.request().postData()!).turnstile).toBeTruthy();

  await expect(page.locator('[data-breather]')).toBeVisible();
  await expect(page.locator('[data-breather]')).toContainText('Taking a breather until tomorrow');
  await expect(page.locator('#cc-input')).toBeDisabled();
  // Harnie (the portfolio) is unaffected and linked from the resting state.
  await expect(page.locator('[data-breather] a')).toHaveAttribute('href', '/');
  expect(errors.filter((e) => !/challenges\.cloudflare\.com|Private Access Token|preloaded using link preload/.test(e))).toEqual([]);
});

test('privacy page: linked from the consent line and the sidebar; names the AI provider, sources and how to delete', async ({ page }) => {
  await openCareer(page);
  await expect(page.locator('.cc-consent-link')).toHaveAttribute('href', '/career/privacy');
  await expect(page.locator('.cc-lock a')).toHaveAttribute('href', '/career/privacy');
  await page.goto('/career/privacy');
  await expect(page.locator('h1')).toHaveText('Your data stays with you.');
  for (const text of ['Anthropic', 'Haiku-class', 'email address and phone number are removed', 'Cloudflare Turnstile', 'Delete everything', '90 days']) await expect(page.locator('main')).toContainText(text);
  for (const source of ['Greenhouse', 'Lever', 'Ashby', 'Himalayas', 'Remotive', 'Jobicy']) await expect(page.locator('main a', { hasText: source })).toHaveCount(1);
});
