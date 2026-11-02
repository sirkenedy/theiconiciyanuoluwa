// /career entry (never loaded on the portfolio). Plain DOM, no innerHTML, so it runs under Trusted Types.
import { deviceFetch } from '../../lib/device.ts';
import { DAILY_LIMITS, localDay, type Usage, type UsageKind } from '../../lib/career/limits.ts';
import { ParseError, readResume, withoutContacts } from '../../lib/career/parse.ts';
import { readEvents } from '../../lib/career/stream.ts';
import { loadPurifier, renderModelText } from '../../lib/career/render.ts';
import { REMOTE } from '../../lib/career/constants.ts';
import type { Analysis, Answer, ChatTurn, Flag, Guide, Profile, RankedJob, StoredProfile, WriteResult } from '../../lib/career/types.ts';
import { changedKeys, contactLine, fileBase, getLine, profileToResume, setLine, type Doc, type GuideDoc, type LetterDoc, type ResumeDoc } from '../../lib/career/document.ts';
import { clearData, openVault, persistStorage, type Vault } from '../../lib/vault.ts';

/** `docOpen: false` = the visitor closed the preview (the document stays; "Show the résumé" reopens it).
 * `job` = the job this chat is about (found or pasted), so follow-ups like "tailor my résumé for it" just work. */
type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  scrollTop: number | null;
  summary?: string;
  summarizedUpTo?: number;
  docId?: string;
  docOpen?: boolean;
  job?: NonNullable<Task['job']>;
  /** Text typed but not sent in this chat: it comes back when they return to it. */
  draft?: string;
};
/** `then: 'letter'` = "Résumé + cover letter": the letter is written as soon as the résumé is done. */
type Task = { mode: 'tailor' | 'improve'; then?: 'letter'; tone?: string; job?: { jobId?: string; title?: string; company?: string; description?: string } };
/** `kind`: undefined = a real chat turn (sent as context); 'profile' = the "Searching as" strip; 'note' = a local notice;
 * 'jobs' = job cards (with the day's remaining count). */
type Message = {
  id: string;
  conv: string;
  role: 'user' | 'coach';
  text: string;
  at: number;
  kind?: 'profile' | 'note' | 'jobs' | 'match' | 'tailored' | 'letter' | 'guide';
  suggest?: string[];
  jobs?: RankedJob[];
  left?: number;
  more?: number;
  task?: Task;
  analysis?: Analysis;
  answers?: Answer[] | null; // null = skipped
  docId?: string;
  ats?: WriteResult['ats'];
  changes?: WriteResult['changes'];
  critique?: WriteResult['critique'];
  flags?: Flag[];
  /** Job cards brought back (saved or recently shown): no "fresh jobs left" bar, nothing counted. */
  recalled?: boolean;
};
type State = { current: string | null };
type Orb = 'idle' | 'typing' | 'thinking' | 'streaming' | 'done' | 'error' | 'reading' | 'searching';

let usage: Usage | null = null;
/** Ends the usage skeleton (success or failure). */
const loaded = (inside: HTMLElement) => {
  const card = inside.closest('section');
  card?.removeAttribute('data-usage-loading');
  card?.removeAttribute('aria-busy');
};
let shownDoc: string | null = null; // the document in the preview, so its chat card stops pulsing
/** Ami sees the whole chat (tool results as short notes); a rolling summary only covers chats longer than this. */
const CONTEXT_TURNS = 40;
const SUMMARIZE_EVERY = 10;
const NOTES = {

  jobsNeedProfile: 'Upload your résumé first, so I can match jobs to your experience.',
  jobsLimit: `You've seen today's ${DAILY_LIMITS.jobs} fresh jobs. New ones arrive after midnight.`,
  limitGuides: `You've made today's ${DAILY_LIMITS.guides} interview prep guides. New ones after midnight.`,
  searchLimit: "You've used today's live job searches. The jobs I found are saved, and new ones arrive every hour.",
  jobsWarming: "I'm gathering today's jobs from the job boards right now. Ask again in a minute.",
  devices: "Today's free allowance for this network is used up, and deleting your data doesn't reset it. Ami will be back after midnight.",
  upstream: "I couldn't finish reading that job just now. Try again in a moment: it didn't use up any of today's limits.",
  pasteJob: "Paste the job description below and I'll tailor your résumé to it, or write a cover letter.",
  urlOnly: "I can't open links (many job sites block it). Copy the job description text and paste it here instead.",
  jobExpired: "That job's full description has expired from my list. Paste it below and I'll carry on.",
  jobShort: 'That description is too short to tailor against. Paste the full job description.',
  limitTailored: `You've used today's ${DAILY_LIMITS.tailored} tailored résumés. New ones after midnight.`,
  limitLetters: `You've used today's ${DAILY_LIMITS.letters} cover letters. New ones after midnight.`,
  profileReady: "Here's what I picked up from your résumé. Check it's right (edit anything), then ask me how to position yourself, what to sharpen, or how to approach a role.",
  limitMessages: "You've used today's messages. New ones arrive at midnight, and this chat stays saved on your device.",
  limitUploads: "You've used today's résumé uploads. You can upload again after midnight.",
  offline: "I can't answer right now. Your message is saved on this device; try again in a little while.",
  error: 'Something went wrong on my side. Try again in a moment.',
};
const PARSE_NOTES: Record<ParseError['code'], string> = {
  type: 'I can read PDF or DOCX files. Export your résumé as one of those and try again.',
  size: "That file is over 5 MB. Try exporting a lighter PDF (or a DOCX) and upload it again.",
  empty: "I couldn't find any text in that file. Paste your résumé text below instead.",
  scanned: "This looks like a scanned PDF (an image of text), so I can't read it. Paste your résumé text below instead.",
  broken: "I couldn't open that file. If it's password-protected or damaged, paste your résumé text below instead.",
};

const $ = <T extends Element>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const cc = $<HTMLElement>('[data-cc]');
const log = $<HTMLElement>('[data-log]');
const msgsEl = $<HTMLOListElement>('[data-msgs]');
const empty = $<HTMLElement>('[data-empty]');
const welcome = $<HTMLElement>('[data-welcome]');
const chatsEl = $<HTMLUListElement>('[data-chats]');
const chatsEmpty = $<HTMLElement>('[data-chats-empty]');
const form = $<HTMLFormElement>('[data-composer]');
const input = $<HTMLTextAreaElement>('#cc-input');
const status = $<HTMLElement>('[data-status]');
const consent = $<HTMLInputElement>('[data-consent]');
const rail = $<HTMLElement>('[data-rail]');
const railBody = $<HTMLElement>('.cc-rail__body');
const drop = $<HTMLElement>('.cc-drop__zone');
const breatherBox = $<HTMLElement>('[data-breather]');
const nudgeBox = $<HTMLElement>('[data-nudge]');
const nudgeBody = $<HTMLElement>('[data-nudge-body]');
const weekStrip = $<HTMLElement>('[data-week-strip]');

/** Today's global AI budget is spent: a friendly resting state until midnight UTC; nothing on the device is lost. */
/** Dismissed notices stay hidden for the rest of that day (this browser only); the composer stays paused. */
const BREATHER_KEY = 'cc-breather-dismissed';
const dismissedToday = () => {
  try {
    return localStorage.getItem(BREATHER_KEY) === localDay();
  } catch {
    return false;
  }
};
function setBreather(on: boolean) {
  breatherBox.hidden = !on || dismissedToday();
  cc.toggleAttribute('data-resting', on);
  input.disabled = on;
  input.placeholder = on ? 'Back tomorrow…' : phone.matches ? 'Message Ami' : 'Ask anything about your job search…';
  if (on) announce('Ami is taking a breather until tomorrow.');
}
$<HTMLButtonElement>('[data-breather-close]').addEventListener('click', () => {
  try {
    localStorage.setItem(BREATHER_KEY, localDay());
  } catch {}
  breatherBox.hidden = true;
  input.focus();
});
$<HTMLButtonElement>('[data-nudge-close]').addEventListener('click', () => {
  try {
    localStorage.setItem(NUDGE_KEY, localDay());
  } catch {}
  nudgeBox.hidden = true;
  input.focus();
});

// ---------- this week: progress from what's on this device (no server, no AI) ----------
// The week starts on Monday (local time). Shown on the new-chat screen (where people look every visit) and in the rail;
// every number is a shortcut to those jobs, and a weekly applications goal gives the numbers a meaning.
type Goal = { perWeek: number };
let goal: Goal | null = null;
let goalEditing = false;
const GOALS = [3, 5, 10];
let weekTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleWeek = () => {
  clearTimeout(weekTimer);
  weekTimer = setTimeout(renderWeek, 300);
};
function weekStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
type Stat = { key: string; n: number; label: string; go: () => unknown; hint: string };
async function weekStats(): Promise<Stat[]> {
  const since = weekStart();
  const [all, savedJobs] = await Promise.all([vault.list<Message>('messages'), vault.list<RankedJob & { savedAt?: number }>('savedJobs')]);
  const recent = all.filter((m) => m.at >= since);
  const found = new Set(recent.filter((m) => m.kind === 'jobs' && !m.recalled).flatMap((m) => (m.jobs ?? []).map((j) => j.id))).size;
  const tracks = Object.values(tracker);
  const interviews = tracks.filter((t) => (t.status === 'interview' || t.status === 'offer') && t.at >= since).length;
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  return [
    { key: 'found', n: found, label: 'found', go: () => (found ? showJobs('recent', "Show the jobs I've found this week") : findJobs()), hint: found ? 'Show them' : 'Find jobs' },
    { key: 'saved', n: savedJobs.filter((j) => (j.savedAt ?? 0) >= since).length, label: 'saved', go: () => showJobs('saved', 'Show my saved jobs'), hint: 'Show saved jobs' },
    { key: 'applied', n: tracks.filter((t) => t.applied >= since).length, label: 'applied', go: () => showJobs('applied', 'Show my applications'), hint: 'Show applications' },
    { key: 'interview', n: interviews, label: plural(interviews, 'interview', 'interviews'), go: () => showJobs('interviews', 'Show my interviews'), hint: 'Show interviews' },
  ];
}

function statNode(st: Stat) {
  const li = el('li', 'cc-week__stat');
  li.dataset.stat = st.key;
  const b = button('', 'cc-week__go', () => {
    if (busy) return;
    if (phone.matches) setSheet(false);
    st.go();
  });
  // The visible words lead the accessible name ("2 applied"), then what a tap does.
  b.replaceChildren(el('strong', 'cc-week__num', String(st.n)), document.createTextNode(' '), el('span', 'cc-week__label', st.label), el('span', 'sr-only', ` this week: ${st.hint.toLowerCase()}`));
  li.append(b);
  return li;
}

/** The goal: a picker until one is set, then a clay ring that fills with each application. */
function goalNode(applied: number) {
  const box = el('div', 'cc-goal');
  if (!goal || goalEditing) {
    box.classList.add('is-picking');
    const ask = el('span', 'cc-goal__ask', 'Weekly goal: how many jobs will you apply to?');
    ask.id = 'cc-goal-ask';
    const pick = el('div', 'cc-goal__pick');
    pick.setAttribute('role', 'group');
    pick.setAttribute('aria-labelledby', 'cc-goal-ask');
    for (const n of GOALS) {
      const b = button(`${n} jobs`, 'cc-goal__opt', () => setGoal(n));
      b.setAttribute('aria-pressed', String(goal?.perWeek === n));
      pick.append(b);
    }
    box.append(ask, pick);
    return box;
  }
  const done = Math.min(applied, goal.perWeek);
  const ring = el('span', 'cc-goal__ring');
  ring.style.setProperty('--p', String(done / goal.perWeek)); // CSSOM: allowed by the CSP
  ring.setAttribute('aria-hidden', 'true');
  const left = goal.perWeek - applied;
  const text = el('span', 'cc-goal__text');
  text.append(
    el('strong', undefined, left <= 0 ? 'Weekly goal reached' : `${applied} of ${goal.perWeek} applications`),
    el('span', undefined, left <= 0 ? 'Nice work. Anything more is a bonus.' : `${left} to go this week`),
  );
  if (left <= 0) box.classList.add('is-done');
  box.append(ring, text);
  return box;
}

async function setGoal(n: number) {
  goal = { perWeek: n };
  goalEditing = false;
  await vault.put('meta', 'goal', goal);
  await renderWeek();
  announce(`Weekly goal set: ${n} applications.`);
}

async function renderWeek() {
  weekStrip.hidden = !stored;
  if (!stored) return;
  const stats = await weekStats();
  const applied = stats.find((x) => x.key === 'applied')!.n;
  $<HTMLElement>('[data-week-list]', weekStrip).replaceChildren(...stats.map(statNode));
  $<HTMLElement>('[data-goal]', weekStrip).replaceChildren(goalNode(applied));
  const change = $<HTMLElement>('[data-goal-change]', weekStrip);
  change.replaceChildren();
  if (goal) change.append(button(goalEditing ? 'Cancel' : 'Change goal', 'cc-link cc-goal__change', () => ((goalEditing = !goalEditing), renderWeek())));
}

/** A short confirmation that floats over the chat (the "welcome back" spot), then steps away. */
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(strong: string, rest: string) {
  const text = welcome.lastElementChild!;
  text.replaceChildren(el('strong', undefined, strong), document.createTextNode(` ${rest}`));
  welcome.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (welcome.hidden = true), 3500);
}

async function isBreather(res: Response | null) {
  if (res?.status !== 503) return false;
  const { error } = (await res.clone().json().catch(() => ({}))) as { error?: string };
  if (error === 'breather') setBreather(true);
  return error === 'breather';
}

let vault: Vault;
let state: State = { current: null };
let conversations: Conversation[] = [];
let messages: Message[] = [];
let stored: StoredProfile | null = null;
let busy = false;
/** While Ami works, the send arrow becomes a spinner and sending waits (the text stays in the box). */
function setBusy(on: boolean) {
  busy = on;
  cc.toggleAttribute('data-busy', on);
  const send = document.querySelector<HTMLButtonElement>('.cc-send');
  send?.setAttribute('aria-label', on ? 'Ami is replying: send when she is done' : 'Send');
  send?.setAttribute('aria-disabled', String(on));
}
let saved = new Set<string>();
/** Application tracker, on this device only: jobId → where the application is, and when to nudge a follow-up. */
type Status = 'applied' | 'interview' | 'offer' | 'rejected';
type Track = { status: Status; at: number; applied: number; remind: number | null };
let tracker: Record<string, Track> = {};
const STATUS_LABELS: Record<Status, string> = { applied: 'Applied', interview: 'Interviewing', offer: 'Offer', rejected: 'Not selected' };
const FOLLOW_UP_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

const uid = () => crypto.randomUUID();
const current = () => conversations.find((c) => c.id === state.current) ?? null;
const announce = (text: string) => (status.textContent = text);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, cls: string, onClick: () => void) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function orb() {
  const o = el('span', 'coach-orb coach-orb--sm');
  o.setAttribute('aria-hidden', 'true');
  const eyes = el('span', 'coach-orb__eyes');
  eyes.append(el('span'), el('span'));
  o.append(eyes);
  return o;
}

let settle = 0;
function setOrb(s: Orb) {
  clearTimeout(settle);
  cc.dataset.orb = s;
  if (s === 'done') settle = window.setTimeout(() => setOrb('idle'), 1200);
}

function when(t: number) {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(new Date(t))) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return new Date(t).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Model text → sanitised DOM (src/lib/career/render.ts: escaped markdown subset + DOMPurify allow-list). */
const rich = renderModelText;

// ---------- profile ----------
function profileFacts(p: Profile) {
  const latest = p.experience[0]?.role ?? p.identity.headline ?? null;
  const target = p.targetRoles[0] ?? null;
  const role = latest && target && latest.toLowerCase() !== target.toLowerCase() ? `${latest} → ${target}` : target ?? latest;
  const where = [p.location ?? p.identity.location, p.remotePreference && p.remotePreference !== 'onsite' ? `or ${p.remotePreference}` : null].filter(Boolean).join(' ');
  return [role, p.yearsExperience != null ? `${p.yearsExperience} yrs` : null, where || null].filter((v): v is string => !!v);
}

function profileStrip(): HTMLElement {
  const box = el('div', 'cc-profile');
  if (!stored) {
    box.append(el('p', 'cc-profile__gone', 'This résumé was removed from this device.'));
    return box;
  }
  const row = el('div', 'cc-profile__row');
  row.append(el('span', 'label cc-profile__label', 'Searching as'), el('strong', 'cc-profile__name', stored.profile.identity.name ?? 'You'));
  for (const fact of profileFacts(stored.profile)) row.append(el('span', 'cc-chip', fact));
  // Unconfirmed, the "Does this look right?" row carries the Edit button; confirmed, it moves to the strip's corner.
  if (stored.confirmed) row.append(button('Edit', 'cc-link cc-profile__edit', () => editProfile(box)));
  box.append(row);
  if (!stored.confirmed) {
    const ask = el('div', 'cc-profile__confirm');
    ask.append(
      el('span', undefined, 'Does this look right?'),
      button('Looks right', 'btn btn--primary cc-btn-sm', () => saveProfile({ ...stored!, confirmed: true })),
      button('Edit', 'btn btn--secondary cc-btn-sm', () => editProfile(box)),
    );
    box.append(ask);
  }
  return box;
}

function field(label: string, control: HTMLInputElement | HTMLSelectElement) {
  const wrap = el('label', 'cc-field');
  wrap.append(el('span', 'cc-field__label', label), control);
  return wrap;
}

function editProfile(box: HTMLElement) {
  if (!stored) return;
  const p = stored.profile;
  const f = el('form', 'cc-edit');
  const text = (name: string, value: string | null, max = 120) => {
    const i = el('input', 'cc-field__input');
    Object.assign(i, { name, value: value ?? '', maxLength: max, autocomplete: 'off' });
    return i;
  };
  const name = text('name', p.identity.name);
  const roles = text('roles', p.targetRoles.join(', '), 300);
  const years = text('years', p.yearsExperience?.toString() ?? '', 2);
  years.inputMode = 'numeric';
  const where = text('location', p.location ?? p.identity.location);
  const remote = el('select', 'cc-field__input');
  remote.name = 'remote';
  for (const v of ['', ...REMOTE]) {
    const o = el('option', undefined, v ? { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', flexible: 'Open to any' }[v] : 'Not set');
    o.value = v;
    o.selected = (p.remotePreference ?? '') === v;
    remote.append(o);
  }
  const actions = el('div', 'cc-edit__actions');
  const save = el('button', 'btn btn--primary cc-btn-sm', 'Save profile');
  save.type = 'submit';
  actions.append(save, button('Cancel', 'btn btn--secondary cc-btn-sm', () => box.replaceWith(profileStrip())));
  f.append(
    el('p', 'label cc-profile__label', 'Your profile'),
    field('Name', name),
    field('Target roles (comma-separated)', roles),
    field('Years of experience', years),
    field('Location', where),
    field('Work style', remote),
    actions,
  );
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const n = Number(years.value);
    const next: Profile = {
      ...p,
      identity: { ...p.identity, name: name.value.trim() || null },
      targetRoles: roles.value.split(',').map((r) => r.trim()).filter(Boolean).slice(0, 8),
      yearsExperience: years.value.trim() && Number.isFinite(n) && n >= 0 && n <= 60 ? n : null,
      location: where.value.trim() || null,
      remotePreference: (remote.value || null) as Profile['remotePreference'],
    };
    saveProfile({ ...stored!, profile: next, confirmed: true });
  });
  box.replaceChildren(f);
  name.focus();
}

async function saveProfile(next: StoredProfile) {
  stored = { ...next, updatedAt: Date.now() };
  await vault.put('profile', 'current', stored);
  for (const strip of msgsEl.querySelectorAll('.cc-profile')) strip.replaceWith(profileStrip());
  renderResumeCard();
  announce(stored.confirmed ? 'Profile saved.' : 'Profile ready to check.');
}

function renderResumeCard() {
  const text = $<HTMLElement>('.cc-resume__text');
  const btns = $<HTMLElement>('[data-resume-actions]');
  cc.toggleAttribute('data-has-resume', !!stored);
  if ((vault as Vault | undefined) !== undefined) scheduleWeek();
  if (!stored) {
    text.replaceChildren(el('strong', undefined, 'No résumé yet'), el('span', undefined, "Upload one and I'll build your profile."));
    btns.replaceChildren(button('Upload résumé', 'btn btn--secondary cc-card__btn', pickFile));
    return;
  }
  const state = el('span', stored.confirmed ? 'cc-resume__ok' : 'cc-resume__check', stored.confirmed ? 'Profile confirmed' : 'Check your profile');
  text.replaceChildren(el('strong', 'cc-resume__file', stored.fileName), state);
  btns.replaceChildren(
    button('Replace', 'btn btn--secondary cc-card__btn', pickFile),
    button('Edit profile', 'btn btn--secondary cc-card__btn', openProfileEditor),
  );
}

async function openProfileEditor() {
  if (phone.matches) setSheet(false);
  let strip = [...msgsEl.querySelectorAll<HTMLElement>('.cc-profile')].at(-1);
  if (!strip) {
    await add({ role: 'coach', text: '', kind: 'profile' });
    strip = [...msgsEl.querySelectorAll<HTMLElement>('.cc-profile')].at(-1)!;
  }
  editProfile(strip);
  strip.scrollIntoView({ block: 'nearest' });
}

// ---------- jobs ----------
const TONES = ['peach', 'mint', 'butter', 'lilac'];
const ICONS = { sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', calendar: 'M5 6h14v14H5zM5 10h14M9 3v4M15 3v4', wand: 'M5 19L15 9M14 5v2M19 10h-2M17.5 6.5l-1.4 1.4M11 4.5l.5 1M19.5 13l-1 .5', pen: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4', bookmark: 'M7 4h10v16l-5-4-5 4z' };

function icon(d: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

function withIcon<T extends HTMLElement>(b: T, d: string) {
  b.prepend(icon(d));
  return b;
}

function ago(at: number) {
  const min = Math.max(1, Math.round((Date.now() - at) / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function link(text: string, href: string, cls: string) {
  const a = el('a', cls, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function panel(title: string, items: string[], tone: 'why' | 'gaps') {
  const box = el('div', `cc-job__panel cc-job__panel--${tone}`);
  const list = el('ul');
  for (const item of items) list.append(el('li', undefined, item));
  box.append(el('span', 'cc-job__panel-title', title), list);
  return box;
}

function jobCard(job: RankedJob, i: number) {
  const card = el('article', 'cc-job');
  card.dataset.job = job.id;
  const head = el('div', 'cc-job__head');
  const tile = el('span', `cc-job__tile tile--${TONES[i % TONES.length]}`, (job.company.trim()[0] ?? '?').toUpperCase());
  tile.setAttribute('aria-hidden', 'true');
  const who = el('div', 'cc-job__who');
  const meta = el('div', 'cc-job__meta');
  // Remote jobs say who can apply ("Remote · Worldwide", "Remote · Africa"); office jobs say where.
  meta.append(el('span', undefined, (job.remote ? [job.company] : [job.company, job.location]).filter(Boolean).join(' · ')));
  if (job.remote) meta.append(el('span', 'cc-job__remote', `Remote · ${!job.location.trim() || /\b(worldwide|anywhere|global|all countries)\b/i.test(job.location) ? 'Worldwide' : job.location}`));
  if (job.salary) meta.append(el('span', 'cc-job__salary', job.salary));
  if (job.eligibility) meta.append(el('span', `cc-job__elig is-${job.eligibility.kind}`, job.eligibility.label));
  who.append(el('h2', 'cc-job__title', job.title), meta, link(job.attribution.label, job.sourceUrl, 'cc-job__via'));
  const side = el('div', 'cc-job__side');
  const fresh = Date.now() - job.time.at <= 3600_000;
  const when = el('span', `cc-job__when${fresh ? ' is-fresh' : ''}`);
  when.append(el('span', 'cc-job__dot'), document.createTextNode(`${job.time.kind} ${ago(job.time.at)}`));
  const fit = el('div', 'cc-job__fit');
  const meter = el('span', 'cc-job__meter');
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-label', 'Fit');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-valuenow', String(job.fit));
  const bar = el('span', 'cc-job__meter-fill');
  bar.style.transform = `scaleX(${(job.fit / 100).toFixed(2)})`; // CSSOM, not a style attribute: allowed by the CSP
  meter.append(bar);
  fit.append(el('span', 'cc-job__fit-label', 'Fit'), meter, el('span', 'cc-job__fit-num', String(job.fit)));
  side.append(when, fit);
  head.append(tile, who, side);

  const panels = el('div', 'cc-job__panels');
  panels.append(panel('Why it fits', job.why, 'why'));
  if (job.gaps.length) panels.append(panel('Gaps to address', job.gaps, 'gaps'));

  const actions = el('div', 'cc-job__actions');
  const jobRef = { jobId: job.id, title: job.title, company: job.company };
  const open = link('Open job', job.applyUrl, 'btn cc-job__btn');
  open.append(el('span', 'sr-only', ` (${job.attribution.label}, opens in a new tab)`));
  open.addEventListener('click', () => markOpened(job.id));
  const save = button(saved.has(job.id) ? 'Saved' : 'Save', 'btn cc-job__btn cc-job__save', () => toggleSave(job));
  save.setAttribute('aria-pressed', String(saved.has(job.id)));
  actions.append(
    withIcon(button('Tailor my résumé', 'btn btn--primary cc-job__btn', () => startTailor({ mode: 'tailor', job: jobRef }, `Tailor my résumé to the ${job.title} role at ${job.company}.`)), ICONS.wand),
    withIcon(button('Cover letter', 'btn cc-job__btn', () => startLetter(jobRef, `Write a cover letter for the ${job.title} role at ${job.company}.`)), ICONS.pen),
    open,
    withIcon(save, ICONS.bookmark),
  );
  card.append(head, panels, actions, trackRow(job));
  return card;
}

async function toggleSave(job: RankedJob, on = !saved.has(job.id)) {
  if (on) {
    saved.add(job.id);
    await vault.put('savedJobs', job.id, { ...job, savedAt: Date.now() });
  } else {
    saved.delete(job.id);
    await vault.removeRecord('savedJobs', job.id);
    // An unsaved job leaves the tracker too: nothing is kept about it.
    if (tracker[job.id]) {
      delete tracker[job.id];
      await vault.put('meta', 'tracker', tracker);
      refreshTrack(job);
      renderNudge();
    }
  }
  scheduleWeek();
  for (const b of msgsEl.querySelectorAll<HTMLButtonElement>(`[data-job="${CSS.escape(job.id)}"] .cc-job__save`)) {
    b.replaceChildren(icon(ICONS.bookmark), document.createTextNode(on ? 'Saved' : 'Save'));
    b.setAttribute('aria-pressed', String(on));
  }
  announce(on ? `Saved ${job.title}.` : `Removed ${job.title} from saved jobs.`);
}

// ---------- application tracker ----------
function trackRow(job: RankedJob) {
  const row = el('div', 'cc-job__track');
  row.dataset.track = job.id;
  const t = tracker[job.id];
  const label = el('label', 'cc-job__status');
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', `Application status: ${job.title} at ${job.company}`);
  for (const [value, text] of [['', 'Not applied yet'], ...Object.entries(STATUS_LABELS)] as [string, string][]) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    o.selected = (t?.status ?? '') === value;
    sel.append(o);
  }
  sel.addEventListener('change', () => setStatus(job, sel.value as Status | ''));
  label.append(sel);
  if (t) label.dataset.status = t.status;
  row.append(label);
  if (t) {
    const since = el('span', 'cc-job__since', `Applied ${dayName(t.applied)}`);
    if (t.status === 'applied' && t.remind) since.append(document.createTextNode(t.remind <= Date.now() ? ' · follow-up due' : ` · follow up ${dayName(t.remind)}`));
    row.append(since);
    if (t.status === 'interview' || t.status === 'offer') {
      row.append(withIcon(button('Interview prep', 'btn btn--primary cc-job__btn cc-job__prep', async () => {
        if (busy) return;
        await add({ role: 'user', text: `Prep me for my ${job.title} interview at ${job.company}.` });
        startGuide({ jobId: job.id, title: job.title, company: job.company }, '');
      }), ICONS.sparkle));
    }
    if (t.status === 'applied' && t.remind) row.append(withIcon(button('Add reminder to my calendar', 'cc-link cc-job__cal', () => reminderFile(job, t)), ICONS.calendar));
  }
  return row;
}

function dayName(at: number) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(at)) / DAY_MS);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days === -1) return 'tomorrow';
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
const startOfDay = (at: number) => new Date(at).setHours(0, 0, 0, 0);

function refreshTrack(job: RankedJob) {
  for (const row of msgsEl.querySelectorAll<HTMLElement>(`[data-track="${CSS.escape(job.id)}"]`)) {
    const focused = row.contains(document.activeElement);
    const next = trackRow(job);
    row.replaceWith(next);
    if (focused) next.querySelector('select')?.focus();
  }
}

async function setStatus(job: RankedJob, status: Status | '') {
  const prev = tracker[job.id];
  const now = Date.now();
  if (!status) delete tracker[job.id];
  else {
    // Interviewing or an offer means they applied: the application date stays the first one given.
    const remind = status === 'applied' ? (prev?.status === 'applied' ? prev.remind : now + FOLLOW_UP_MS) : null;
    tracker[job.id] = { status, at: now, applied: prev?.applied ?? now, remind };
    if (!saved.has(job.id)) await toggleSave(job, true);
  }
  await vault.put('meta', 'tracker', tracker);
  refreshTrack(job);
  renderNudge();
  await renderWeek();
  if (status === 'applied' && prev?.status !== 'applied') {
    const n = Object.values(tracker).filter((x) => x.applied >= weekStart()).length;
    if (goal) toast(n >= goal.perWeek ? 'Weekly goal reached.' : `${n} of ${goal.perWeek} this week.`, n >= goal.perWeek ? 'Great work. I\'ll remind you to follow up in 7 days.' : 'Applied. I\'ll remind you to follow up in 7 days.');
    else toast('Applied.', "I'll remind you to follow up in 7 days. Set a weekly goal on the new-chat screen.");
  }
  announce(status ? `${job.title}: ${STATUS_LABELS[status]}.${status === 'applied' ? " I'll remind you to follow up in 7 days." : ''}` : `${job.title}: not applied yet.`);
}

/** A follow-up reminder for their own calendar (Google, Apple, Outlook): nothing leaves the device. */
async function reminderFile(job: RankedJob, t: Track) {
  const esc = (v: string) => v.replace(/[\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
  const ymd = (at: number) => {
    const d = new Date(at);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const page = `${location.origin}/career`;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ami career coach//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid()}@ami`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${ymd(t.remind ?? Date.now())}`,
    `DTEND;VALUE=DATE:${ymd((t.remind ?? Date.now()) + DAY_MS)}`,
    `SUMMARY:${esc(`Follow up: ${job.title} at ${job.company}`)}`,
    `DESCRIPTION:${esc(`You applied on ${new Date(t.applied).toLocaleDateString()}. No reply yet? Ami can write a short follow-up note: ${page}`)}`,
    `URL:${page}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT9H', `DESCRIPTION:${esc(`Follow up on ${job.company}`)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const { download } = await import('../../lib/career/export.ts');
  download(new Blob([ics], { type: 'text/calendar' }), `follow-up-${job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'job'}.ics`);
  announce('Calendar reminder downloaded. Open it to add it to your calendar.');
}

// ---------- follow-up nudge ----------
const NUDGE_KEY = 'cc-nudge-dismissed';
async function renderNudge() {
  const due = Object.entries(tracker)
    .filter(([, t]) => t.status === 'applied' && t.remind !== null && t.remind <= Date.now())
    .sort((a, b) => a[1].applied - b[1].applied);
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(NUDGE_KEY) === localDay();
  } catch {}
  const jobs = due.length && !dismissed ? new Map((await vault.list<RankedJob>('savedJobs')).map((j) => [j.id, j])) : new Map<string, RankedJob>();
  const first = due.find(([id]) => jobs.has(id));
  nudgeBox.hidden = !first;
  if (!first) return;
  const [id, t] = first;
  const job = jobs.get(id)!;
  const days = Math.max(1, Math.round((Date.now() - t.applied) / DAY_MS));
  const others = due.filter(([k]) => jobs.has(k)).length - 1;
  const text = el('span', 'cc-nudge__text');
  text.append(el('strong', undefined, `Time to follow up?`), document.createTextNode(` You applied to ${job.title} at ${job.company} ${days} ${days === 1 ? 'day' : 'days'} ago.${others > 0 ? ` (${others} more waiting.)` : ''}`));
  const later = async (ms: number | null) => {
    tracker[id] = { ...t, remind: ms === null ? null : Date.now() + ms };
    await vault.put('meta', 'tracker', tracker);
    refreshTrack(job);
    renderNudge();
  };
  const btns = el('span', 'cc-nudge__btns');
  btns.append(
    button('Write a follow-up', 'btn btn--primary cc-nudge__btn', async () => {
      if (busy) return;
      await later(FOLLOW_UP_MS);
      send(`Write a short follow-up email for my application to the ${job.title} role at ${job.company}. I applied ${days} ${days === 1 ? 'day' : 'days'} ago and haven't heard back.`);
    }),
    button('Remind me in 3 days', 'btn cc-nudge__btn', () => later(3 * DAY_MS)),
    button('I heard back', 'btn cc-nudge__btn', () => setStatus(job, 'interview')),
  );
  nudgeBody.replaceChildren(text, btns);
}

function jobsBlock(m: Message) {
  const wrap = el('div', 'cc-jobs');
  if (m.text) wrap.append(el('p', 'cc-jobs__intro', m.text));
  if (m.recalled) {
    (m.jobs ?? []).forEach((job, i) => wrap.append(jobCard(job, i)));
    return wrap;
  }
  wrap.append(profileStrip());
  (m.jobs ?? []).forEach((job, i) => wrap.append(jobCard(job, i)));
  const bar = el('div', 'cc-jobs__left');
  const left = m.left ?? 0;
  const line = el('p');
  line.append(el('strong', undefined, `${left} of ${DAILY_LIMITS.jobs} fresh jobs left today.`), document.createTextNode(' New ones after midnight.'));
  bar.append(line);
  const latest = messages.filter((x) => x.kind === 'jobs').at(-1)?.id === m.id;
  if (latest && left > 0 && (m.more ?? 0) > 0) bar.append(button(`Show ${Math.min(m.more!, left)} more`, 'btn cc-jobs__more', () => findJobs(true)));
  wrap.append(bar);
  return wrap;
}

/** Cards for jobs they already have: saved (any time) or shown in the last 7 days. Free: no search, no quota. */
async function showJobs(which: 'saved' | 'recent' | 'applied' | 'interviews', userText: string | null) {
  if (userText !== null) await add({ role: 'user', text: userText });
  let jobs: RankedJob[];
  if (which === 'saved') jobs = await vault.list<RankedJob>('savedJobs');
  else if (which === 'interviews') jobs = (await vault.list<RankedJob>('savedJobs')).filter((j) => tracker[j.id]?.status === 'interview' || tracker[j.id]?.status === 'offer').sort((a, b) => tracker[b.id].at - tracker[a.id].at);
  else if (which === 'applied') jobs = (await vault.list<RankedJob>('savedJobs')).filter((j) => tracker[j.id]).sort((a, b) => tracker[b.id].applied - tracker[a.id].applied);
  else {
    const since = Date.now() - 7 * 86_400_000;
    const seen = new Set<string>();
    jobs = (await vault.list<Message>('messages'))
      .filter((m) => m.kind === 'jobs' && !m.recalled && m.at >= since)
      .sort((a, b) => b.at - a.at)
      .flatMap((m) => m.jobs ?? [])
      .filter((j) => !seen.has(j.id) && (seen.add(j.id), true))
      .slice(0, 20);
  }
  if (!jobs.length) {
    return note(
      which === 'saved' ? "You haven't saved any jobs yet. Tap Save on a job card to keep it here."
      : which === 'interviews' ? 'No interviews tracked yet. When you hear back, set the job\'s status to Interviewing and I\'ll help you prepare.'
      : which === 'applied' ? 'No applications tracked yet. On any job card, set the status to Applied and I\'ll keep track (and remind you to follow up).'
      : "I haven't shown you any jobs in the last 7 days. Ask me to find some.",
    );
  }
  const n = jobs.length;
  const intro = which === 'saved' ? `Your ${n} saved ${n === 1 ? 'job' : 'jobs'}:` : which === 'applied' ? `Your ${n} ${n === 1 ? 'application' : 'applications'}, newest first:` : which === 'interviews' ? `Your ${n} ${n === 1 ? 'interview' : 'interviews'}. Tap Interview prep on a card for a guide.` : `Jobs I've shown you in the last 7 days (${n}):`;
  await add({ role: 'coach', text: intro, kind: 'jobs', jobs, recalled: true });
  announce(intro);
}

/** The cards on screen, compact, so the chat can answer "why is X the top match?". */
/** "Open job" clicks, on this device only (encrypted like everything else): jobId → when it was first opened. */
async function markOpened(id: string) {
  const opened = (await vault.get<Record<string, number>>('meta', 'opened')) ?? {};
  if (opened[id]) return;
  opened[id] = Date.now();
  // Only the last 7 days matter for Ami; older entries are dropped as new ones arrive.
  for (const [k, at] of Object.entries(opened)) if (Date.now() - at > 7 * 86_400_000) delete opened[k];
  await vault.put('meta', 'opened', opened);
  scheduleWeek();
}

/** Every job the visitor saved (any time), for "my saved jobs" and the like. */
async function savedJobsContext() {
  const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  return (await vault.list<RankedJob>('savedJobs')).slice(0, 25).map((j) => ({
    title: j.title.slice(0, 200),
    company: j.company.slice(0, 200),
    location: j.location.slice(0, 200),
    fit: j.fit,
    saved: true,
    source: j.attribution.label.replace(/^via /, '').slice(0, 40),
    status: tracker[j.id]?.status ?? null,
    applied: tracker[j.id] ? stamp(tracker[j.id].applied) : null,
  }));
}

/** Every job shown in the last 7 days, in any chat, newest first, and whether "Open job" was clicked: for Ami's answers. */
async function recentJobs() {
  const since = Date.now() - 7 * 86_400_000;
  const [all, opened] = await Promise.all([vault.list<Message>('messages'), vault.get<Record<string, number>>('meta', 'opened')]);
  const seen = new Set<string>();
  return all
    .filter((m) => m.kind === 'jobs' && !m.recalled && m.at >= since)
    .sort((a, b) => b.at - a.at)
    .flatMap((m) => (m.jobs ?? []).map((j) => ({ j, at: m.at })))
    .filter(({ j }) => !seen.has(j.id) && (seen.add(j.id), true))
    .slice(0, 25)
    .map(({ j, at }) => ({
      title: j.title.slice(0, 200),
      company: j.company.slice(0, 200),
      location: j.location.slice(0, 200),
      fit: j.fit,
      shown: new Date(at).toISOString().slice(0, 16).replace('T', ' '),
      opened: opened?.[j.id] ? new Date(opened[j.id]).toISOString().slice(0, 16).replace('T', ' ') : null,
      source: j.attribution.label.replace(/^via /, ''),
    }));
}

const shownJobs = () =>
  messages
    .filter((m) => m.kind === 'jobs')
    .flatMap((m) => m.jobs ?? [])
    .slice(-10)
    .map((j) => ({ title: j.title.slice(0, 400), company: j.company.slice(0, 400), location: j.location.slice(0, 400), fit: j.fit, why: j.why, gaps: j.gaps }));

function searchingNode() {
  const li = el('li', 'cc-msg cc-msg--coach cc-searching');
  li.setAttribute('role', 'status');
  const orbit = el('span', 'cc-orbit');
  orbit.setAttribute('aria-hidden', 'true');
  orbit.append(orb());
  for (let i = 0; i < 3; i++) orbit.append(el('span', `cc-orbit__card cc-orbit__card--${i + 1}`));
  const body = el('div', 'cc-msg__body');
  body.append(el('p', 'cc-msg__text', 'Searching the freshest jobs for you…'));
  li.append(orbit, body);
  return li;
}

type JobsData = { jobs: RankedJob[]; left: number; more?: number; reason?: string; checked?: number; searched?: string[]; searchable?: boolean; demand?: string };
const WIDEN = { anywhere: 'Search remote roles anywhere', roles: 'Edit my target roles' } as const;

/** The shared pool first; if nothing there fits, a live search of job sites (streamed), saved for everyone. */
/** `silent`: Ami picked this tool from the visitor's own message, which is already in the chat. */
async function findJobs(more = false, opts: { anywhere?: boolean; userText?: string; silent?: boolean } = {}) {
  if (busy) return;
  const userText = opts.userText ?? (more ? 'Show me more' : 'Find jobs for me');
  if (!stored) {
    if (!opts.silent) await add({ role: 'user', text: userText });
    await note(NOTES.jobsNeedProfile);
    return;
  }
  setBusy(true);
  try {
    if (!opts.silent) await add({ role: 'user', text: userText });
    setOrb('searching');
    let data: JobsData | null = null;
    if (!opts.anywhere) {
      const searching = searchingNode();
      msgsEl.append(searching);
      log.scrollTop = log.scrollHeight;
      const res = await deviceFetch('/api/career/jobs', jsonBody({ profile: stored.profile, day: localDay(), today: localDay(), count: 10, more })).catch(() => null);
      searching.remove();
      if (!res?.ok) {
        setOrb('error');
        await (res ? errorNote(res, 'messages') : note(NOTES.offline));
        return;
      }
      data = (await res.json()) as JobsData;
    }
    if (!more && (!data || (!data.jobs.length && (data.reason === 'none' || data.reason === 'empty')))) {
      data = await searchLive(!!opts.anywhere, data?.checked);
    }
    if (!data) return;
    if (!data.jobs.length) {
      setOrb('done');
      return noJobs(data);
    }
    const hour = data.jobs.filter((j) => j.time.kind !== 'updated' && Date.now() - j.time.at <= 3600_000).length;
    const intro = more
      ? 'A few more for you:'
      : data.searched
        ? `I searched job sites for ${data.searched.join(' and ')}. Here are the strongest recent matches.`
        : hour
          ? `Here are today's freshest matches for you. ${hour === 1 ? 'One was' : `${hour} were`} posted within the last hour.`
          : 'Here are the most recent strong matches for you.';
    const top = data.jobs[0];
    const suggest = [`Why is ${top.company} the top match?`, `Prep me for the ${top.title} interview`, 'What should I improve first?'].map((s) => s.slice(0, 60));
    // Older "Show more" buttons go: only the newest set of cards offers more.
    for (const b of msgsEl.querySelectorAll('.cc-jobs__more')) b.remove();
    await add({ role: 'coach', text: intro, kind: 'jobs', jobs: data.jobs, left: data.left, more: data.more ?? 0, suggest });
    suggestions(suggest);
    announce(`${intro} ${data.jobs.length} job${data.jobs.length > 1 ? 's' : ''}. ${data.left} of ${DAILY_LIMITS.jobs} left today.`);
    setOrb('done');
  } finally {
    setBusy(false);
    loadUsage();
  }
}

/** Streams the live search: each step shows in the searching card; returns the final cards (or null after a note). */
async function searchLive(anywhere: boolean, checked?: number): Promise<JobsData | null> {
  const searching = searchingNode();
  const line = $<HTMLElement>('.cc-msg__text', searching);
  line.textContent = checked ? `Nothing in today's ${checked} jobs fits you well, so I'm searching job sites now…` : 'Searching job sites for you now…';
  msgsEl.append(searching);
  log.scrollTop = log.scrollHeight;
  try {
    const res = await deviceFetch('/api/career/job-search', jsonBody({ profile: stored!.profile, day: localDay(), today: localDay(), count: 10, anywhere })).catch(() => null);
    if (!res?.ok || !res.body || !res.headers.get('content-type')?.includes('event-stream')) {
      if (res?.ok) return { ...((await res.json()) as JobsData), checked };
      setOrb('error');
      const err = res ? ((await res.clone().json().catch(() => ({}))) as { error?: string; kind?: string }) : {};
      if (err.error === 'limit' && err.kind === 'searches') await note(NOTES.searchLimit);
      else await (res ? errorNote(res, 'messages') : note(NOTES.offline));
      return null;
    }
    let data: JobsData | null = null;
    let failed = '';
    for await (const { event, data: payload } of readEvents(res)) {
      if (event === 'progress') line.textContent = (payload as { text: string }).text;
      else if (event === 'result') data = payload as JobsData;
      else if (event === 'error') failed = (payload as { code?: string }).code ?? 'upstream';
    }
    if (!data) {
      setOrb('error');
      await note(failed === 'breather' ? NOTES.offline : NOTES.error);
      return null;
    }
    return { ...data, checked: data.checked ?? checked };
  } finally {
    searching.remove();
  }
}

/** An honest "nothing fits": what was checked and searched, and two ways to widen it. */
async function noJobs(data: JobsData) {
  if (data.reason === 'limit') return note(NOTES.jobsLimit);
  if (data.reason === 'warming') {
    await note(NOTES.jobsWarming);
    return suggestions(['Find jobs for me']);
  }
  const roles = stored?.profile.targetRoles.slice(0, 2).join(' or ') || 'your roles';
  const checked = data.checked ? `I checked ${data.checked} recent ${data.checked === 1 ? 'job' : 'jobs'}` : "I couldn't find recent jobs";
  const searched = data.searched?.length ? ` and searched job sites for ${data.searched.join(' and ')}` : '';
  const from = data.demand ? ` you can apply for from ${data.demand}` : '';
  const more = data.demand ? ` I've asked for more roles in ${data.demand}: new company boards are checked every hour, so try again later.` : ' Widening the search usually helps.';
  await add({ role: 'coach', text: `${checked}${searched}, but none${from} fit ${roles} at 55% or better.${more}`, kind: 'note', suggest: [WIDEN.anywhere, WIDEN.roles] });
  suggestions([WIDEN.anywhere, WIDEN.roles]);
}

// ---------- tailor, improve, cover letter (career-mode.md §3.4–3.5) ----------
const resumeForAI = () => withoutContacts(stored!.resumeText).slice(0, 20_000);

/** This chat is now about this job: follow-ups ("tailor my résumé for it") and the chat itself use it. */
async function rememberJob(job: Task['job']) {
  const c = current();
  if (!c || !job) return;
  c.job = job;
  await saveConversation(c);
}

async function needProfile(userText: string) {
  await add({ role: 'user', text: userText });
  await note(NOTES.jobsNeedProfile.replace('match jobs to', 'work from'));
}

function liveNode(text: string) {
  const li = el('li', 'cc-msg cc-msg--coach is-live');
  const body = el('div', 'cc-msg__body');
  const p = el('p', 'cc-msg__text', text);
  const dots = el('span', 'cc-typing');
  dots.setAttribute('aria-hidden', 'true');
  dots.append(el('span'), el('span'), el('span'));
  body.append(p, dots);
  li.append(orb(), body);
  msgsEl.append(li);
  log.scrollTop = log.scrollHeight;
  return { li, p };
}

async function failNote(res: Response | null, quota: 'messages' | 'tailored' | 'letters') {
  if (!res) return note(NOTES.offline);
  if (await isBreather(res)) return;
  const { error } = (await res.json().catch(() => ({}))) as { error?: string };
  if (error === 'limit') return note(quota === 'tailored' ? NOTES.limitTailored : quota === 'letters' ? NOTES.limitLetters : NOTES.limitMessages);
  if (error === 'job-expired') return note(NOTES.jobExpired).then(() => jobPanel());
  if (error === 'job-too-short') return note(NOTES.jobShort).then(() => jobPanel());
  if (error === 'upstream') return note(NOTES.upstream);
  if (error === 'devices') return note(NOTES.devices);
  if (error === 'unavailable' || res.status === 503) return note(NOTES.offline);
  return note(NOTES.error);
}

/** Paste a job description (tailor or cover letter). URLs are refused: we never fetch pages server-side. */
/** `prefill`: text the visitor already pasted (when Ami couldn't check it), so one click continues. */
function jobPanel(prefill = '') {
  msgsEl.querySelector('.cc-jobpaste')?.remove();
  const li = el('li', 'cc-msg cc-msg--coach cc-paste cc-jobpaste');
  const f = el('form', 'cc-paste__form');
  const label = el('label', 'cc-field');
  const area = el('textarea', 'cc-field__input cc-paste__area');
  Object.assign(area, { maxLength: 15_000, rows: 8, name: 'job', value: prefill });
  label.append(el('span', 'cc-field__label', 'Job description'), area);
  const go = (what: 'both' | 'tailor' | 'letter') => async () => {
    const text = area.value.trim();
    if (/^\s*https?:\/\/\S+\s*$/i.test(text)) return note(NOTES.urlOnly);
    if (text.length < 200) return area.focus();
    li.remove();
    const job = { description: text };
    if (what === 'both') startBoth(job, 'Tailor my résumé and write a cover letter for this job description.');
    else if (what === 'tailor') startTailor({ mode: 'tailor', job }, 'Tailor my résumé to this job description.');
    else startLetter(job, 'Write a cover letter for this job description.');
  };
  const actions = el('div', 'cc-edit__actions');
  actions.append(
    button('Résumé + cover letter', 'btn btn--primary cc-btn-sm', go('both')),
    button('Résumé only', 'btn btn--secondary cc-btn-sm', go('tailor')),
    button('Letter only', 'btn btn--secondary cc-btn-sm', go('letter')),
  );
  f.append(label, actions);
  f.addEventListener('submit', (e) => e.preventDefault());
  li.append(orb(), f);
  msgsEl.append(li);
  log.scrollTop = log.scrollHeight;
  area.focus();
}

/** Both documents for one job. If today's limit for one is used up, say so and make the other. */
async function startBoth(job: NonNullable<Task['job']>, userText: string | null, tone?: string) {
  if (!stored) return userText === null ? undefined : needProfile(userText);
  const left = (k: UsageKind) => (usage ? usage.limits[k] - usage.used[k] : 1);
  if (left('tailored') > 0 && left('letters') > 0) return startTailor({ mode: 'tailor', then: 'letter', job, tone }, userText);
  if (left('tailored') > 0) {
    if (userText !== null) await add({ role: 'user', text: userText });
    await note(`${NOTES.limitLetters} I'll tailor your résumé now.`);
    return startTailor({ mode: 'tailor', job }, null);
  }
  if (left('letters') > 0) {
    if (userText !== null) await add({ role: 'user', text: userText });
    await note(`${NOTES.limitTailored} I'll write the cover letter now.`);
    return startLetter(job, null, tone);
  }
  if (userText !== null) await add({ role: 'user', text: userText });
  return note(NOTES.limitTailored);
}

async function startTailor(task: Task, userText: string | null) {
  if (busy) return;
  if (!stored) return userText === null ? undefined : needProfile(userText);
  setBusy(true);
  try {
    if (userText !== null) await add({ role: 'user', text: userText });
    await rememberJob(task.job);
    setOrb('thinking');
    const live = liveNode(task.mode === 'improve' ? 'Reading your résumé against your target role…' : 'Reading the job against your résumé…');
    const res = await deviceFetch('/api/career/tailor', jsonBody({ mode: task.mode, phase: 'analyze', profile: stored.profile, resume: resumeForAI(), job: task.job, day: localDay(), today: localDay() })).catch(() => null);
    live.li.remove();
    if (!res?.ok) {
      setOrb('error');
      return failNote(res, 'messages');
    }
    const { analysis } = (await res.json()) as { analysis: Analysis };
    const m = await add({ role: 'coach', text: '', kind: 'match', task, analysis, answers: analysis.questions.length ? undefined : null });
    setOrb('done');
    if (!analysis.questions.length) {
      setBusy(false);
      await write(m);
    } else msgsEl.querySelector<HTMLTextAreaElement>(`[data-id="${m.id}"] textarea`)?.focus();
  } finally {
    setBusy(false);
    loadUsage();
  }
}

function matchBlock(m: Message) {
  const a = m.analysis!;
  const box = el('div', 'cc-match');
  const target = m.task?.mode === 'improve' ? stored?.profile.targetRoles[0] ?? 'your target role' : a.role ?? m.task?.job?.title ?? 'this job';
  box.append(el('p', 'label cc-match__label', `Match · ${target}`));
  const list = el('ul', 'cc-match__list');
  for (const item of a.match) {
    const li = el('li', `cc-match__item cc-match__item--${item.kind}`, item.text);
    list.append(li);
  }
  box.append(list);
  if (!a.questions.length) return box;

  const answered = m.answers !== undefined;
  const fields: { question: string; area: HTMLTextAreaElement }[] = [];
  for (const q of a.questions) {
    const card = el('div', 'cc-question');
    card.append(el('p', 'cc-question__title', 'Quick question'), el('p', 'cc-question__text', q.question));
    if (answered) {
      const reply = m.answers?.find((x) => x.question === q.question)?.answer;
      card.append(el('p', reply ? 'cc-question__answer' : 'cc-question__skipped', reply || 'Skipped'));
    } else {
      const area = el('textarea', 'cc-field__input cc-question__input');
      Object.assign(area, { rows: 2, maxLength: 500 });
      area.setAttribute('aria-label', q.question);
      area.placeholder = 'Your answer (optional)';
      fields.push({ question: q.question, area });
      card.append(area);
    }
    box.append(card);
  }
  if (!answered) {
    const actions = el('div', 'cc-edit__actions');
    const submit = (skip: boolean) => async () => {
      if (busy) return;
      const answers = skip ? null : fields.map((f) => ({ question: f.question, answer: f.area.value.trim() })).filter((x) => x.answer);
      m.answers = answers?.length ? answers : null;
      await vault.put('messages', m.id, m, m.conv);
      box.replaceWith(matchBlock(m));
      await write(m);
    };
    actions.append(button('Use my answers', 'btn btn--primary cc-btn-sm', submit(false)), button('Skip', 'btn btn--secondary cc-btn-sm', submit(true)));
    box.append(actions);
  }
  return box;
}

async function write(m: Message) {
  if (busy || !stored) return;
  setBusy(true);
  let next = false;
  try {
    const task = m.task!;
    setOrb('streaming');
    const live = liveNode(task.mode === 'improve' ? 'Sharpening your résumé…' : 'Writing your tailored résumé…');
    const res = await deviceFetch(
      '/api/career/tailor',
      jsonBody({ mode: task.mode, phase: 'write', profile: stored.profile, resume: resumeForAI(), job: task.job, answers: m.answers ?? [], day: localDay(), today: localDay() }),
    ).catch(() => null);
    if (!res?.ok || !res.body) {
      live.li.remove();
      setOrb('error');
      return failNote(res, 'tailored');
    }
    type Written = { result: WriteResult; flags: Flag[] };
    let out = null as Written | null;
    for await (const { event, data } of readEvents(res)) {
      if (event === 'progress') live.p.textContent = `${task.mode === 'improve' ? 'Sharpening' : 'Writing'} your résumé… ${Math.min(99, Math.round((data as { chars: number }).chars / 60))}%`;
      if (event === 'result') out = data as Written;
    }
    live.li.remove();
    if (!out) {
      setOrb('error');
      return note(NOTES.error);
    }
    const before = profileToResume(stored.profile);
    const a = m.analysis!;
    const doc: ResumeDoc = {
      id: uid(),
      kind: 'resume',
      mode: task.mode,
      title: task.mode === 'improve' ? 'Stronger résumé' : [a.role ?? task.job?.title, a.company ?? task.job?.company].filter(Boolean).join(' · ') || 'Tailored résumé',
      fileBase: fileBase(out.result.tailored.name ?? stored.profile.identity.name, 'resume', task.mode === 'tailor' ? (a.company ?? task.job?.company) : null, task.mode === 'tailor' ? (a.role ?? task.job?.title) : null),
      contact: contactLine(stored.resumeText, out.result.tailored.location ?? stored.profile.location),
      before,
      tailored: out.result.tailored,
      changed: changedKeys(before, out.result.tailored),
      flags: out.flags,
      createdAt: Date.now(),
    };
    await vault.put('documents', doc.id, doc);
    await add({ role: 'coach', text: '', kind: 'tailored', docId: doc.id, ats: out.result.ats, changes: out.result.changes, critique: out.result.critique, flags: out.flags });
    await openDoc(doc.id);
    announce(out.flags.length ? `Your résumé is ready. ${out.flags.length} item(s) to check.` : 'Your tailored résumé is ready. Nothing was invented.');
    setOrb('done');
    next = task.then === 'letter' && !!task.job;
  } finally {
    setBusy(false);
    loadUsage();
  }
  if (next) await startLetter(m.task!.job!, null, m.task!.tone);
}

/** `userText: null` = part of "Résumé + cover letter", so no new user turn. */
/** `tone`: how they want the letter ("warm and short"), passed as their answer so the letter follows it. */
async function startLetter(job: NonNullable<Task['job']>, userText: string | null, tone?: string) {
  if (busy) return;
  if (!stored) return userText === null ? undefined : needProfile(userText);
  setBusy(true);
  try {
    if (userText !== null) await add({ role: 'user', text: userText });
    await rememberJob(job);
    setOrb('thinking');
    const live = liveNode('Writing your cover letter…');
    const answers = tone ? [{ question: 'How should the cover letter sound or be written?', answer: tone.slice(0, 500) }] : [];
    const res = await deviceFetch('/api/career/cover-letter', jsonBody({ profile: stored.profile, resume: resumeForAI(), job, answers, day: localDay(), today: localDay() })).catch(() => null);
    if (!res?.ok || !res.body) {
      live.li.remove();
      setOrb('error');
      return failNote(res, 'letters');
    }
    let text = '';
    let flags: Flag[] = [];
    let failed = false;
    let said = '';
    for await (const { event, data } of readEvents(res)) {
      if (event === 'token') {
        setOrb('streaming');
        text += (data as { t: string }).t;
        live.p.textContent = text;
      } else if (event === 'flags') flags = (data as { flags: Flag[] }).flags;
      else if (event === 'message') said = (data as { text: string }).text;
      else if (event === 'error') failed = true;
    }
    live.li.remove();
    // Ami replied instead of writing a letter: it's a message, not a document (and it didn't use today's letter).
    if (said) {
      setOrb('done');
      return add({ role: 'coach', text: said });
    }
    if (failed || !text.trim()) {
      setOrb('error');
      return note(NOTES.error);
    }
    const name = stored.profile.identity.name ?? '';
    const doc: LetterDoc = {
      id: uid(),
      kind: 'letter',
      title: ['Cover letter', job.title, job.company].filter(Boolean).join(' · '),
      fileBase: fileBase(name, 'cover-letter', job.company, job.title),
      name,
      contact: contactLine(stored.resumeText, stored.profile.location),
      letter: text.trim(),
      flags,
      createdAt: Date.now(),
    };
    await vault.put('documents', doc.id, doc);
    await add({ role: 'coach', text: '', kind: 'letter', docId: doc.id, flags });
    await openDoc(doc.id);
    setOrb('done');
  } finally {
    setBusy(false);
    loadUsage();
  }
}

/** An interview prep guide for a job, shaped by the visitor's own instructions ("3-day plan, no behavioural"). */
async function startGuide(job: NonNullable<Task['job']>, instructions: string) {
  if (busy || !stored) return;
  setBusy(true);
  try {
    await rememberJob(job);
    setOrb('thinking');
    const live = liveNode('Preparing your interview guide…');
    const res = await deviceFetch('/api/career/prep-guide', jsonBody({ profile: stored.profile, resume: resumeForAI(), job, instructions, day: localDay(), today: localDay() })).catch(() => null);
    if (!res?.ok || !res.body) {
      live.li.remove();
      setOrb('error');
      const err = res ? ((await res.clone().json().catch(() => ({}))) as { error?: string; kind?: string }) : {};
      if (err.error === 'limit' && err.kind === 'guides') return note(NOTES.limitGuides);
      return failNote(res, 'messages');
    }
    let out: { guide: Guide; flags: Flag[] } | null = null;
    for await (const { event, data } of readEvents(res)) {
      if (event === 'progress') {
        const p = data as { text: string; chars?: number };
        setOrb('streaming');
        live.p.textContent = p.chars ? `${p.text} ${Math.min(99, Math.round(p.chars / 250))}%` : p.text;
      } else if (event === 'result') out = data as { guide: Guide; flags: Flag[] };
    }
    live.li.remove();
    if (!out) {
      setOrb('error');
      return note(NOTES.error);
    }
    const name = stored.profile.identity.name ?? '';
    const d: GuideDoc = {
      id: uid(),
      kind: 'guide',
      title: ['Interview prep', job.title, job.company].filter(Boolean).join(' · '),
      fileBase: fileBase(name, 'interview-prep', job.company, job.title),
      guide: out.guide,
      flags: out.flags,
      createdAt: Date.now(),
    };
    await vault.put('documents', d.id, d);
    const outline = out.guide.sections.map((sec) => sec.heading).join('; ');
    await add({ role: 'coach', text: outline.slice(0, 400), kind: 'guide', docId: d.id, flags: out.flags });
    await openDoc(d.id);
    announce('Your interview prep guide is ready.');
    setOrb('done');
  } finally {
    setBusy(false);
    loadUsage();
  }
}

const FLAG_LABEL: Record<Flag['kind'], string> = { number: 'number', name: 'name or tool', employer: 'employer', title: 'job title', date: 'date' };

function resultBlock(m: Message) {
  const box = el('div', 'cc-result');
  const flags = m.flags ?? [];
  const what = m.kind === 'guide' ? 'Your interview prep guide is ready.' : m.kind === 'letter' ? 'Your cover letter is ready.' : m.critique?.length ? 'Your stronger résumé is ready. Every highlighted line changed.' : 'Your tailored résumé is ready. Every highlighted line changed.';
  if (!flags.length) {
    box.append(el('p', 'cc-result__lead', m.kind === 'guide' ? `${what} The answer outlines use only your real experience.` : `${what} Nothing was invented: numbers come only from your résumé${m.kind === 'letter' ? '' : ' and your answers'}.`));
  } else {
    box.append(el('p', 'cc-result__lead', what));
    const warn = el('div', 'cc-flags');
    warn.setAttribute('role', 'note');
    warn.append(el('p', 'cc-flags__title', 'Check these before you send it: they aren’t in your résumé or your answers.'));
    const list = el('ul');
    for (const f of flags) list.append(el('li', undefined, `${f.text} (${FLAG_LABEL[f.kind]})`));
    warn.append(list, el('p', 'cc-flags__hint', 'Edit or remove them in the preview, or keep them only if they’re true.'));
    box.append(warn);
  }
  if (m.critique?.length) {
    box.append(el('p', 'label cc-result__label', '5-point critique'));
    const list = el('ul', 'cc-critique');
    for (const c of m.critique) {
      const li = el('li');
      li.append(el('strong', undefined, `${c.area[0].toUpperCase()}${c.area.slice(1)}: `), document.createTextNode(c.note));
      list.append(li);
    }
    box.append(list);
  }
  if (m.ats) {
    const card = el('div', 'cc-ats');
    card.append(el('p', 'label cc-result__label', 'Keyword match'));
    const row = el('div', 'cc-ats__row');
    const nums = el('span', 'cc-ats__nums');
    nums.append(el('span', 'cc-ats__before', String(m.ats.before)), el('span', 'cc-ats__arrow', '→'), el('span', 'cc-ats__after', String(m.ats.after)));
    nums.setAttribute('aria-label', `Keyword match from ${m.ats.before} to ${m.ats.after} out of 100`);
    const bar = el('span', 'cc-ats__bar');
    bar.setAttribute('aria-hidden', 'true');
    const b = el('span', 'cc-ats__fill cc-ats__fill--before');
    const gain = el('span', 'cc-ats__fill cc-ats__fill--after');
    b.style.transform = `scaleX(${(m.ats.before / 100).toFixed(2)})`;
    gain.style.transform = `scaleX(${(Math.max(m.ats.after, m.ats.before) / 100).toFixed(2)})`;
    bar.append(gain, b);
    row.append(nums, bar);
    card.append(row);
    box.append(card);
  }
  if (m.changes?.length) {
    box.append(el('p', 'label cc-result__label', 'What changed'));
    const list = el('ol', 'cc-changes');
    for (const c of m.changes) {
      const li = el('li');
      li.append(el('strong', undefined, `${c.section}: `), document.createTextNode(c.why));
      list.append(li);
    }
    box.append(list);
  }
  if (m.docId) box.append(docCard(m));
  return box;
}

const ARROW = 'M5 12h14M13 6l6 6-6 6';
const DOWNLOAD = 'M12 4v11M7 10l5 5 5-5M5 20h14';

/** A paper card for a finished document: opens the preview, downloads directly, and pulses until it's in the preview. */
function docCard(m: Message) {
  const id = m.docId!;
  const letter = m.kind === 'letter';
  const guide = m.kind === 'guide';
  const what = guide ? 'prep guide' : letter ? 'cover letter' : 'résumé';
  const card = el('div', 'cc-doccard');
  card.dataset.docCard = id;
  if (Date.now() - m.at < 5000) card.classList.add('is-new');
  const open = el('button', 'cc-doccard__open');
  open.type = 'button';
  const sheet = el('span', 'cc-doccard__sheet');
  sheet.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 6; i++) sheet.append(el('span', 'cc-doccard__line'));
  const text = el('span', 'cc-doccard__text');
  const sub = el('span', 'cc-doccard__sub', 'Ready to download');
  const cta = el('span', 'cc-doccard__cta');
  text.append(el('span', 'cc-doccard__kind', guide ? 'Interview prep guide' : letter ? 'Cover letter' : m.critique?.length ? 'Stronger résumé' : 'Tailored résumé'), sub, cta);
  const dot = el('span', 'cc-doccard__dot');
  dot.setAttribute('aria-hidden', 'true');
  open.append(sheet, text, dot);
  open.addEventListener('click', () => openDoc(id));

  const status = el('p', 'cc-doccard__status');
  status.setAttribute('role', 'status');
  const dl = el('div', 'cc-doccard__dl');
  for (const kind of ['pdf', 'docx'] as const) {
    const b = withIcon(button(kind.toUpperCase(), 'btn btn--secondary cc-btn-sm', async () => {
      const d = await vault.get<Doc>('documents', id);
      if (d) await saveFile(d, kind, b, status);
    }), DOWNLOAD);
    b.setAttribute('aria-label', `Download the ${what} as ${kind.toUpperCase()}`);
    dl.append(b);
  }
  card.append(open, dl, status);
  syncCard(card);
  vault.get<Doc>('documents', id).then((d) => {
    const title = d?.title.replace(/^(Cover letter|Stronger résumé|Tailored résumé|Interview prep)( · )?/, '');
    if (title) sub.textContent = title;
  });
  return card;
}

function syncCard(card: HTMLElement) {
  const showing = card.dataset.docCard === shownDoc;
  card.classList.toggle('is-showing', showing);
  const cta = $<HTMLElement>('.cc-doccard__cta', card);
  cta.replaceChildren(document.createTextNode(showing ? 'In the preview' : 'Open'));
  if (!showing) cta.append(icon(ARROW));
}

async function saveFile(d: Doc, kind: 'pdf' | 'docx', b: HTMLButtonElement, status: HTMLElement) {
  b.disabled = true;
  status.classList.remove('is-error');
  status.textContent = 'Preparing your file…';
  try {
    const { blocksFor, download, toDocx, toPdf } = await import('../../lib/career/export.ts');
    const blocks = blocksFor(d);
    const blob = kind === 'docx' ? await toDocx(blocks) : await toPdf(blocks, d.title);
    download(blob, `${d.fileBase}.${kind}`);
    status.textContent = `Saved ${d.fileBase}.${kind}: check your Downloads folder.`;
  } catch (err) {
    status.classList.add('is-error');
    status.textContent = `Couldn't create the ${kind.toUpperCase()} file (${(err as Error).message || 'unknown error'}). Try again, or try another browser.`;
  } finally {
    b.disabled = false;
  }
}

// ---------- preview: Before/Tailored, inline editing, downloads ----------
const preview = $<HTMLElement>('[data-preview]');
const docEl = $<HTMLElement>('[data-doc]');
const toggle = $<HTMLElement>('[data-toggle]');
const wide = matchMedia('(min-width: 1100px)');
let doc: Doc | null = null;
let view: 'before' | 'tailored' = 'tailored';

/** Sticky second column from 1100 px; below that, the preview sits at the end of the conversation. */
function placePreview() {
  const home = wide.matches ? $<HTMLElement>('.cc-main') : $<HTMLElement>('[data-scroll]');
  if (preview.parentElement !== home) home.append(preview);
  cc.classList.toggle('has-preview', !!doc && wide.matches);
}
wide.addEventListener('change', placePreview);

async function showDoc(id: string | null) {
  doc = id ? ((await vault.get<Doc>('documents', id)) ?? null) : null;
  preview.hidden = !doc;
  shownDoc = doc?.id ?? null;
  for (const card of msgsEl.querySelectorAll<HTMLElement>('[data-doc-card]')) syncCard(card);
  placePreview();
  if (doc) renderDoc();
}

async function openDoc(id: string) {
  const c = current();
  if (c) {
    Object.assign(c, { docId: id, docOpen: true });
    await saveConversation(c);
  }
  view = 'tailored';
  await showDoc(id);
  if (!wide.matches) preview.scrollIntoView({ block: 'start' });
}

/** The guide as a clean, readable page (the same content the PDF gets). Flagged phrases are underlined. */
function guideNodes(g: Guide, flagged: string[]): Node[] {
  const para = (cls: string, text: string) => {
    const p = el('p', cls);
    p.append(editableText(text, flagged));
    return p;
  };
  const nodes: Node[] = [el('h2', 'cc-doc__name', g.title), el('p', 'cc-doc__contact', g.subtitle)];
  if (g.note) nodes.push(el('p', 'cc-guide__note', g.note));
  for (const s of g.sections) {
    const sec = el('section', 'cc-doc__section cc-guide__section');
    sec.append(el('h3', 'cc-doc__h', s.heading));
    if (s.intro) sec.append(para('cc-guide__intro', s.intro));
    const numbered = s.items.some((i) => i.kind === 'question' || i.kind === 'step');
    const list = el(numbered ? 'ol' : 'div', 'cc-guide__items');
    for (const item of s.items) {
      const box = el(numbered ? 'li' : 'div', `cc-guide__item cc-guide__item--${item.kind}`);
      if (item.title) box.append(el(item.kind === 'question' ? 'h4' : 'p', 'cc-guide__title', item.title));
      if (item.why) box.append(para('cc-guide__why', `Why they ask: ${item.why}`));
      if (item.text) box.append(para('cc-guide__text', item.text));
      const points = [...item.bullets, ...item.answer];
      if (points.length) {
        const ul = el('ul', 'cc-guide__points');
        for (const b of points) {
          const li = el('li');
          li.append(editableText(b, flagged));
          ul.append(li);
        }
        if (item.answer.length) box.append(el('p', 'cc-guide__label', 'A strong answer'));
        box.append(ul);
      }
      list.append(box);
    }
    sec.append(list);
    nodes.push(sec);
  }
  if (g.sources.length) {
    const sec = el('section', 'cc-doc__section');
    const ul = el('ul', 'cc-guide__sources');
    for (const src of g.sources) {
      const li = el('li');
      li.append(link(src.title, src.url, 'cc-guide__source'));
      ul.append(li);
    }
    sec.append(el('h3', 'cc-doc__h', 'Sources'), ul);
    nodes.push(sec);
  }
  return nodes;
}

/** Plain text with any flagged phrase underlined (read-only). */
function editableText(text: string, flagged: string[]): Node {
  const hit = flagged.find((f) => f && text.includes(f));
  if (!hit) return document.createTextNode(text);
  const span = el('span');
  const [before, ...after] = text.split(hit);
  span.append(document.createTextNode(before), el('mark', 'cc-doc__flag', hit), document.createTextNode(after.join(hit)));
  return span;
}

function editable(text: string, key: string, changed: boolean, flagged: string[]) {
  const span = el('span', 'cc-doc__line', text);
  span.dataset.key = key;
  if (view === 'tailored') {
    span.contentEditable = 'plaintext-only';
    span.spellcheck = true;
    if (changed) span.classList.add('is-changed');
    if (flagged.some((f) => text.toLowerCase().includes(f.toLowerCase()))) span.classList.add('is-flagged');
  }
  return span;
}

function renderDoc() {
  if (!doc) return;
  const flagged = doc.flags.map((f) => f.text);
  toggle.hidden = doc.kind !== 'resume';
  for (const b of toggle.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
  $<HTMLElement>('.cc-preview__hint').hidden = view !== 'tailored';
  $<HTMLElement>('[data-doc-file]').textContent = `${doc.fileBase}.docx`;
  const nodes: Node[] = [];
  $<HTMLElement>('[data-print]').hidden = doc.kind !== 'guide';
  $<HTMLElement>('[data-dl="docx"]').hidden = doc.kind === 'guide';
  if (doc.kind === 'guide') {
    $<HTMLElement>('.cc-preview__hint').hidden = true;
    $<HTMLElement>('[data-doc-file]').textContent = `${doc.fileBase}.pdf`;
    docEl.setAttribute('aria-label', 'Interview prep guide');
    docEl.replaceChildren(...guideNodes(doc.guide, doc.flags.map((f) => f.text)));
    return;
  }
  if (doc.kind === 'letter') {
    nodes.push(el('h2', 'cc-doc__name', doc.name), el('p', 'cc-doc__contact', doc.contact));
    doc.letter.split(/\n{2,}/).forEach((para, i) => {
      const p = el('p', 'cc-doc__para');
      p.append(editable(para.trim(), `p.${i}`, false, flagged));
      nodes.push(p);
    });
    docEl.setAttribute('aria-label', 'Cover letter');
    docEl.replaceChildren(...nodes);
    return;
  }
  const r = view === 'tailored' ? doc.tailored : doc.before;
  const changed = new Set(view === 'tailored' ? doc.changed : []);
  const line = (text: string, key: string) => editable(text, key, changed.has(key), flagged);
  docEl.setAttribute('aria-label', view === 'tailored' ? 'Tailored résumé (editable)' : 'Résumé before tailoring');
  nodes.push(el('h2', 'cc-doc__name', r.name ?? ''), el('p', 'cc-doc__contact', doc.contact));
  const section = (title: string, ...children: Node[]) => {
    const sec = el('section', 'cc-doc__section');
    sec.append(el('h3', 'cc-doc__h', title), ...children);
    nodes.push(sec);
  };
  if (r.summary) {
    const p = el('p');
    p.append(line(r.summary, 'summary'));
    section('Summary', p);
  }
  if (r.experience.length) {
    const parts: Node[] = [];
    r.experience.forEach((e, i) => {
      const head = el('p', 'cc-doc__role');
      head.append(el('strong', undefined, [e.role, e.company].filter(Boolean).join(' · ')), el('span', 'cc-doc__dates', e.dates));
      const ul = el('ul');
      e.bullets.forEach((b, j) => {
        const li = el('li');
        li.append(line(b, `exp.${i}.bullets.${j}`));
        ul.append(li);
      });
      parts.push(head, ul);
    });
    section('Experience', ...parts);
  }
  if (r.skills.length) {
    const parts: Node[] = [];
    r.skills.forEach((g, i) => {
      const p = el('p', 'cc-doc__skills');
      if (r.skills.length > 1 && g.group) p.append(el('strong', undefined, `${g.group}: `));
      g.items.forEach((item, j) => {
        if (j) p.append(document.createTextNode(' · '));
        p.append(line(item, `skills.${i}.items.${j}`));
      });
      parts.push(p);
    });
    section('Skills', ...parts);
  }
  for (const [title, key] of [['Education', 'education'], ['Certifications', 'certifications']] as const) {
    if (r[key].length) section(title, ...r[key].map((t, i) => { const p = el('p'); p.append(line(t, `${key}.${i}`)); return p; }));
  }
  docEl.replaceChildren(...nodes);
}

$<HTMLButtonElement>('[data-preview-close]').addEventListener('click', async () => {
  const c = current();
  if (c) {
    c.docOpen = false;
    await saveConversation(c);
  }
  await showDoc(null);
  input.focus();
  announce('Preview closed. Open the document card in the chat to see it again.');
});

toggle.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('[data-view]');
  if (!b || !doc) return;
  view = b.dataset.view as typeof view;
  renderDoc();
});

// Inline edits save to the vault (encrypted) as you type; Enter finishes a line instead of breaking it.
let editTimer = 0;
docEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.target as HTMLElement).isContentEditable) {
    e.preventDefault();
    (e.target as HTMLElement).blur();
  }
});
docEl.addEventListener('input', (e) => {
  const span = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
  if (!span || !doc) return;
  clearTimeout(editTimer);
  editTimer = window.setTimeout(async () => {
    if (!doc) return;
    if (doc.kind === 'letter') {
      doc.letter = [...docEl.querySelectorAll<HTMLElement>('[data-key^="p."]')].map((s) => s.textContent?.trim() ?? '').filter(Boolean).join('\n\n');
    } else if (doc.kind === 'resume' && getLine(doc.tailored, span.dataset.key!) !== undefined) {
      doc.tailored = setLine(doc.tailored, span.dataset.key!, span.textContent?.trim() ?? '');
    }
    await vault.put('documents', doc.id, doc);
    announce('Saved.');
  }, 400);
});

// Print / Save as PDF: the browser's own PDF of the styled guide (print styles show only the document).
$<HTMLButtonElement>('[data-print]').addEventListener('click', () => {
  document.documentElement.dataset.printing = '';
  window.print();
  delete document.documentElement.dataset.printing;
});

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-dl]')) {
  b.addEventListener('click', () => doc && saveFile(doc, b.dataset.dl as 'docx' | 'pdf', b, $<HTMLElement>('[data-dl-status]')));
}

// ---------- rendering ----------
function renderChats() {
  chatsEl.replaceChildren(
    ...conversations.map((c) => {
      const li = el('li');
      const b = el('button', 'cc-chat');
      b.type = 'button';
      b.dataset.conv = c.id;
      if (c.id === state.current) b.setAttribute('aria-current', 'true');
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('width', '16');
      icon.setAttribute('height', '16');
      icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M5 5h14v10H9l-4 4z');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linejoin', 'round');
      icon.append(path);
      b.append(icon, el('span', 'cc-chat__title', c.title), el('span', 'cc-chat__when', when(c.updatedAt)));
      li.append(b);
      return li;
    }),
  );
  chatsEmpty.hidden = conversations.length > 0;
}

function messageNode(m: Message) {
  const li = el('li', `cc-msg cc-msg--${m.role}${m.kind ? ` cc-msg--${m.kind}` : ''}`);
  li.dataset.id = m.id;
  if (m.role === 'coach') li.append(orb());
  if (m.kind === 'profile') {
    li.append(profileStrip());
    return li;
  }
  if (m.kind === 'jobs') {
    li.append(jobsBlock(m));
    return li;
  }
  if (m.kind === 'match') {
    li.append(matchBlock(m));
    return li;
  }
  if (m.kind === 'tailored' || m.kind === 'letter' || m.kind === 'guide') {
    li.append(resultBlock(m));
    return li;
  }
  const body = el('div', 'cc-msg__body');
  body.append(el('span', 'sr-only', m.role === 'user' ? 'You: ' : 'Ami: '));
  const content = el('div', 'cc-msg__text');
  if (m.role === 'coach') rich(content, m.text);
  else content.textContent = m.text;
  body.append(content);
  if (m.text.trim()) body.append(messageActions(m, content));
  li.append(body);
  return li;
}

const COPY = 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1';
const CHECK = 'M5 12l5 5L20 7';

/** Copy on every message; Edit on the visitor's latest message (shown only there, see refreshEdit). */
function messageActions(m: Message, content: HTMLElement) {
  const bar = el('div', 'cc-msg__actions');
  const copy = el('button', 'cc-msg__action');
  copy.type = 'button';
  copy.setAttribute('aria-label', m.role === 'user' ? 'Copy your message' : 'Copy Ami’s message');
  copy.append(icon(COPY));
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(m.text);
      copy.replaceChildren(icon(CHECK));
      announce('Copied.');
      setTimeout(() => copy.replaceChildren(icon(COPY)), 1500);
    } catch {
      announce("Couldn't copy. Select the text and copy it instead.");
    }
  });
  bar.append(copy);
  if (m.role === 'user') {
    const editBtn = el('button', 'cc-msg__action cc-msg__edit');
    editBtn.type = 'button';
    editBtn.setAttribute('aria-label', 'Edit your message');
    editBtn.append(icon(ICONS.pen));
    editBtn.addEventListener('click', () => editMessage(m, content, bar));
    bar.append(editBtn);
  }
  return bar;
}

/** Only the latest message the visitor wrote can be edited. */
function refreshEdit() {
  const last = [...messages].reverse().find((m) => m.role === 'user' && !m.kind);
  for (const b of msgsEl.querySelectorAll<HTMLElement>('.cc-msg__edit')) b.hidden = b.closest<HTMLElement>('[data-id]')?.dataset.id !== last?.id;
}

/** Edit in place; saving removes this message and everything after it, then sends the new text. */
function editMessage(m: Message, content: HTMLElement, bar: HTMLElement) {
  if (busy) return;
  const form = el('form', 'cc-msg__editor');
  const area = el('textarea', 'cc-field__input cc-msg__edit-area');
  area.value = m.text;
  area.rows = Math.min(10, Math.max(2, m.text.split('\n').length));
  area.setAttribute('aria-label', 'Edit your message');
  const actions = el('div', 'cc-edit__actions');
  const cancel = () => {
    form.replaceWith(content);
    bar.hidden = false;
    $<HTMLButtonElement>('.cc-msg__edit', bar).focus();
  };
  actions.append(button('Send', 'btn btn--primary cc-btn-sm', () => form.requestSubmit()), button('Cancel', 'btn btn--secondary cc-btn-sm', cancel));
  form.append(area, actions);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = area.value.trim();
    if (!text || busy) return;
    if (text === m.text.trim()) return cancel();
    const at = messages.findIndex((x) => x.id === m.id);
    const gone = messages.splice(at);
    await Promise.all(gone.map((x) => vault.removeRecord('messages', x.id)));
    for (const x of gone) msgsEl.querySelector(`[data-id="${x.id}"]`)?.remove();
    msgsEl.querySelector('.cc-suggest')?.remove();
    msgsEl.querySelector('.cc-jobpaste')?.remove();
    await send(text);
  });
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  content.replaceWith(form);
  bar.hidden = true;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

// ---------- understanding what the visitor asks for ----------
// Clear requests run their tool directly (intentOf, no model call). Everything else goes to Ami, who answers or calls a
// tool (ToolCallSchema) when the phrasing was unusual or text was pasted: the browser then runs that tool's flow.
type ToolCall =
  | { name: 'find_jobs'; input: { anywhere?: boolean } }
  | { name: 'show_jobs'; input: { which: 'saved' | 'recent' | 'applied' } }
  | { name: 'prep_guide'; input: { job: 'pasted' | 'current' | 'none'; instructions?: string | null; title?: string | null; company?: string | null } }
  | { name: 'make_document'; input: { kind: 'tailor' | 'letter' | 'both' | 'improve'; job: 'pasted' | 'current' | 'none'; title?: string | null; company?: string | null; tone?: string | null } };

/** Runs the tool Ami picked. The visitor's message is already in the chat, so no second "you" message is added. */
async function runTool(tool: ToolCall, userText: string) {
  if (tool.name === 'find_jobs') {
    // Jobs they already have are never a new search, whatever the model picked.
    if (/\b(saved|bookmark(ed)?|seen|saw|shown|previous(ly)?|earlier|already|again|before|last time|history|applied|my applications)\b/i.test(userText)) {
      return showJobs(/\b(applied|applications)\b/i.test(userText) ? 'applied' : /\b(saved|bookmark)/i.test(userText) ? 'saved' : 'recent', null);
    }
    return findJobs(false, { anywhere: !!tool.input.anywhere, silent: true });
  }
  if (tool.name === 'show_jobs') return showJobs(tool.input.which, null);
  if (tool.name === 'prep_guide') {
    if (!stored) return note(NOTES.jobsNeedProfile.replace('match jobs to', 'work from'));
    const { job: from, instructions, title: t, company: co } = tool.input;
    const posting = from === 'pasted' ? latestPasted(userText) : null;
    const job = posting ? { description: posting, ...(t ? { title: t } : {}), ...(co ? { company: co } : {}) } : from !== 'none' ? current()?.job : undefined;
    if (!job) {
      await note('Paste the job description below and I\'ll build your prep guide for it.');
      return jobPanel();
    }
    return startGuide(job, instructions ?? '');
  }
  const { kind, job: source, title, company, tone } = tool.input;
  if (!stored) return note(NOTES.jobsNeedProfile.replace('match jobs to', 'work from'));
  if (kind === 'improve') return startTailor({ mode: 'improve' }, null);
  // "Pasted": the most recent message in this chat with pasted text (not necessarily the latest: "I'm eligible, go ahead").
  const posting = source === 'pasted' ? latestPasted(userText) : null;
  const job =
    posting
      ? { description: posting, ...(title ? { title } : {}), ...(company ? { company } : {}) }
      : source === 'current' || source === 'pasted'
        ? current()?.job
        : undefined;
  if (!job) {
    // Ami judged there's no job description in the chat (what was pasted, if anything, is something else).
    await note(latestPasted(userText) ? "That doesn't look like a job description. Paste the job description below and I'll start." : NOTES.pasteJob);
    return jobPanel();
  }
  return forThisJob(kind, null, job, tone ?? undefined);
}

/** The latest text the visitor pasted in this chat (≥ 200 characters), newest message first; the job description. */
function latestPasted(latest: string): string | null {
  const texts = [latest, ...[...messages].reverse().filter((m) => m.role === 'user' && !m.kind).map((m) => m.text)];
  const hit = texts.find((t) => t.trim().length >= 200);
  return hit ? hit.trim().slice(0, 15_000) : null;
}

/** Tailor / letter / both for a job (the chat's own, or one given); without one, ask for the description once. */
async function forThisJob(what: 'both' | 'tailor' | 'letter', userText: string | null, given?: NonNullable<Task['job']>, tone?: string) {
  const job = given ?? current()?.job;
  if (job) return what === 'both' ? startBoth(job, userText, tone) : what === 'tailor' ? startTailor({ mode: 'tailor', job }, userText) : startLetter(job, userText, tone);
  if (!stored) return userText === null ? note(NOTES.jobsNeedProfile.replace('match jobs to', 'work from')) : needProfile(userText);
  // A posting was already pasted in this chat: Ami reads it and starts the document, instead of asking for it again.
  if (userText !== null && latestPasted('')) return ask(userText, 'document');
  if (userText !== null) await add({ role: 'user', text: userText });
  await note(NOTES.pasteJob);
  jobPanel();
}

/** One chat message (the server's LIMITS_INPUT.message): a full pasted job posting fits. */
const CHAT_MAX = 15_000;

const RESUME_RE = /\b(cv|r[eé]s?u?m[eé]?s?)\b/i;
const LEAD_RE = /^(?:(?:hi|hey|ok(?:ay)?|great|thanks|now|please|so|also|and|then)[,!. ]+|can you |could you |would you |help(?: me)?(?: to)? |i (?:want|need|would like) (?:you )?to )*/;
const JOBS_RE = /\b(jobs?|roles?|openings?|positions?|vacanc(?:y|ies)|opportunit(?:y|ies))\b/;

/** Clear, common requests map to a tool without any model call. Anything else goes to Ami (who can still pick a tool). */
function intentOf(text: string): 'saved' | 'applied' | 'jobs' | 'both' | 'tailor' | 'letter' | 'improve' | null {
  const t = text.trim().toLowerCase();
  // "show my saved jobs", "get ,y saved jobs": the saved cards, straight from this device.
  if (/\b(saved|bookmarked)\b/.test(t) && JOBS_RE.test(t) && !/\b(how|why|which|should)\b/.test(t)) return 'saved';
  // "show my applications", "jobs I applied to": the tracked cards.
  if ((/\bmy applications\b/.test(t) || (/\bi('ve| have)? applied\b/.test(t) && JOBS_RE.test(t))) && /^(show|list|get|see|view|where|what|which|my|can|could)\b/.test(t.replace(LEAD_RE, '')) && !/\b(how|why|should)\b/.test(t)) return 'applied';
  const polite = /^(can|could|would) you\b/.test(t);
  // "Find jobs for me", "show me roles", "any openings for me?": the jobs tool. Advice questions ("how do I find a job?") stay chat.
  const ask = t.replace(LEAD_RE, '');
  if (JOBS_RE.test(ask) && !/\b(how|why|what|when|where|should|tips?|advice|interview|cover letter|r[eé]sum[eé]|cv|seen|saw|saved?|viewed|opened|applied|past|previous|earlier|history|before|again|last)\b/.test(ask) && /^(find|show|search|get|look(?:ing)? for|any|got any|are there|give me|send me|fetch|list)\b/.test(ask)) return 'jobs';
  if (/\?\s*$/.test(t) && !polite) return null;
  const verb = t.replace(LEAD_RE, '');
  if (/^(tailor|customi[sz]e|adapt|target|align|write|draft|create|generate|make|do|prepare)\b/.test(verb) && RESUME_RE.test(verb) && /\bcover letter\b/.test(verb) && /\b(and|both|plus|with)\b|\+/.test(verb)) return 'both';
  if (/^(tailor|customi[sz]e|adapt|target|align)\b/.test(verb) && RESUME_RE.test(verb)) return 'tailor';
  if (/^(write|draft|create|generate|make|do|prepare)\b.*\bcover letter\b/.test(verb)) return 'letter';
  if (/^(improve|strengthen|polish|sharpen|fix|rewrite)\b/.test(verb) && RESUME_RE.test(verb)) return 'improve';
  return null;
}

/**
 * Cheapest route first. A clear request with nothing pasted runs its tool directly (no model call). Anything else (an
 * unclear request, a question, or a request with pasted text that must be read to know if it's a job description)
 * goes to Ami: one chat call, in which she answers or picks the right tool.
 */
async function send(text: string) {
  const q = text.trim();
  if (!q || busy) return;
  const [first, ...rest] = q.split('\n');
  const pasted = rest.join('\n').trim().length >= 200;
  const intent = intentOf(pasted ? first : q);
  if (intent && !pasted) {
    if (intent === 'saved' || intent === 'applied') return showJobs(intent, q);
    if (intent === 'jobs') return findJobs(false, { userText: q });
    if (intent === 'improve') return startTailor({ mode: 'improve' }, q);
    return forThisJob(intent, q);
  }
  // A document was asked for (now, with the posting pasted; or earlier and still not made, and this isn't a question):
  // Ami must start it. Otherwise she answers or picks a tool herself.
  const asked = (intent === 'tailor' || intent === 'letter' || intent === 'both') && pasted;
  return ask(q, asked || (documentPending() && !/\?\s*$/.test(q)) ? 'document' : undefined);
}

/** A résumé or letter was asked for in this chat and nothing has been made since (no analysis, résumé or letter). */
function documentPending(): boolean {
  for (const m of [...messages].reverse().slice(0, 12)) {
    if (m.kind === 'match' || m.kind === 'tailored' || m.kind === 'letter') return false;
    if (m.role !== 'user' || m.kind) continue;
    const intent = intentOf(m.text.split('\n')[0]);
    if (intent === 'tailor' || intent === 'letter' || intent === 'both') return true;
  }
  return false;
}

/** Suggestions that name one of the tools run that tool (with real DOCX/PDF downloads); anything else is a chat reply. */
async function runSuggestion(s: string) {
  const t = s.toLowerCase();
  if (/^find (me )?jobs/.test(t)) return findJobs();
  if (s === WIDEN.anywhere) return findJobs(false, { anywhere: true, userText: s });
  if (s === WIDEN.roles) return openProfileEditor();
  if (/make my r[ée]sum[ée] stronger|improve my r[ée]sum[ée]/.test(t)) return startTailor({ mode: 'improve' }, 'Make my résumé stronger.');
  if (/tailor (my r[ée]sum[ée] )?to (a|this|the) (job|role)/.test(t)) return forThisJob('tailor', s);
  if (/write a cover letter/.test(t)) return forThisJob('letter', s);
  return ask(s);
}

function suggestions(items: string[]) {
  msgsEl.querySelector('.cc-suggest')?.remove();
  if (!items.length) return;
  const row = el('li', 'cc-suggest');
  row.setAttribute('aria-label', 'Suggested replies');
  for (const s of items) row.append(button(s, 'cc-chip cc-chip--btn', () => runSuggestion(s)));
  msgsEl.append(row);
}

function renderMessages() {
  msgsEl.replaceChildren(...messages.map(messageNode));
  refreshEdit();
  const last = messages.at(-1);
  if (last?.role === 'coach' && last.suggest) suggestions(last.suggest);
  empty.hidden = messages.length > 0;
}

// ---------- persistence ----------
const saveState = () => vault.put('meta', 'state', state);
const saveConversation = (c: Conversation) => vault.put('conversations', c.id, c);

/** Opening a chat is queued: quick clicks never interleave (one switch can't undo the next one's draft). */
let opening: Promise<void> = Promise.resolve();
function open(id: string | null, opts: { restoreScroll?: boolean } = {}): Promise<void> {
  opening = opening.then(() => openNow(id, opts)).catch(() => {});
  return opening;
}

async function openNow(id: string | null, { restoreScroll = false } = {}) {
  const typed = input.value;
  await saveDraft(); // keep what was typed with the chat it was typed in
  state.current = id;
  messages = id ? (await vault.byConversation<Message>(id)).sort((a, b) => a.at - b.at) : [];
  welcome.hidden = true;
  renderMessages();
  renderChats();
  const c = current();
  // A saved position restores exactly; otherwise (or if it was at the end) land on the newest message.
  await showDoc(c?.docOpen === false ? null : (c?.docId ?? null));
  log.scrollTop = !messages.length ? 0 : restoreScroll && c?.scrollTop != null ? c.scrollTop : log.scrollHeight;
  const draft = c ? (c.draft ?? '') : ((await vault.get<{ text: string }>('meta', 'newDraft'))?.text ?? '');
  // Typing while the chat opened wins over the saved draft.
  if (input.value === typed) input.value = draft;
  draftFor = id;
  fit();
  await saveState();
}

/** Each chat keeps its own unsent text (a new chat without messages yet keeps one too). `draftFor`: the chat whose
 * draft is in the box (undefined until the first chat opens, so the empty box at start-up never overwrites a draft). */
let draftTimer = 0;
let draftFor: string | null | undefined;
async function saveDraft() {
  clearTimeout(draftTimer);
  if (draftFor === undefined) return;
  const text = input.value;
  const c = draftFor ? conversations.find((x) => x.id === draftFor) : null;
  if (c) {
    if ((c.draft ?? '') === text) return;
    c.draft = text;
    await saveConversation(c);
  } else await vault.put('meta', 'newDraft', { text });
}

async function add(part: Pick<Message, 'role' | 'text'> & Partial<Message>) {
  let c = current();
  if (!c) {
    const now = Date.now();
    const title = part.role === 'user' ? part.text : 'New chat';
    c = { id: uid(), title: title.length > 42 ? `${title.slice(0, 40).trimEnd()}…` : title, createdAt: now, updatedAt: now, scrollTop: null };
    conversations.unshift(c);
    state.current = c.id;
    if (draftFor === null) draftFor = c.id; // the new chat's box now belongs to the chat just created
    await saveState();
  }
  const m: Message = { id: uid(), conv: c.id, at: Date.now(), ...part };
  messages.push(m);
  c.updatedAt = m.at;
  c.scrollTop = null;
  conversations = [c, ...conversations.filter((x) => x.id !== c!.id)];
  await Promise.all([vault.put('messages', m.id, m, c.id), saveConversation(c)]);
  welcome.hidden = true;
  empty.hidden = true;
  msgsEl.querySelector('.cc-suggest')?.remove();
  msgsEl.append(messageNode(m));
  refreshEdit();
  renderChats();
  log.scrollTop = log.scrollHeight;
  if (m.kind === 'jobs' || m.kind === 'tailored' || m.kind === 'letter' || m.kind === 'guide') scheduleWeek();
  return m;
}

const note = (text: string) => add({ role: 'coach', text, kind: 'note' });

// ---------- chat ----------
const chatTurns = () => messages.filter((m) => !m.kind);
/**
 * The whole chat as Ami's context: what was said, in full, plus what the tools did as short notes (job cards shown, a
 * job analysed, a résumé tailored, a letter written), so she understands everything that happened in this chat.
 */
function transcript(): ChatTurn[] {
  const turns = messages
    .map((m): ChatTurn | null => {
      const coach = (content: string): ChatTurn => ({ role: 'assistant', content });
      if (!m.kind) return m.text.trim() ? { role: m.role === 'user' ? 'user' : 'assistant', content: m.text } : null;
      if (m.kind === 'note') return m.text.trim() ? coach(m.text) : null;
      if (m.kind === 'profile') return coach('(I read their résumé and built their profile.)');
      if (m.kind === 'jobs' && m.recalled) return coach(`(I showed their ${m.text.toLowerCase().includes('saved') ? 'saved' : 'recent'} jobs again as cards.)`);
      if (m.kind === 'jobs') return coach(`(I showed job cards: ${(m.jobs ?? []).map((j, i) => `${i + 1}. ${j.title}, ${j.company}, ${j.location}, fit ${j.fit}`).join('; ')}.)`);
      if (m.kind === 'match') {
        const a = m.analysis;
        const qa = (m.answers ?? []).map((x) => `${x.question} → ${x.answer}`).join('; ');
        return coach(`(I analysed ${m.task?.mode === 'improve' ? 'their résumé against their target role' : `the job${a?.role ? ` ${a.role}` : ''}${a?.company ? ` at ${a.company}` : ''}`}: ${(a?.match ?? []).map((x) => x.text).join('; ')}.${qa ? ` Their answers: ${qa}.` : ''})`);
      }
      if (m.kind === 'tailored') return coach(`(I built ${m.critique?.length ? 'a stronger résumé' : 'a tailored résumé'}${m.ats ? `, keyword match ${m.ats.before} → ${m.ats.after}` : ''}. Changes: ${(m.changes ?? []).map((c) => `${c.section}: ${c.why}`).join('; ') || 'none listed'}.${m.flags?.length ? ` Flagged to check: ${m.flags.map((f) => f.text).join(', ')}.` : ''})`);
      if (m.kind === 'guide') return coach(`(I made an interview prep guide${m.text ? `: ${m.text}` : ''}.)`);
      if (m.kind === 'letter') return coach(`(I wrote a cover letter${m.flags?.length ? `; flagged to check: ${m.flags.map((f) => f.text).join(', ')}` : ''}.)`);
      return null;
    })
    .filter((t): t is ChatTurn => !!t)
    .slice(-CONTEXT_TURNS)
    .map((t) => ({ ...t, content: t.content.slice(0, t.role === 'user' ? CHAT_MAX : 6000) }));
  // Nothing is trimmed: a posting pasted earlier must stay whole ("I'm eligible, go ahead"). Only a very long chat
  // drops its oldest turns (the rolling summary covers them); the prompt cache keeps resending history cheap.
  // The newest turn must be theirs: a note saved a moment after they sent this (a fast second message) waits its turn.
  const lastUser = turns.map((t) => t.role).lastIndexOf('user');
  turns.splice(lastUser + 1);
  let total = turns.reduce((n, t) => n + t.content.length, 0);
  while (total > 60_000 && turns.length > 1) total -= turns.shift()!.content.length;
  return turns;
}

// The newest message goes in full (Ami must read all of it); earlier turns are trimmed (a job they chose travels as <job>).
const asTurn = (m: Message, newest = false): ChatTurn => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text.slice(0, newest ? CHAT_MAX : 4000) });
const jsonBody = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

async function errorNote(res: Response, kind: 'messages' | 'uploads') {
  if (await isBreather(res)) return;
  const { error } = (await res.json().catch(() => ({}))) as { error?: string };
  if (error === 'limit') return note(kind === 'messages' ? NOTES.limitMessages : NOTES.limitUploads);
  if (error === 'devices') return note(NOTES.devices);
  if (error === 'unavailable' || res.status === 503) return note(NOTES.offline);
  if (error === 'too-short') return note(PARSE_NOTES.empty);
  return note(NOTES.error);
}

/** `want: 'document'`: a résumé or letter was clearly asked for, so Ami must start it rather than reply in chat. */
async function ask(text: string, want?: 'document') {
  const q = text.trim().slice(0, CHAT_MAX);
  if (!q || busy) return;
  setBusy(true);
  try {
    await add({ role: 'user', text: q });
    const c = current()!;
    setOrb('thinking');
    const live = el('li', 'cc-msg cc-msg--coach is-live');
    const content = el('div', 'cc-msg__text');
    const dots = el('span', 'cc-typing');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(el('span'), el('span'), el('span'));
    content.append(dots);
    const body = el('div', 'cc-msg__body');
    body.append(content);
    live.append(orb(), body);
    msgsEl.append(live);
    log.scrollTop = log.scrollHeight;

    const res = await deviceFetch(
      '/api/career/chat',
      jsonBody({
        task: 'chat',
        ...(want ? { want } : {}),
        messages: transcript(),
        profile: stored?.profile ?? null,
        jobs: shownJobs(),
        recent: await recentJobs().catch(() => []),
        saved: await savedJobsContext().catch(() => []),
        // The job this chat is about, so "the role above" means something. Long pasted descriptions are trimmed.
        job: c.job ? { ...c.job, description: c.job.description?.slice(0, 6000) } : undefined,
        summary: c.summary ?? '',
        day: localDay(),
        today: localDay(),
      }),
    ).catch(() => null);
    if (!res?.ok || !res.body) {
      live.remove();
      setOrb('error');
      await (res ? errorNote(res, 'messages') : note(NOTES.offline));
      return;
    }
    let answer = '';
    let suggest: string[] = [];
    let failed = false;
    let tool: ToolCall | null = null;
    for await (const { event, data } of readEvents(res)) {
      if (event === 'tool') tool = data as ToolCall;
      if (event === 'token') {
        if (!answer) setOrb('streaming');
        answer += (data as { t: string }).t;
        content.textContent = answer;
        if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight;
      } else if (event === 'suggest') suggest = (data as { items: string[] }).items;
      else if (event === 'error') failed = true;
    }
    live.remove();
    if (tool) {
      // Ami picked a tool: run its flow once this request is finished.
      if (answer.trim()) await add({ role: 'coach', text: answer.trim() });
      pendingTool = { tool, text: q };
      return;
    }
    if (!answer.trim()) {
      setOrb('error');
      await note(failed ? NOTES.error : NOTES.offline);
      return;
    }
    await add({ role: 'coach', text: answer.trim(), suggest });
    suggestions(suggest);
    announce(answer.trim());
    setOrb(failed ? 'error' : 'done');
    summarizeIfDue(c);
  } finally {
    setBusy(false);
    loadUsage();
    // Ami picked a tool: run its flow now that this request is done (it sets its own busy state).
    const next = pendingTool;
    pendingTool = null;
    if (next) await runTool(next.tool, next.text);
  }
}
let pendingTool: { tool: ToolCall; text: string } | null = null;

/** Every 10 turns beyond the 6 sent verbatim, fold the older ones into the conversation's rolling summary. */
async function summarizeIfDue(c: Conversation) {
  const turns = chatTurns();
  const upTo = c.summarizedUpTo ?? 0;
  const keep = turns.length - CONTEXT_TURNS;
  if (keep - upTo < SUMMARIZE_EVERY) return;
  const older = turns.slice(Math.max(upTo, keep - 24), keep).map((m) => asTurn(m));
  const res = await deviceFetch('/api/career/chat', jsonBody({ task: 'summarize', messages: older, profile: stored?.profile ?? null, summary: c.summary ?? '', day: localDay(), today: localDay() })).catch(() => null);
  if (!res?.ok) return;
  const { summary } = (await res.json()) as { summary: string };
  Object.assign(c, { summary, summarizedUpTo: keep });
  await saveConversation(c);
}

// ---------- upload ----------
function readingNode(fileName: string) {
  const li = el('li', 'cc-msg cc-msg--coach cc-reading');
  li.setAttribute('role', 'status');
  const paper = el('span', 'cc-paper');
  paper.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 5; i++) paper.append(el('span', 'cc-paper__line'));
  paper.append(el('span', 'cc-paper__scan'));
  const body = el('div', 'cc-msg__body');
  body.append(el('p', 'cc-msg__text', `Reading ${fileName}…`));
  li.append(orb(), paper, body);
  return li;
}

function pastePanel() {
  const li = el('li', 'cc-msg cc-msg--coach cc-paste');
  const f = el('form', 'cc-paste__form');
  const label = el('label', 'cc-field');
  const area = el('textarea', 'cc-field__input cc-paste__area');
  Object.assign(area, { maxLength: 20_000, rows: 8, name: 'resume' });
  label.append(el('span', 'cc-field__label', 'Your résumé text'), area);
  const go = el('button', 'btn btn--primary cc-btn-sm', 'Use this text');
  go.type = 'submit';
  f.append(label, go);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (area.value.trim().length < 150) return area.focus();
    li.remove();
    await profileFrom(area.value, 'Pasted résumé');
  });
  li.append(orb(), f);
  msgsEl.append(li);
  area.focus();
}

async function profileFrom(text: string, fileName: string) {
  setOrb('reading');
  const reading = readingNode(fileName);
  msgsEl.append(reading);
  log.scrollTop = log.scrollHeight;
  try {
    // Contact details stay on the device: the coach doesn't need them.
    const res = await deviceFetch('/api/career/profile', jsonBody({ text: withoutContacts(text).slice(0, 20_000), day: localDay(), today: localDay() })).catch(() => null);
    reading.remove();
    if (!res?.ok) {
      setOrb('error');
      return res ? errorNote(res, 'uploads') : note(NOTES.offline);
    }
    const { profile } = (await res.json()) as { profile: Profile };
    await saveProfile({ profile, fileName, resumeText: text, confirmed: false, updatedAt: Date.now() });
    persistStorage();
    await add({ role: 'coach', text: '', kind: 'profile' });
    const next = ['Find jobs for me', 'How can I make my résumé stronger?'];
    await add({ role: 'coach', text: NOTES.profileReady, kind: 'note', suggest: next });
    suggestions(next);
    setOrb('done');
  } finally {
    loadUsage();
  }
}

async function upload(file: File) {
  if (busy) return;
  setBusy(true);
  try {
    await add({ role: 'user', text: `Uploaded ${file.name}` });
    setOrb('reading');
    const reading = readingNode(file.name);
    msgsEl.append(reading);
    log.scrollTop = log.scrollHeight;
    let text: string;
    try {
      text = await readResume(file);
    } catch (err) {
      reading.remove();
      setOrb('error');
      const code = err instanceof ParseError ? err.code : 'broken';
      await note(PARSE_NOTES[code]);
      if (code !== 'type' && code !== 'size') pastePanel();
      return;
    }
    reading.remove();
    await profileFrom(text, file.name);
  } finally {
    setBusy(false);
  }
}

// Remember where the visitor was reading (null = at the end), so a reload lands on the same line.
let scrollTimer = 0;
log.addEventListener(
  'scroll',
  () => {
    clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      const c = current();
      if (!c) return;
      const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
      c.scrollTop = atEnd ? null : Math.round(log.scrollTop);
      saveConversation(c);
    }, 200);
  },
  { passive: true },
);

// ---------- usage ----------
async function loadUsage() {
  const usageNote = $<HTMLElement>('[data-usage-note]');
  try {
    const res = await deviceFetch(`/api/career/usage?day=${localDay()}`);
    // No device allowed on this network today (e.g. site data cleared): everything is used up.
    const refused = res.status === 429 && ((await res.clone().json().catch(() => ({}))) as { error?: string }).error === 'devices';
    if (!res.ok && !refused) throw new Error(String(res.status));
    const u: Usage = refused ? { day: localDay(), limits: DAILY_LIMITS, used: { ...DAILY_LIMITS }, breather: false } : await res.json();
    usage = u;
    setBreather(!!u.breather);
    for (const row of document.querySelectorAll<HTMLElement>('[data-usage]')) {
      const kind = row.dataset.usage as UsageKind;
      const left = Math.max(0, u.limits[kind] - u.used[kind]);
      $<HTMLElement>('[data-left]', row).textContent = `${left} of ${u.limits[kind]} left`;
      $<HTMLElement>('[data-fill]', row).style.transform = `scaleX(${Math.min(1, u.used[kind] / u.limits[kind]).toFixed(3)})`;
    }
    usageNote.hidden = true;
    usageNote.closest('section')?.setAttribute('data-usage-ready', '');
    loaded(usageNote);
  } catch {
    for (const row of document.querySelectorAll<HTMLElement>('[data-usage]')) $<HTMLElement>('[data-left]', row).textContent = '—';
    usageNote.replaceChildren(el('small', undefined, "Couldn't check today's usage right now. Your chats still save on this device."));
    usageNote.hidden = false;
    loaded(usageNote);
  }
}

// ---------- phone menu panel (the rail, opened by the hamburger) ----------
const phone = matchMedia('(max-width: 760px)');
const menuBtn = $<HTMLButtonElement>('[data-rail-toggle]');
const behindPanel = [$<HTMLElement>('.cc-head'), $<HTMLElement>('.cc-main')];
function setSheet(openSheet: boolean, returnFocus = false) {
  rail.classList.toggle('is-open', openSheet);
  menuBtn.setAttribute('aria-expanded', String(openSheet));
  rail.inert = phone.matches && !openSheet;
  // While the panel is open on a phone, everything behind it is out of reach, as in a modal.
  for (const b of behindPanel) b.inert = phone.matches && openSheet;
  if (openSheet) railBody.querySelector<HTMLElement>('button, a')?.focus();
  else if (returnFocus) menuBtn.focus();
}
menuBtn.addEventListener('click', () => setSheet(true));
$<HTMLButtonElement>('[data-rail-close]').addEventListener('click', () => setSheet(false, true));
$<HTMLElement>('[data-rail-scrim]').addEventListener('click', () => setSheet(false, true));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && rail.classList.contains('is-open')) setSheet(false, true);
});
phone.addEventListener('change', () => setSheet(false));

// On phones the layout follows the visible area (visualViewport), so the composer sits just above the keyboard.
const vv = window.visualViewport;
if (vv) {
  const fitViewport = () => {
    const on = phone.matches && vv.scale < 1.01;
    cc.style.setProperty('--vv-h', on ? `${vv.height}px` : '');
    cc.style.setProperty('--vv-top', on ? `${vv.offsetTop}px` : '');
  };
  vv.addEventListener('resize', fitViewport);
  vv.addEventListener('scroll', fitViewport);
  phone.addEventListener('change', fitViewport);
  fitViewport();
}

// ---------- controls ----------
/** The composer grows with what you type (up to ~6 lines, then scrolls). */
const fit = () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
};
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // Still replying: the spinner on the send arrow says so, and the text stays in the box until she's done.
  if (busy || !input.value.trim()) return;
  await opening; // a chat that's still opening ("New chat" then a quick message) gets the message
  const q = input.value;
  input.value = '';
  fit();
  saveDraft(); // sent: nothing left to keep
  send(q);
});
// Enter sends; Shift+Enter (or an IME composing text) adds a new line.
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener('input', fit);
input.addEventListener('input', () => {
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(saveDraft, 400);
});
input.addEventListener('input', () => {
  if (!busy && ['idle', 'typing', 'done', 'error', undefined].includes(cc.dataset.orb)) setOrb(input.value ? 'typing' : 'idle');
});

chatsEl.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('[data-conv]');
  if (!b) return;
  open(b.dataset.conv!, { restoreScroll: true });
  if (phone.matches) setSheet(false);
});

$<HTMLButtonElement>('[data-new-chat]').addEventListener('click', () => {
  open(null);
  if (phone.matches) setSheet(false);
  input.focus();
});

const fileInputs = document.querySelectorAll<HTMLInputElement>('[data-file]');
/** The consent box must be ticked once before the first upload (career-mode.md §3.2). */
function consented() {
  if (consent.checked || stored) return true;
  if (!empty.hidden) needConsent();
  else open(null).then(needConsent);
  announce('Tick "Stays on your device" first, then choose your résumé.');
  return false;
}
/** Points at the box: a peach ring and a small shake (restarted on every attempt), focus on the box. */
function needConsent() {
  const label = consent.closest('label')!;
  label.classList.remove('is-needed');
  void label.offsetWidth;
  label.classList.add('is-needed');
  consent.focus({ preventScroll: true });
  label.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function pickFile() {
  if (phone.matches) setSheet(false);
  if (consented()) fileInputs[fileInputs.length - 1].click();
}
consent.addEventListener('change', () => {
  consent.closest('label')?.classList.remove('is-needed');
});

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-start]')) {
  b.addEventListener('click', async () => {
    if (phone.matches) setSheet(false);
    const start = b.dataset.start!;
    if (start === 'upload') return pickFile();
    if (start === 'jobs') return findJobs();
    if (start === 'tailor') {
      if (!stored) return needProfile('Tailor my résumé to a job');
      await add({ role: 'user', text: 'Tailor my résumé to a job' });
      await note(NOTES.pasteJob);
      return jobPanel();
    }
    startTailor({ mode: 'improve' }, 'Make my résumé stronger.');
  });
}
$<HTMLButtonElement>('[data-attach]').addEventListener('click', pickFile);
for (const f of fileInputs) {
  f.addEventListener('click', (e) => {
    if (!consented()) e.preventDefault();
  });
  f.addEventListener('change', () => {
    const file = f.files?.[0];
    f.value = '';
    if (file) upload(file);
  });
}

// Drag and drop onto the dashed zone.
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('is-over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('is-over');
  const file = e.dataTransfer?.files[0];
  if (file && consented()) upload(file);
});

const confirmBox = $<HTMLElement>('[data-delete-confirm]');
$<HTMLButtonElement>('[data-delete]').addEventListener('click', () => {
  confirmBox.hidden = false;
  $<HTMLButtonElement>('[data-delete-no]').focus();
});
$<HTMLButtonElement>('[data-delete-no]').addEventListener('click', () => {
  confirmBox.hidden = true;
  $<HTMLButtonElement>('[data-delete]').focus();
});
$<HTMLButtonElement>('[data-delete-yes]').addEventListener('click', async () => {
  await clearData();
  location.reload();
});

// ---------- start ----------
(async () => {
  if (phone.matches) input.placeholder = 'Message Ami';
  setOrb('idle');
  setSheet(false);
  // DOMPurify is ready before any saved model output is shown again.
  [vault] = await Promise.all([openVault(), loadPurifier()]);
  state = (await vault.get<State>('meta', 'state')) ?? { current: null };
  stored = (await vault.get<StoredProfile>('profile', 'current')) ?? null;
  saved = new Set((await vault.list<RankedJob>('savedJobs')).map((j) => j.id));
  tracker = (await vault.get<Record<string, Track>>('meta', 'tracker')) ?? {};
  goal = (await vault.get<Goal>('meta', 'goal')) ?? null;
  renderResumeCard();
  conversations = (await vault.list<Conversation>('conversations')).sort((a, b) => b.updatedAt - a.updatedAt);
  if (state.current && !current()) state.current = null;
  await open(state.current, { restoreScroll: true });
  // A due follow-up is the greeting: the "welcome back" toast would sit on top of it.
  await renderNudge().catch(() => {});
  if (messages.length && nudgeBox.hidden) {
    welcome.hidden = false;
    announce('Welcome back. Picking up where you left off.');
    // It floats over the log, so it steps away as soon as the visitor reads on (or after a few seconds).
    const dismiss = () => (welcome.hidden = true);
    for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) log.addEventListener(type, dismiss, { once: true, passive: true });
    setTimeout(dismiss, 8000);
  }
  loadUsage();
  renderWeek();
})();
