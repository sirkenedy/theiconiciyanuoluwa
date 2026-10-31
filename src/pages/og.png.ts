import { Resvg } from '@resvg/resvg-js';
import type { APIRoute } from 'astro';
import { readFileSync } from 'node:fs';
import satori from 'satori';
import resume from '../content/resume.json';
import { lightTokens as t } from '../lib/tokens';

// Rendered once at build time into /og.png (1200×630): the Soft Clay card used for link previews.
export const prerender = true;

type Node = { type: string; props: { style?: Record<string, unknown>; children?: Node | string | (Node | string)[] } };
const el = (style: Record<string, unknown>, children?: Node['props']['children']): Node => ({ type: 'div', props: { style: { display: 'flex', ...style }, children } });

const sphere = (size: number, hi: string, fill: string, deep: string, style: Record<string, unknown> = {}) =>
  el({
    position: 'absolute',
    width: size,
    height: size,
    borderRadius: '50%',
    backgroundImage: `radial-gradient(circle at 34% 28%, ${hi} 0%, ${fill} 45%, ${deep} 100%)`,
    ...style,
  });

export const GET: APIRoute = async ({ site }) => {
  const { identity } = resume;
  const host = site ? new URL(site).host : '';

  const card = el({ width: 1200, height: 630, background: t.bg, position: 'relative', fontFamily: 'DM Sans', color: t.ink }, [
    // clay stage, right
    el({ position: 'absolute', right: 70, top: 75, width: 480, height: 480, borderRadius: '50%', background: t['surface-sunk'] }),
    el({ position: 'absolute', right: 40, top: 45, width: 540, height: 540, borderRadius: '50%', border: `3px dashed ${t.line}` }),
    sphere(250, t['peach-hi'], t.peach, t['peach-deep'], { right: 190, top: 185 }),
    sphere(96, t['lilac-hi'], t.lilac, t['lilac-deep'], { right: 85, top: 110 }),
    sphere(64, t['mint-hi'], t.mint, t['mint-deep'], { right: 470, top: 120 }),
    el({ position: 'absolute', right: 430, top: 430, width: 110, height: 110, borderRadius: '50%', border: `24px solid ${t.butter}` }),
    el(
      { position: 'absolute', right: 120, top: 455, padding: '14px 26px', borderRadius: 999, background: t['btn-primary-bg'], color: t['btn-primary-fg'], fontFamily: 'Bricolage', fontSize: 30, boxShadow: `0 8px 0 ${t['btn-primary-ledge']}` },
      '+ AI',
    ),
    // copy, left
    el({ position: 'absolute', left: 80, top: 78, flexDirection: 'column', width: 640 }, [
      el(
        { alignSelf: 'flex-start', padding: '10px 22px', borderRadius: 999, background: t.surface, boxShadow: `0 5px 0 ${t.line}`, fontSize: 24 },
        identity.headline,
      ),
      el({ flexDirection: 'column', marginTop: 34, fontFamily: 'Bricolage', fontSize: 92, lineHeight: 0.98, letterSpacing: -3 }, [
        el({}, 'I shape AI'),
        el({ color: t['ink-accent'] }, 'into products'),
        el({}, 'people love.'),
      ]),
    ]),
    el({ position: 'absolute', left: 80, bottom: 64, alignItems: 'center' }, [
      sphere(44, t['peach-hi'], t.peach, t['peach-deep'], { position: 'relative' }),
      el({ flexDirection: 'column', marginLeft: 16 }, [
        el({ fontFamily: 'Bricolage', fontSize: 32, letterSpacing: -0.5 }, identity.name),
        el({ fontSize: 22, color: t['ink-subtle'] }, host),
      ]),
    ]),
  ]);

  const svg = await satori(card as never, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Bricolage', data: readFileSync('src/assets/og/bricolage-800.ttf'), weight: 800, style: 'normal' },
      { name: 'DM Sans', data: readFileSync('src/assets/og/dm-sans-500.ttf'), weight: 500, style: 'normal' },
    ],
  });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
};
