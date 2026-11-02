import type { APIRoute } from 'astro';
import { CARD_SIZES, cardSecret, readCardToken, type CardFormat } from '../../../lib/career/card.ts';
import { cardPng } from '../../../lib/career/card-image.ts';

export const prerender = false;

/** A shared card's image (wide for link previews; ?f=square|story too). The link is the card: nothing is looked up. */
export const GET: APIRoute = async ({ params, url, site }) => {
  const card = await readCardToken(params.token ?? '', cardSecret());
  if (!card) return new Response('Not found', { status: 404 });
  const f = url.searchParams.get('f');
  const format: CardFormat = f && f in CARD_SIZES ? (f as CardFormat) : 'wide';
  const png = await cardPng(card, format, new URL(site ?? url).host);
  // The same link always draws the same card: cache it hard (link-preview crawlers fetch it repeatedly).
  return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' } });
};
