import { Spring2D, finePointer, prefersReducedMotion } from './physics';

const MAX_PARALLAX = 16;
const TAP_SLOP = 5;

type Body = { el: HTMLElement; layer: HTMLElement; clay: HTMLElement; depth: number; spring: Spring2D };

export function initHero() {
  const hero = document.querySelector<HTMLElement>('.hero');
  const stage = hero?.querySelector<HTMLElement>('.hero-stage');
  if (!hero || !stage) return;

  const bodies: Body[] = [...stage.querySelectorAll<HTMLElement>('.obj')].map((el) => {
    const layer = el.firstElementChild as HTMLElement;
    const clay = el.querySelector<HTMLElement>('.clay')!;
    const spring = new Spring2D((x, y) => (layer.style.translate = `${x.toFixed(2)}px ${y.toFixed(2)}px`));
    return { el, layer, clay, depth: Number(el.dataset.depth ?? 0.6), spring };
  });

  const puffs = createPuffs(stage);
  initParallax(hero, stage, bodies);
  bodies.forEach((b) => initGrab(b, stage, puffs));
  initGlance(bodies);
}

function initParallax(hero: HTMLElement, stage: HTMLElement, bodies: Body[]) {
  let pointer: { x: number; y: number } | null = null;
  let queued = false;
  const frame = () => {
    queued = false;
    if (!pointer) return;
    const r = stage.getBoundingClientRect();
    const nx = Math.max(-1, Math.min(1, (pointer.x - (r.left + r.width / 2)) / (r.width / 2)));
    const ny = Math.max(-1, Math.min(1, (pointer.y - (r.top + r.height / 2)) / (r.height / 2)));
    for (const b of bodies) b.spring.target(nx * MAX_PARALLAX * b.depth, ny * MAX_PARALLAX * b.depth);
  };
  hero.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'mouse' || prefersReducedMotion()) return;
      pointer = { x: e.clientX, y: e.clientY };
      if (!queued) {
        queued = true;
        requestAnimationFrame(frame);
      }
    },
    { passive: true },
  );
  hero.addEventListener('pointerleave', () => {
    pointer = null;
    for (const b of bodies) b.spring.target(0, 0);
  });
  stage.addEventListener('pointerenter', () => stage.classList.add('is-live'));
  stage.addEventListener('pointerleave', () => stage.classList.remove('is-live'));
}

function initGrab(body: Body, stage: HTMLElement, puffs: HTMLElement[]) {
  const { el, spring } = body;
  let start: { x: number; y: number; ox: number; oy: number } | null = null;
  let samples: { x: number; y: number; t: number }[] = [];
  let moved = false;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    moved = false;
    // Touch only squishes; dragging is for mouse and pen.
    if (e.pointerType === 'touch' || prefersReducedMotion()) {
      start = null;
      return;
    }
    el.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY, ox: spring.x, oy: spring.y };
    samples = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
  });

  el.addEventListener(
    'pointermove',
    (e) => {
      if (!start || !el.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < TAP_SLOP) return;
      if (!moved) {
        moved = true;
        el.classList.add('is-grabbed');
      }
      spring.hold(start.ox + dx, start.oy + dy);
      samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
      if (samples.length > 5) samples.shift();
    },
    { passive: true },
  );

  const end = (e: PointerEvent) => {
    const wasDrag = moved;
    if (start && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    start = null;
    el.classList.remove('is-grabbed');
    if (wasDrag) {
      const a = samples[0];
      const b = samples.at(-1)!;
      const dt = Math.max(16, b.t - a.t) / 1000;
      spring.release((b.x - a.x) / dt, (b.y - a.y) / dt);
    } else if (e.type === 'pointerup') {
      squish(body, stage, puffs);
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function squish({ el, clay }: Body, stage: HTMLElement, puffs: HTMLElement[]) {
  if (prefersReducedMotion()) return;
  clay.animate({ scale: ['1 1', '1.25 0.75', '0.9 1.1', '1 1'] }, { duration: 500, easing: 'cubic-bezier(.34,1.56,.64,1)' });
  const s = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const x = r.left - s.left + r.width / 2;
  const y = r.top - s.top + r.height * 0.9;
  puffs.forEach((p, i) => {
    const angle = Math.PI + (Math.PI * (i + 0.5)) / puffs.length;
    const dist = 26 + (i % 2) * 12;
    p.getAnimations().forEach((a) => a.cancel());
    p.animate(
      [
        { transform: `translate(${x}px, ${y}px) scale(0.4)`, opacity: 0.9 },
        { transform: `translate(${x + Math.cos(angle) * dist}px, ${y + Math.sin(angle) * dist * 0.5}px) scale(1.1)`, opacity: 0 },
      ],
      { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  });
}

function createPuffs(stage: HTMLElement) {
  return Array.from({ length: 5 }, () => {
    const p = document.createElement('span');
    p.className = 'puff';
    stage.append(p);
    return p;
  });
}

/** Hovering an About card makes the hero object of the same tone turn towards it. */
function initGlance(bodies: Body[]) {
  const byTone = new Map(bodies.map((b) => [b.el.dataset.tone, b]));
  document.querySelectorAll<HTMLElement>('[data-glance]').forEach((card) => {
    const body = byTone.get(card.dataset.glance);
    if (!body) return;
    card.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse' || prefersReducedMotion() || !finePointer()) return;
      const o = body.clay.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const deg = (Math.atan2(c.top + c.height / 2 - (o.top + o.height / 2), c.left + c.width / 2 - (o.left + o.width / 2)) * 180) / Math.PI - 90;
      body.clay.style.rotate = `${Math.max(-30, Math.min(30, deg))}deg`;
    });
    card.addEventListener('pointerleave', () => (body.clay.style.rotate = ''));
  });
}
