import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { expand } from '../../lib/twin-privacy';
import { prefersReducedMotion } from '../physics';
import { ask, askLocal, getState, setState, stop, subscribe, twinData, type Message, type OrbState, type State } from './store';

const SPRING = 'cubic-bezier(.34,1.56,.64,1)';
const values = twinData.values as Record<string, string>;

function useStore(): State {
  const [s, set] = useState(getState());
  useEffect(() => {
    const off = subscribe(set);
    return () => void off();
  }, []);
  return s;
}

// ---------- text: expand placeholders, then a tiny safe markdown subset (**bold**, "- " lists, paragraphs) ----------
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
}
function Rich({ text, final }: { text: string; final: boolean }) {
  const blocks: ComponentChildren[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    list = [];
  };
  for (const line of expand(text, values, final).split('\n')) {
    const item = line.match(/^\s*[-*•]\s+(.*)$/);
    if (item) list.push(item[1]);
    else {
      flushList();
      if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    }
  }
  flushList();
  return <>{blocks}</>;
}

const Glyph = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

export function Orb({ state, size }: { state: OrbState; size: number }) {
  return (
    <span class="twin-orb" data-state={state} style={`--orb:${size}px`} aria-hidden="true">
      <span class="twin-orb__body clay-sphere clay--lilac" />
      <span class="twin-orb__eyes">
        <span />
        <span />
      </span>
    </span>
  );
}

// ---------- page interplay: citations and actions ----------
function showCite(id: string) {
  if (id.startsWith('exp-')) {
    document.dispatchEvent(new CustomEvent('journey:focus', { detail: { id } }));
    return;
  }
  const card = document.getElementById(id);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
  if (!prefersReducedMotion()) {
    setTimeout(() => card.animate({ rotate: ['0deg', '-2.5deg', '2deg', '-1deg', '0deg'] }, { duration: 700, easing: SPRING }), 450);
  }
}
const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
const mailto = (subject: string, body = '') =>
  `mailto:${values.EMAIL}?subject=${encodeURIComponent(subject)}${body ? `&body=${encodeURIComponent(body)}` : ''}`;

function Extras({ m, last }: { m: Message; last: boolean }) {
  const meta = m.meta;
  if (!meta || m.status !== 'done' && m.status !== 'error') return null;
  const followups = m.error ? twinData.faq.map((f) => f.q) : meta.followups;
  return (
    <div class="twin-extras">
      {meta.cite.map((id) =>
        id.startsWith('proj-') ? (
          <span key={id} class="mini-chip mini-chip--cite">From: {expand(twinData.cites[id as keyof typeof twinData.cites] ?? id, values)}</span>
        ) : (
          <button key={id} type="button" class="mini-chip mini-chip--cite" onClick={() => showCite(id)}>
            From: {expand(twinData.cites[id as keyof typeof twinData.cites] ?? id, values)}
          </button>
        ),
      )}
      {meta.action === 'download_resume' && (
        <button type="button" class="mini-chip mini-chip--action" onClick={() => document.querySelector<HTMLAnchorElement>('[data-plane-download]')?.click()}>
          Download résumé
        </button>
      )}
      {meta.action === 'scroll:journey' && <button type="button" class="mini-chip mini-chip--action" onClick={() => scrollTo('journey')}>Show my journey</button>}
      {meta.action === 'scroll:blog' && <button type="button" class="mini-chip mini-chip--action" onClick={() => scrollTo('blog')}>See my writing</button>}
      {(meta.unknown || meta.action === 'email') && (
        <>
          {meta.unknown && <span class="sr-only">Not in my résumé.</span>}
          <a class="mini-chip mini-chip--action" href={mailto('Hello from your portfolio')}>
            {meta.unknown ? 'Not in my résumé — email me' : 'Email me'}
          </a>
        </>
      )}
      {last &&
        followups.map((q) => {
          const faq = twinData.faq.find((f) => f.q === q);
          return (
            <button key={q} type="button" class="mini-chip" onClick={() => (faq ? askLocal(faq.q, faq.a) : ask(q))}>
              {q}
            </button>
          );
        })}
    </div>
  );
}

export function Conversation({ inline: isInline }: { inline?: boolean }) {
  const s = useStore();
  if (isInline && !s.inlineActive) return null;
  const lastAssistant = s.messages.findLast((m) => m.role === 'assistant')?.id;
  return (
    <>
      {s.messages.map((m) =>
        m.role === 'user' ? (
          <div key={m.id} class="bubble bubble--user">
            <span class="sr-only">You: </span>
            {expand(m.text, values)}
          </div>
        ) : (
          <div key={m.id} class="twin-turn">
            <div class={`bubble bubble--twin${m.error ? ' bubble--error' : ''}${m.status !== 'done' ? ' is-new' : ''}`}>
              <span class="sr-only">Harnie: </span>
              {m.status === 'thinking' ? (
                <span class="typing-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              ) : (
                <Rich text={m.text} final={m.status !== 'streaming'} />
              )}
            </div>
            <Extras m={m} last={m.id === lastAssistant} />
          </div>
        ),
      )}
    </>
  );
}

function questionsSummary(messages: Message[]) {
  return messages
    .filter((m) => m.role === 'user')
    .slice(-3)
    .map((m) => `- ${expand(m.text, values)}`)
    .join('\n');
}

export function Handoff({ inline: isInline }: { inline?: boolean }) {
  const s = useStore();
  if ((isInline && !s.inlineActive) || !s.messages.some((m) => m.role === 'user')) return null;
  const body = `Hi ${twinData.firstName},\n\nI chatted with Harnie, your AI twin, and asked:\n${questionsSummary(s.messages)}\n\n`;
  return (
    <a class="handoff" href={mailto('My chat with Harnie, your AI twin', body)}>
      Email {twinData.firstName} this conversation
    </a>
  );
}

function Composer({ inputRef }: { inputRef: { current: HTMLInputElement | null } }) {
  const s = useStore();
  const [value, setValue] = useState('');
  return (
    <form
      class="twin-form"
      data-busy={s.busy || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        if (ask(value)) setValue('');
      }}
    >
      <label class="twin-form__label" for="twin-panel-input">Ask a question</label>
      <div class="twin-form__row">
        <input
          ref={inputRef}
          id="twin-panel-input"
          class="twin-form__input"
          type="text"
          maxLength={500}
          autoComplete="off"
          enterKeyHint="send"
          placeholder="Ask about my work, projects or how I use AI…"
          value={value}
          onInput={(e) => {
            setValue(e.currentTarget.value);
            if (!getState().busy) setState({ orb: e.currentTarget.value ? 'typing' : 'idle' });
          }}
        />
        <button class="btn btn--primary twin-form__send is-send" type="submit" aria-label="Send question">
          <Glyph d="M5 12h14M13 6l6 6-6 6" />
        </button>
        <button class="btn btn--secondary twin-form__send is-stop" type="button" aria-label="Stop answering" onClick={stop}>
          <Glyph d="M7 7h10v10H7z" />
        </button>
      </div>
    </form>
  );
}

/** Floating orb + non-modal panel, shown once there is a conversation and the hero card is out of view. */
export function Dock() {
  const s = useStore();
  const docked = s.messages.length > 0 && (!s.cardVisible || !s.inlineActive);
  const [shown, setShown] = useState(docked);
  const launcher = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);

  // The hero avatar and the launcher are one object: FLIP between their positions.
  const avatarDelta = () => {
    const from = document.querySelector('.twin [data-twin-orb]')?.getBoundingClientRect();
    const to = launcher.current?.getBoundingClientRect();
    if (!from || !to) return null;
    return `translate(${from.left + from.width / 2 - (to.left + to.width / 2)}px, ${from.top + from.height / 2 - (to.top + to.height / 2)}px) scale(${from.width / to.width})`;
  };

  useEffect(() => {
    if (docked) setShown(true);
    else if (shown) {
      setState({ open: false });
      const delta = avatarDelta();
      if (!delta || prefersReducedMotion() || !launcher.current) return setShown(false);
      launcher.current.animate({ transform: ['none', delta], opacity: [1, 0] }, { duration: 450, easing: 'cubic-bezier(.5,0,.75,0)' }).finished.then(() => setShown(false));
    }
  }, [docked]);

  useLayoutEffect(() => {
    if (!shown || !docked || !launcher.current || prefersReducedMotion()) return;
    const delta = avatarDelta();
    if (delta) launcher.current.animate({ transform: [delta, 'none'] }, { duration: 750, easing: SPRING });
  }, [shown]);

  useLayoutEffect(() => {
    if (!s.open) return;
    input.current?.focus();
    if (!prefersReducedMotion()) panel.current?.animate({ transform: ['scale(0.9) translateY(16px)', 'none'], opacity: [0, 1] }, { duration: 380, easing: SPRING });
  }, [s.open]);

  useLayoutEffect(() => {
    const el = body.current;
    if (el && s.open) el.scrollTop = el.scrollHeight;
  }, [s.messages, s.open]);

  const close = () => {
    setState({ open: false });
    launcher.current?.focus();
  };

  // Mobile bottom sheet: drag the handle down to dismiss.
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const onHandleDown = (e: PointerEvent) => {
    drag.current = { y: e.clientY, dy: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: PointerEvent) => {
    if (!drag.current || !panel.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y);
    panel.current.style.translate = `0 ${drag.current.dy}px`;
  };
  const onHandleUp = () => {
    if (!drag.current || !panel.current) return;
    const far = drag.current.dy > 90;
    panel.current.style.translate = '';
    drag.current = null;
    if (far) close();
  };

  if (!shown) return null;
  return (
    <div class="twin-dock">
      {s.open && (
        <div
          ref={panel}
          id="twin-panel"
          class="twin-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="twin-panel-title"
          onKeyDown={(e) => e.key === 'Escape' && close()}
        >
          <span class="twin-panel__handle" aria-hidden="true" onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp} />
          <div class="twin-panel__head">
            <Orb state={s.orb} size={32} />
            <h2 id="twin-panel-title" class="twin-panel__title">Ask Harnie</h2>
            <button type="button" class="twin-panel__close" aria-label="Close chat" onClick={close}>
              <Glyph d="M6 6l12 12M18 6L6 18" />
            </button>
          </div>
          <div ref={body} class="twin-panel__body twin-log" role="log" aria-live="off" aria-label="Conversation with Harnie">
            <Conversation />
          </div>
          <div class="twin-panel__foot">
            <Composer inputRef={input} />
            <p class="twin-form__note">
              <span>Harnie (AI twin) · answers from {twinData.firstName}'s résumé · may be imperfect</span>
              <a href="#ai-twin-note">What gets logged?</a>
            </p>
            <Handoff />
          </div>
        </div>
      )}
      <button
        ref={launcher}
        type="button"
        class="twin-launcher"
        aria-label={s.open ? 'Close chat with Harnie' : 'Open chat with Harnie'}
        aria-expanded={s.open}
        aria-controls="twin-panel"
        onClick={() => (s.open ? close() : setState({ open: true }))}
      >
        <Orb state={s.orb} size={64} />
      </button>
    </div>
  );
}
