// "Share my progress" cards: the link carries the card, signed, so it can't be edited into other numbers. `npm run test:unit`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardCaption, cardToken, cleanCard, readCardToken } from '../src/lib/career/card.ts';

const card = { name: 'Ade Bello', period: 'week' as const, applied: 6, interviews: 2, offers: null, practice: 3, score: [2.9, 4.2] as [number, number], highlight: 'Clear, measurable results', goal: [6, 5] as [number, number] };

test('a card round-trips through its link; any edit to the link is refused', async () => {
  const token = await cardToken(card, 'secret');
  assert.deepEqual(await readCardToken(token, 'secret'), card);
  assert.equal(await readCardToken(token, 'other-secret'), null, 'signed with our secret only');
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ n: 'Ade', p: 0, a: 999, i: 2, o: null, m: 3, s: null, h: null, g: null })).toString('base64url');
  assert.equal(await readCardToken(`${forged}.${sig}`, 'secret'), null, 'numbers changed in the link');
  assert.equal(await readCardToken(`${body}.${sig.slice(0, -1)}x`, 'secret'), null);
  assert.equal(await readCardToken('nonsense', 'secret'), null);
});

test('only plain, bounded values reach a card', () => {
  const c = cleanCard({ name: '  <script>Ade</script>\n', applied: 4.6, interviews: -3, offers: 1e9, practice: 'x', score: [0, 9], highlight: 'x'.repeat(200), goal: [3, 0], period: 'whatever' })!;
  assert.equal(c.name, 'scriptAde/script');
  assert.equal(c.applied, 5);
  assert.equal(c.interviews, 0);
  assert.equal(c.offers, 999);
  assert.equal(c.practice, null);
  assert.deepEqual(c.score, [1, 5]);
  assert.equal(c.highlight?.length, 90);
  assert.equal(c.goal, null, 'a goal of 0 is no goal');
  assert.equal(c.period, 'week');
  assert.equal(cleanCard({ name: 'Ade' }), null, 'a card needs something to show');
});

test('the caption says what the card shows, and invites people to try Ami', () => {
  assert.equal(
    cardCaption(card, 'https://x.test/career/card/abc'),
    "This week: 6 applications, 2 interviews, 3 mock interviews. My interview practice score went from 2.9 to 4.2 out of 5. I'm practising with Ami, a free AI career coach. Try it: https://x.test/career/card/abc",
  );
  assert.match(cardCaption({ ...card, period: 'all', applied: 1, interviews: null, practice: null, score: null }, 'u'), /^My job search so far: 1 application\. I'm practising/);
});
