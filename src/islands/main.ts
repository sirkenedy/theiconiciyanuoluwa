import { initContact } from './contact';
import { initHeader } from './header';
import { initHero } from './hero';
import { initJourney } from './JourneyScrubber';
import { initPlane } from './plane';
import { initReactions } from './reactions';
import { initTilt } from './tilt';

const root = document.documentElement;

// Idle float loops pause while their section is off-screen or the tab is hidden.
const idle = new IntersectionObserver((entries) => {
  for (const e of entries) e.target.toggleAttribute('data-offscreen', !e.isIntersecting);
});
document.querySelectorAll('[data-idle]').forEach((el) => idle.observe(el));
document.addEventListener('visibilitychange', () => root.toggleAttribute('data-tab-hidden', document.hidden));

if (root.classList.contains('no-sda')) import('../lib/motion-fallback').then((m) => m.start());

// ---------- AI twin: the chat island loads when the browser is idle, or at the first sign of intent ----------
type Chat = typeof import('./chat/index');
let chat: Promise<Chat> | null = null;
const loadChat = () => (chat ??= import('./chat/index').then((m) => (m.start(), m)));
const card = document.querySelector<HTMLElement>('.twin');
const form = card?.querySelector<HTMLFormElement>('[data-twin-form]');
const input = form?.querySelector<HTMLInputElement>('input');
let warmed = false;
for (const type of ['pointerenter', 'focusin', 'touchstart']) card?.addEventListener(type, loadChat, { once: true, passive: true });
// Warm the serverless function on first focus so the first question skips the cold start.
input?.addEventListener('focus', () => {
  if (!warmed) fetch('/api/twin', { method: 'HEAD' }).catch(() => {});
  warmed = true;
});
// Chips work without JS (CSS radios); with JS they start a conversation, even if clicked before the chat has loaded.
card?.querySelectorAll('.twin__chips label').forEach((label, i) => label.addEventListener('click', () => loadChat().then((m) => m.askChip(i))));
form?.addEventListener('submit', (e) => {
  e.preventDefault();
  const question = input?.value ?? '';
  if (!question.trim()) return;
  loadChat().then((m) => {
    if (m.ask(question) && input) input.value = '';
  });
});
if (card) {
  if ('requestIdleCallback' in window) requestIdleCallback(() => loadChat(), { timeout: 4000 });
  else setTimeout(loadChat, 2500);
}

initHeader();
initHero();
initTilt();
initJourney();
initReactions();
initPlane();
initContact();
