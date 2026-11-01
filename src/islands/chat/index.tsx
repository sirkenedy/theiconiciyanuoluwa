import { render } from 'preact';
import { expand } from '../../lib/twin-privacy';
import { Conversation, Dock, Handoff } from './ChatTwin';
import { ask, askLocal, getState, setAnnouncer, setState, stop, subscribe, twinData } from './store';

export { ask };

export const openPanel = () => setState({ open: true });

/** FAQ chips answer instantly from build-time data, with a short typed reveal and no API call. */
export function askChip(index: number) {
  const faq = twinData.faq[index];
  if (faq) askLocal(faq.q, faq.a);
}

/** Mounts the conversation into the hero card, the dock into <body>, and wires the card's static controls. */
export function start() {
  const card = document.querySelector<HTMLElement>('.twin');
  const log = card?.querySelector<HTMLElement>('[data-twin-log]');
  const form = card?.querySelector<HTMLFormElement>('[data-twin-form]');
  const input = form?.querySelector<HTMLInputElement>('input');
  const orb = card?.querySelector<HTMLElement>('[data-twin-orb]');
  const status = card?.querySelector<HTMLElement>('[data-twin-status]');
  if (!card || !log || !form || !input) return;

  // The visible log stays quiet (aria-live="off"); the finished answer is announced once here.
  setAnnouncer((text) => {
    if (status) status.textContent = expand(text, twinData.values as Record<string, string>);
  });

  render(<Conversation inline />, log);
  const handoff = card.querySelector<HTMLElement>('[data-twin-handoff]');
  if (handoff) render(<Handoff inline />, handoff);
  const dock = document.createElement('div');
  document.body.append(dock);
  render(<Dock />, dock);
  // The static phone button (works before this island loads) hands over to the live launcher in the same spot.
  document.querySelector('[data-twin-fab]')?.closest('.twin-dock')?.remove();

  subscribe((s) => {
    if (orb) orb.dataset.state = s.orb;
    card.classList.toggle('has-log', s.inlineActive && s.messages.length > 0);
    form.toggleAttribute('data-busy', s.busy);
    if (s.inlineActive && log.scrollHeight > log.clientHeight) log.scrollTop = log.scrollHeight;
  });

  // Visitor typing: the avatar leans in.
  input.addEventListener('input', () => {
    if (!getState().busy) setState({ orb: input.value ? 'typing' : 'idle' });
  });
  input.addEventListener('blur', () => {
    if (getState().orb === 'typing') setState({ orb: 'idle' });
  });
  card.querySelector('[data-twin-stop]')?.addEventListener('click', stop);


  // The dock appears as soon as the card's header (Harnie's face and name) scrolls out of view.
  new IntersectionObserver(([entry]) => setState({ cardVisible: entry.isIntersecting })).observe(card.querySelector('.twin__head') ?? card);
}
