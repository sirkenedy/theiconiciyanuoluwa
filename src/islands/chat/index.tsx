import { render } from 'preact';
import { expand } from '../../lib/twin-privacy';
import { Conversation, Dock, Handoff } from './ChatTwin';
import { ask, askLocal, getState, setAnnouncer, setState, stop, subscribe, twinData } from './store';

export { ask };

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

  subscribe((s) => {
    if (orb) orb.dataset.state = s.orb;
    card.classList.toggle('has-log', s.inlineActive && s.messages.length > 0);
    form.toggleAttribute('data-busy', s.busy);
    if (s.inlineActive && log.scrollHeight > log.clientHeight) log.scrollTop = log.scrollHeight;
  });

  // Visitor typing: the orb leans in and its eyes follow the caret.
  const look = () => {
    if (!orb) return;
    const ratio = input.value.length ? (input.selectionStart ?? input.value.length) / Math.max(24, input.value.length) : 0.5;
    orb.style.setProperty('--look', `${((ratio - 0.5) * 6).toFixed(1)}px`);
  };
  input.addEventListener('input', () => {
    if (!getState().busy) setState({ orb: input.value ? 'typing' : 'idle' });
    look();
  });
  input.addEventListener('keyup', look);
  input.addEventListener('blur', () => {
    if (getState().orb === 'typing') setState({ orb: 'idle' });
    orb?.style.removeProperty('--look');
  });
  card.querySelector('[data-twin-stop]')?.addEventListener('click', stop);


  new IntersectionObserver(([entry]) => setState({ cardVisible: entry.isIntersecting })).observe(card);
}
