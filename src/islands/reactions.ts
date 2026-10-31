import { prefersReducedMotion } from './physics';
import type { Counts, ReactionChange } from '../lib/reactions';

const VISITOR_KEY = 'rx-visitor';
const MINE_KEY = 'rx-mine';
const DEBOUNCE_MS = 500;
const CONFETTI = 8;
const TONES = ['peach', 'lilac', 'mint', 'butter'];

const store = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

/**
 * Reactions: optimistic toggle + clay confetti, one of each type per visitor (random id in localStorage),
 * writes debounced and batched to /api/react. Without Redis the API says so and counts stay local.
 */
export function initReactions() {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-rx]')];
  if (!buttons.length) return;

  let visitor = store.get(VISITOR_KEY);
  if (!visitor) {
    visitor = crypto.randomUUID();
    store.set(VISITOR_KEY, visitor);
  }
  const mine = new Set<string>(JSON.parse(store.get(MINE_KEY) ?? '[]'));
  let server: Counts | null = null;
  const queue = new Map<string, boolean>();
  let timer = 0;
  const confetti = createConfetti();

  const count = (key: string) => (server ? (server[key] ?? 0) : mine.has(key) ? 1 : 0);
  const render = () => {
    for (const b of buttons) {
      const key = b.dataset.rx!;
      const n = String(count(key));
      b.setAttribute('aria-pressed', String(mine.has(key)));
      const out = b.querySelector('[data-count]');
      if (out && out.textContent !== n) out.textContent = n;
      if (b.dataset.label) b.setAttribute('aria-label', `${b.dataset.label}, ${n}`);
    }
  };

  const payload = () => JSON.stringify({ visitor, changes: [...queue].map(([key, on]): ReactionChange => ({ key, on })) });
  const flush = async () => {
    if (!queue.size || !server) return queue.clear();
    const body = payload();
    queue.clear();
    try {
      const res = await fetch('/api/react', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const data = await res.json();
      if (data.counts) Object.assign(server, data.counts);
      render();
    } catch {}
  };
  // A visitor who reacts and leaves within the debounce window still gets counted.
  addEventListener('pagehide', () => {
    if (queue.size && server) navigator.sendBeacon('/api/react', new Blob([payload()], { type: 'application/json' }));
    queue.clear();
  });

  for (const b of buttons) {
    b.addEventListener('click', () => {
      const key = b.dataset.rx!;
      const on = !mine.has(key);
      if (on) mine.add(key);
      else mine.delete(key);
      store.set(MINE_KEY, JSON.stringify([...mine]));
      if (server) server[key] = Math.max(0, (server[key] ?? 0) + (on ? 1 : -1));
      render();
      if (on) burst(b, confetti);
      queue.set(key, on);
      clearTimeout(timer);
      timer = window.setTimeout(flush, DEBOUNCE_MS);
    });
  }
  render();

  const load = () =>
    fetch('/api/react')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.enabled && data.counts) {
          server = data.counts;
          render();
        }
      })
      .catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 3000 });
  else setTimeout(load, 1500);
}

function createConfetti() {
  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  const pieces = Array.from({ length: CONFETTI }, (_, i) => {
    const p = document.createElement('span');
    p.className = `confetti__piece tone-${TONES[i % TONES.length]}${i % 3 === 0 ? ' is-square' : ''}`;
    layer.append(p);
    return p;
  });
  document.body.append(layer);
  return pieces;
}

function burst(button: HTMLElement, pieces: HTMLElement[]) {
  if (prefersReducedMotion()) return;
  button.animate({ scale: ['1', '1.18 0.86', '0.94 1.08', '1'] }, { duration: 450, easing: 'cubic-bezier(.34,1.56,.64,1)' });
  const r = button.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  pieces.forEach((p, i) => {
    const angle = -Math.PI / 2 + (i / (pieces.length - 1) - 0.5) * Math.PI * 1.1;
    const dist = 46 + Math.random() * 34;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const spin = (Math.random() - 0.5) * 540;
    p.getAnimations().forEach((a) => a.cancel());
    p.animate(
      [
        { transform: `translate(${x}px, ${y}px) scale(0.3)`, opacity: 1 },
        { transform: `translate(${x + dx}px, ${y + dy}px) rotate(${spin * 0.6}deg) scale(1)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${x + dx * 1.15}px, ${y + dy + 36}px) rotate(${spin}deg) scale(0.8)`, opacity: 0 },
      ],
      { duration: 720, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  });
}
