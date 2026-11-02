// The "Share my progress" card as a PNG, in Soft Clay (design/tokens.css only): Ami's orb, the visitor's numbers on
// pastel clay tiles, an optional score trend and highlight, and an invitation to try Ami. One renderer for the share
// preview, the downloaded image and the link preview, so they always match. Server only (satori + resvg).
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import satori from 'satori';
import { lightTokens as t } from '../tokens';
import { CARD_SIZES, type CardData, type CardFormat } from './card';

type Node = { type: string; props: { style?: Record<string, unknown>; children?: Node | string | (Node | string | null)[] | null } };
const el = (style: Record<string, unknown>, children?: Node['props']['children']): Node => ({ type: 'div', props: { style: { display: 'flex', boxSizing: 'border-box', ...style }, children } });

/** An arrow drawn in clay ink (the bundled fonts have no "→"). */
const arrow = (size: number, color: string) =>
  el({ alignItems: 'center', width: size, height: size * 0.6, marginLeft: size * 0.35, flexShrink: 0 }, [
    el({ width: size * 0.78, height: Math.max(3, size * 0.12), borderRadius: 99, background: color }),
    el({ width: size * 0.42, height: size * 0.42, marginLeft: -size * 0.36, borderTop: `${Math.max(3, size * 0.12)}px solid ${color}`, borderRight: `${Math.max(3, size * 0.12)}px solid ${color}`, borderRadius: 3, transform: 'rotate(45deg)' }),
  ]);

let fonts: { name: string; data: Buffer; weight: 800 | 500; style: 'normal' }[] | null = null;
/** Bundled with the function (astro.config includeFiles): the same OFL fonts as the site. */
function loadFonts() {
  fonts ??= [
    { name: 'Bricolage', data: readFileSync(join(process.cwd(), 'src/assets/og/bricolage-800.ttf')), weight: 800, style: 'normal' },
    { name: 'DM Sans', data: readFileSync(join(process.cwd(), 'src/assets/og/dm-sans-500.ttf')), weight: 500, style: 'normal' },
  ];
  return fonts;
}

const sphere = (size: number, tone: 'peach' | 'lilac' | 'mint' | 'butter', style: Record<string, unknown> = {}) =>
  el({ position: 'absolute', width: size, height: size, borderRadius: '50%', backgroundImage: `radial-gradient(circle at 34% 28%, ${t[`${tone}-hi`]} 0%, ${t[tone]} 45%, ${t[`${tone}-deep`]} 100%)`, ...style });

/** Ami: a lilac clay orb with eyes, smiling. */
const ami = (size: number) =>
  el({ position: 'relative', width: size, height: size, flexShrink: 0 }, [
    sphere(size, 'lilac', { left: 0, top: 0 }),
    el({ position: 'absolute', left: size * 0.33, top: size * 0.36, width: size * 0.1, height: size * 0.14, borderRadius: '50%', background: t['on-pastel'] }),
    el({ position: 'absolute', left: size * 0.57, top: size * 0.36, width: size * 0.1, height: size * 0.14, borderRadius: '50%', background: t['on-pastel'] }),
    el({ position: 'absolute', left: size * 0.38, top: size * 0.56, width: size * 0.24, height: size * 0.12, borderBottom: `${Math.max(3, size * 0.035)}px solid ${t['on-pastel']}`, borderRadius: '0 0 999px 999px' }),
  ]);

type Tile = { value: string; label: string; tone: 'peach' | 'mint' | 'butter' | 'lilac' };
function tiles(c: CardData): Tile[] {
  const out: Tile[] = [];
  const say = (n: number, one: string, many: string) => (n === 1 ? one : many);
  if (c.applied !== null) out.push({ value: String(c.applied), label: say(c.applied, 'application', 'applications'), tone: 'peach' });
  if (c.interviews !== null) out.push({ value: String(c.interviews), label: say(c.interviews, 'interview', 'interviews'), tone: 'mint' });
  if (c.offers) out.push({ value: String(c.offers), label: say(c.offers, 'offer', 'offers'), tone: 'butter' });
  if (c.practice !== null) out.push({ value: String(c.practice), label: say(c.practice, 'mock interview', 'mock interviews'), tone: 'lilac' });
  return out;
}

const tile = (x: Tile, w: number, h: number, big: number) =>
  el(
    { width: w, height: h, flexDirection: 'column', justifyContent: 'flex-end', padding: Math.round(h * 0.14), borderRadius: Math.round(h * 0.2), background: t[x.tone], boxShadow: `0 ${Math.round(h * 0.045)}px 0 ${t[`${x.tone}-ledge`]}`, color: t['on-pastel'] },
    [el({ fontFamily: 'Bricolage', fontSize: big, lineHeight: 0.9, letterSpacing: -2 }, x.value), el({ marginTop: Math.round(big * 0.16), fontSize: Math.round(big * 0.27) }, x.label)],
  );

const pill = (text: string, size: number, dark = false, go = false) =>
  el(
    {
      alignSelf: 'flex-start',
      alignItems: 'center',
      flexShrink: 0,
      padding: `${Math.round(size * 0.45)}px ${Math.round(size * 0.95)}px`,
      borderRadius: 999,
      background: dark ? t['btn-primary-bg'] : t.surface,
      color: dark ? t['btn-primary-fg'] : t.ink,
      boxShadow: `0 ${Math.round(size * 0.22)}px 0 ${dark ? t['btn-primary-ledge'] : t.line}`,
      fontFamily: dark ? 'Bricolage' : 'DM Sans',
      fontSize: size,
    },
    go ? [el({}, text), arrow(size * 0.9, dark ? t['btn-primary-fg'] : t.ink)] : text,
  );

function headline(c: CardData) {
  const first = c.name ? `${c.name.split(' ')[0]}'s` : 'My';
  return [`${first} job search`, c.period === 'week' ? 'this week' : 'so far'];
}

/** The score trend and the highlight, as small clay cards. */
function extras(c: CardData, scale: number) {
  const out: Node[] = [];
  if (c.score)
    out.push(
      el({ flexDirection: 'column', flexGrow: 1, flexBasis: 0, padding: 30 * scale, borderRadius: 34 * scale, background: t.surface, boxShadow: `0 ${8 * scale}px 0 ${t.line}` }, [
        el({ fontSize: 24 * scale, color: t['ink-subtle'] }, 'Interview practice score'),
        el({ alignItems: 'flex-end', marginTop: 10 * scale }, [
          el({ fontFamily: 'Bricolage', fontSize: 64 * scale, letterSpacing: -2, lineHeight: 1, color: t['ink-subtle'] }, String(c.score[0])),
          el({ margin: `0 ${4 * scale}px ${22 * scale}px ${10 * scale}px` }, [arrow(40 * scale, t['mint-deep'])]),
          el({ fontFamily: 'Bricolage', fontSize: 64 * scale, letterSpacing: -2, lineHeight: 1 }, String(c.score[1])),
          el({ fontSize: 24 * scale, marginLeft: 10 * scale, marginBottom: 8 * scale, color: t['ink-subtle'] }, '/ 5'),
        ]),
      ]),
    );
  if (c.goal && c.goal[0] >= c.goal[1])
    out.push(
      el({ flexDirection: 'column', flexGrow: 1, flexBasis: 0, padding: 30 * scale, borderRadius: 34 * scale, background: t['mint-hi'], boxShadow: `0 ${8 * scale}px 0 ${t['mint-ledge']}` }, [
        el({ fontSize: 24 * scale, color: t['ink-subtle'] }, 'Weekly goal reached'),
        el({ fontFamily: 'Bricolage', fontSize: 52 * scale, letterSpacing: -1.5, marginTop: 10 * scale, lineHeight: 1.05 }, `${c.goal[0]} applications`),
      ]),
    );
  return out;
}

const quote = (c: CardData, scale: number, inRow = false) =>
  c.highlight
    ? el({ flexDirection: 'column', ...(inRow ? { flexGrow: 1, flexBasis: 0 } : {}), padding: `${28 * scale}px ${34 * scale}px`, borderRadius: 34 * scale, background: t['lilac-hi'], boxShadow: `0 ${8 * scale}px 0 ${t['lilac-ledge']}` }, [
        el({ fontSize: 22 * scale, color: t['ink-subtle'], textTransform: 'uppercase', letterSpacing: 2 }, inRow ? 'My top strength' : 'My top strength, from my mock interview'),
        el({ fontFamily: 'Bricolage', fontSize: 40 * scale, letterSpacing: -1, marginTop: 10 * scale, lineHeight: 1.15 }, `“${c.highlight}”`),
      ])
    : null;

function brand(size: number) {
  return el({ alignItems: 'center' }, [
    ami(size),
    el({ flexDirection: 'column', marginLeft: size * 0.28 }, [
      el({ fontFamily: 'Bricolage', fontSize: size * 0.46, letterSpacing: -1, lineHeight: 1 }, 'Ami'),
      el({ fontSize: size * 0.27, color: t['ink-subtle'], marginTop: size * 0.05 }, 'Free AI career coach'),
    ]),
  ]);
}

function footer(host: string, size: number) {
  return el({ alignItems: 'center', justifyContent: 'space-between' }, [
    el({ flexDirection: 'column' }, [
      el({ fontFamily: 'Bricolage', fontSize: size * 1.05, letterSpacing: -0.5 }, 'Jobs, CV tailoring and mock interviews'),
      el({ fontSize: size * 0.85, color: t['ink-subtle'], marginTop: size * 0.25 }, `${host}/career`),
    ]),
    pill('Try Ami free', size, true, true),
  ]);
}

function layout(c: CardData, format: CardFormat, host: string): Node {
  const { width, height } = CARD_SIZES[format];
  const [h1, h2] = headline(c);
  const list = tiles(c);
  // A little clay in the corner, clear of the words and numbers.
  const wide = format === 'wide';
  const decor = [
    el({ position: 'absolute', right: -150, top: wide ? -170 : -150, width: 300, height: 300, borderRadius: '50%', background: t['surface-sunk'] }),
    el({ position: 'absolute', right: 34, top: wide ? 18 : 40, width: 66, height: 66, borderRadius: '50%', border: `15px solid ${t.butter}` }),
    sphere(40, 'mint', { right: 120, top: wide ? 14 : 26 }),
  ];

  if (format === 'wide') {
    const tw = 230;
    return el({ width, height, background: t.bg, position: 'relative', fontFamily: 'DM Sans', color: t.ink, padding: 56 }, [
      ...decor,
      el({ flexDirection: 'column', width: 600, justifyContent: 'space-between' }, [
        brand(64),
        el({ flexDirection: 'column', fontFamily: 'Bricolage', fontSize: 72, lineHeight: 0.98, letterSpacing: -3 }, [el({}, h1), el({ color: t['ink-accent'] }, h2)]),
        el({ flexDirection: 'column' }, [el({ fontSize: 24, color: t['ink-subtle'], marginBottom: 18 }, `${host}/career`), pill('Try Ami free', 30, true, true)]),
      ]),
      el({ flexDirection: 'column', marginLeft: 'auto', marginTop: 40, justifyContent: 'center', gap: 22 }, [
        el({ flexWrap: 'wrap', width: tw * 2 + 22, gap: 22 }, list.slice(0, 4).map((x) => tile(x, tw, c.score ? 160 : 200, c.score ? 64 : 80))),
        ...(c.score ? [el({ width: tw * 2 + 22 }, extras({ ...c, goal: null }, 0.75))] : []),
      ]),
    ]);
  }

  const story = format === 'story';
  const pad = story ? 88 : 72;
  const inner = width - pad * 2;
  const gap = 24;
  const perRow = story || list.length <= 2 ? 2 : list.length;
  const tw = Math.floor((inner - gap * (perRow - 1)) / perRow);
  const more = extras(c, story ? 1.15 : 1);
  // Few things to show: bigger tiles fill the card instead of leaving a gap.
  const sparse = !story && !more.length && !c.highlight;
  const th = story ? 300 : sparse ? 340 : perRow === 2 ? 250 : 220;
  const big = story ? 132 : sparse ? 156 : perRow === 2 ? 118 : 92;
  return el({ width, height, background: t.bg, position: 'relative', flexDirection: 'column', fontFamily: 'DM Sans', color: t.ink, padding: pad, justifyContent: story ? 'center' : 'flex-start' }, [
    ...decor,
    el({ alignItems: 'center' }, [brand(story ? 104 : 84)]),
    el({ flexDirection: 'column', marginTop: story ? 96 : 52, fontFamily: 'Bricolage', fontSize: story ? 112 : 84, lineHeight: 0.98, letterSpacing: -3.5 }, [el({}, h1), el({ color: t['ink-accent'] }, h2)]),
    el({ flexWrap: 'wrap', gap, marginTop: story ? 80 : 44 }, list.map((x) => tile(x, tw, th, big))),
    // Square: the highlight sits beside a lone score card; with two cards there it has a row of its own only if tiles fit on one row.
    ...(more.length || c.highlight
      ? story
        ? [...(more.length ? [el({ gap, marginTop: 40 }, more)] : []), ...(c.highlight ? [el({ marginTop: 40, flexDirection: 'column' }, [quote(c, 1.15)])] : [])]
        : more.length < 2 && c.highlight
          ? [el({ gap, marginTop: 30 }, [...more, quote(c, more.length ? 0.85 : 0.9, true)])]
          : [...(more.length ? [el({ gap, marginTop: 30 }, more)] : []), ...(c.highlight && list.length <= 2 ? [el({ marginTop: 30, flexDirection: 'column' }, [quote(c, 0.9)])] : [])]
      : []),
    el({ marginTop: 'auto', paddingTop: story ? 80 : 30, flexDirection: 'column' }, [footer(host, story ? 30 : 26)]),
  ]);
}

export async function cardPng(c: CardData, format: CardFormat, host: string): Promise<Uint8Array> {
  const { width, height } = CARD_SIZES[format];
  const svg = await satori(layout(c, format, host) as never, { width, height, fonts: loadFonts() });
  return new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
}
