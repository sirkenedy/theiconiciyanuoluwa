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
  if (c.found !== null) out.push({ value: String(c.found), label: say(c.found, 'job found', 'jobs found'), tone: 'mint' });
  if (c.docs !== null) out.push({ value: String(c.docs), label: say(c.docs, 'document made', 'documents made'), tone: 'butter' });
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
  if (c.goal)
    out.push(
      el({ flexDirection: 'column', flexGrow: 1, flexBasis: 0, padding: 30 * scale, borderRadius: 34 * scale, background: t['mint-hi'], boxShadow: `0 ${8 * scale}px 0 ${t['mint-ledge']}` }, [
        el({ fontSize: 24 * scale, color: t['ink-subtle'] }, c.goal[0] >= c.goal[1] ? 'Weekly goal reached' : 'Weekly goal'),
        el({ fontFamily: 'Bricolage', fontSize: 52 * scale, letterSpacing: -1.5, marginTop: 10 * scale, lineHeight: 1.05 }, c.goal[0] >= c.goal[1] ? `${c.goal[0]} applications` : `${c.goal[0]} of ${c.goal[1]} done`),
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

/** "Going for: Senior Product Manager" */
const rolePill = (role: string, size: number) =>
  el({ alignSelf: 'flex-start', alignItems: 'center', padding: `${size * 0.4}px ${size * 0.8}px`, borderRadius: 999, background: t.surface, boxShadow: `0 ${size * 0.2}px 0 ${t.line}`, fontSize: size }, [
    el({ color: t['ink-subtle'], marginRight: size * 0.35 }, 'Going for'),
    el({ fontFamily: 'Bricolage', letterSpacing: -0.5 }, role),
  ]);

/** Ami's story about them, in a speech bubble from her orb. */
const storyBubble = (text: string, size: number) =>
  el({ flexDirection: 'column', padding: `${size * 0.9}px ${size * 1.05}px`, borderRadius: size * 1.2, background: t.surface, boxShadow: `0 ${size * 0.24}px 0 ${t['lilac-ledge']}` }, [
    el({ alignItems: 'center', marginBottom: size * 0.45 }, [ami(size * 1.5), el({ marginLeft: size * 0.4, fontSize: size * 0.62, color: t['ink-subtle'], textTransform: 'uppercase', letterSpacing: 2 }, 'Ami says')]),
    el({ fontFamily: 'Bricolage', fontSize: size, lineHeight: 1.22, letterSpacing: -0.5 }, text),
  ]);

/** Companies and skills as small clay chips. */
function chips(c: CardData, size: number) {
  const row = (label: string, items: string[], tone: 'butter' | 'lilac') =>
    el({ alignItems: 'center', flexWrap: 'wrap', gap: size * 0.45 }, [
      el({ fontSize: size * 0.85, color: t['ink-subtle'], marginRight: size * 0.15 }, label),
      ...items.map((x) => el({ padding: `${size * 0.3}px ${size * 0.7}px`, borderRadius: 999, background: t[tone], boxShadow: `0 ${size * 0.15}px 0 ${t[`${tone}-ledge`]}`, color: t['on-pastel'], fontSize: size }, x)),
    ]);
  const out: Node[] = [];
  if (c.companies?.length) out.push(row(c.interviews ? 'Talking to' : 'Applied to', c.companies, 'butter'));
  if (c.skills?.length) out.push(row('Strengths', c.skills, 'lilac'));
  return out;
}

/** Rough text height, so the square card only takes what fits. */
const textHeight = (text: string, size: number, width: number, lineHeight = 1.22) => Math.ceil(text.length / Math.max(1, Math.floor(width / (size * 0.52)))) * size * lineHeight;

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
        el({ flexDirection: 'column' }, [
          el({ flexDirection: 'column', fontFamily: 'Bricolage', fontSize: c.story && c.story.length <= 150 ? 60 : 72, lineHeight: 0.98, letterSpacing: -3 }, [el({}, h1), el({ color: t['ink-accent'] }, h2)]),
          ...(c.story && c.story.length <= 150
            ? [el({ marginTop: 18, fontSize: 24, lineHeight: 1.3, color: t['ink-muted'] }, c.story)]
            : c.role
              ? [el({ marginTop: 22 }, [rolePill(c.role, 22)])]
              : []),
        ]),
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

  if (story) {
    // Tall: Ami's story front and centre, then what else fits; the content sits centred between headline and footer.
    const long = h1.length > 18;
    const hSize = long ? 92 : 104;
    let room = height - pad * 2 - 100 - 64 - (long ? 3 : 2) * hSize * 0.98 - 130;
    const blocks: Node[] = [];
    const fit = (h: number, node: Node) => {
      if (h > room) return false;
      room -= h;
      blocks.push(node);
      return true;
    };
    const tw = Math.floor((inner - gap) / 2);
    // Little else to show: the story and tiles grow to fill the card instead of leaving gaps.
    const roomy = !c.score && !c.goal && !c.highlight && list.length <= 2;
    if (c.role) fit(80, el({}, [rolePill(c.role, roomy ? 34 : 30)]));
    if (c.story) {
      const size = c.story.length > 200 ? 40 : roomy && c.story.length <= 160 ? 58 : 46;
      fit(textHeight(c.story, size, inner - 100) + 170, el({ flexDirection: 'column' }, [storyBubble(c.story, size)]));
    }
    const shown = list.slice(0, 4);
    if (shown.length) {
      const rows = Math.ceil(shown.length / 2);
      const th = roomy ? 320 : c.story ? 210 : 290;
      fit(rows * th + (rows - 1) * gap + 40, el({ flexWrap: 'wrap', gap }, shown.map((x) => tile(x, tw, th, roomy ? 140 : c.story ? 100 : 128))));
    }
    const more = extras(c, 1.1);
    if (more.length) fit(220, el({ gap }, more));
    if (c.highlight) fit(190, el({ flexDirection: 'column' }, [quote(c, 1.05)]));
    for (const r of chips(c, roomy ? 34 : 30)) fit(86, el({}, [r]));
    return el({ width, height, background: t.bg, position: 'relative', flexDirection: 'column', fontFamily: 'DM Sans', color: t.ink, padding: pad }, [
      ...decor,
      brand(100),
      el({ flexDirection: 'column', marginTop: 64, fontFamily: 'Bricolage', fontSize: hSize, lineHeight: 0.98, letterSpacing: -3.5 }, [el({}, h1), el({ color: t['ink-accent'] }, h2)]),
      el({ flexDirection: 'column', flexGrow: 1, justifyContent: 'center', gap: 36, padding: '40px 0' }, blocks),
      el({ flexDirection: 'column' }, [footer(host, 30)]),
    ]);
  }

  // Square: blocks in order of importance, each only if it still fits above the footer.
  let room = height - pad * 2 - 84 - 52 - 2 * 84 * 0.98 - 96; // brand, gap, headline, footer
  const blocks: Node[] = [];
  const fit = (h: number, node: Node) => {
    if (h > room) return false;
    room -= h;
    blocks.push(node);
    return true;
  };
  const perRow = Math.min(4, Math.max(1, list.length));
  const tw = Math.floor((inner - gap * (perRow - 1)) / perRow);
  const few = !c.story && !c.score && !c.goal && !c.highlight;
  const th = few && perRow <= 2 ? 340 : perRow <= 2 ? 250 : 210;
  const big = few && perRow <= 2 ? 156 : perRow <= 2 ? 118 : 88;
  if (c.role) fit(70, el({ marginTop: 22 }, [rolePill(c.role, 26)]));
  if (list.length) fit(th + 40, el({ gap, marginTop: 40 }, list.slice(0, 4).map((x) => tile(x, tw, th, big))));
  if (c.story) {
    const size = c.story.length > 150 ? 30 : 34;
    fit(textHeight(c.story, size, inner - 80) + 110, el({ marginTop: 30, flexDirection: 'column' }, [storyBubble(c.story, size)]));
  }
  const more = extras(c, 1);
  // The highlight shares a row with a lone score or goal card; with two of those it gets its own row (if it fits).
  const paired = more.length < 2 && !!c.highlight;
  const pairRow = paired ? [...more, quote(c, more.length ? 0.85 : 0.9, true)!] : more;
  if (pairRow.length) fit(180, el({ gap, marginTop: 30 }, pairRow));
  if (c.highlight && !paired) fit(150, el({ marginTop: 30, flexDirection: 'column' }, [quote(c, 0.9)]));
  const chipRows = chips(c, 24);
  for (const r of chipRows) fit(64, el({ marginTop: 22 }, [r]));
  return el({ width, height, background: t.bg, position: 'relative', flexDirection: 'column', fontFamily: 'DM Sans', color: t.ink, padding: pad }, [
    ...decor,
    el({ alignItems: 'center' }, [brand(84)]),
    el({ flexDirection: 'column', marginTop: 52, fontFamily: 'Bricolage', fontSize: 84, lineHeight: 0.98, letterSpacing: -3.5 }, [el({}, h1), el({ color: t['ink-accent'] }, h2)]),
    el({ flexDirection: 'column', flexGrow: 1, justifyContent: 'center', paddingBottom: 24 }, blocks),
    el({ flexDirection: 'column' }, [footer(host, 26)]),
  ]);
}

export async function cardPng(c: CardData, format: CardFormat, host: string): Promise<Uint8Array> {
  const { width, height } = CARD_SIZES[format];
  const svg = await satori(layout(c, format, host) as never, { width, height, fonts: loadFonts() });
  return new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
}
