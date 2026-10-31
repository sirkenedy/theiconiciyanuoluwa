# Build brief 2: Career Coach mode (résumé → jobs → tailored résumé)

> **For the AI coding agent.** Read `prompt.md` first (it still governs design, performance and accessibility), then this file.
> Build this **after** the portfolio milestones in `prompt.md` §12 are done and QA'd.

---

## 1. What it is
A second mode of the site's AI. **Harnie** (the AI twin) answers questions about the portfolio owner. **Career Coach** helps *visitors* with their own careers:

1. **Upload a résumé** (PDF or DOCX). The coach reads it and builds a profile the visitor can confirm and edit.
2. **Find jobs:** up to **5 roles per device per day**, the most recently posted (ideally **within the last hour**), ranked by fit to the résumé. Each opens the real job page in a new tab. The visitor applies themselves.
3. **Tailor a résumé** to a job (from a found job, or a pasted job description), written as an expert résumé writer would, and **downloaded** as DOCX and PDF.
4. **Improve a résumé** in general (no target job), plus **cover letters**.
5. **Continue later:** conversations, the résumé and generated documents persist **on the visitor's device**, bound to that device, and cannot be hijacked by someone who steals a link, cookie or ID.

Free for visitors, rate-limited per device (§7). **Cost rule:** everything runs on free services (free job sources, Upstash Redis free tier, GitHub Actions, Cloudflare Turnstile); the only bill is AI usage, capped at `CAREER_DAILY_BUDGET_USD` (default **$1/day**).

**Out of scope (by decision):** auto-submitting applications on job sites. The coach finds, explains and prepares; the human applies.

---

## 2. Where it lives (protect the portfolio's speed)
- Its own route **`/career`**, **rendered on demand** (`export const prerender = false`) so each response carries a fresh CSP nonce (§4.4). `/` and every portfolio page stay **prerendered**.
- **Separate scripts:** `/career` does not load the portfolio's entry script (`src/islands/main.ts`: hero, Journey, reactions, chat). It loads only its own entry plus the shared theme toggle. Nothing from Career Coach loads on `/`.
- **Entry points:** a mode switch in the twin chat header, "Ask Harnie | Career Coach" (a clay segmented control), plus a CTA card in the Contact section: "Job hunting? Let my AI coach help." The switch is part of the **static hero HTML** (two real links, `/` and `/career`), never injected by script, so it can't shift the hero. Switching modes navigates to `/career` with a cross-document View Transition (the orb flies across), keeping the clay feel.
- **Budgets for `/career`:** initial JS ≤ 60 KB gz. The approved heavy libraries load **only on `/career` and only when used** (dynamic `import()`), each ≤ 150 KB gz: `pdfjs-dist` and `mammoth` (parsing), `docx` and `pdf-lib` (export), `dompurify` (rendering model output). LCP ≤ 2.0 s. Same tokens, both themes, same motion language.
- Never runs on a phone in a way that breaks the layout: run the `qa-responsive` skill on `/career` too.

---

## 3. The experience

### 3.1 Layout
- **Desktop:** a left rail (conversations list + "New chat", the résumé card, today's usage) and a main chat column. **Mobile:** a single chat column; the rail becomes a bottom sheet.
- **Empty state:** the clay orb plus 4 starter cards: *Upload my résumé* · *Find jobs for me* · *Tailor my résumé to a job* · *Make my résumé stronger*.
- Same orb states as the twin (idle, typing, thinking, streaming, done, error), plus **reading** (the orb "scans" a paper card while the résumé is parsed) and **searching** (the orb orbits small job cards).

### 3.2 Upload and profile
1. Drag-and-drop or pick a file: PDF or DOCX, ≤ 5 MB, one at a time. Before the first upload, a consent line with a checkbox: "Your résumé stays on this device. It's sent to the AI only to answer your requests and isn't stored on our servers."
2. Parse **in the browser**: `pdfjs-dist` for PDF, `mammoth` for DOCX (both lazy-loaded). Scanned/image-only PDF → tell the user plainly and offer to paste the text instead.
3. Send the text to `/api/career/profile`, which returns a structured **profile JSON** (same shape as `ai/resume.template.md`: identity, experience with highlights, skills, education, target roles, seniority, location, remote preference, years of experience).
4. Show it as an editable **profile card**. The user confirms or corrects it (target titles, location, remote/hybrid/on-site, salary range optional). Everything downstream uses the confirmed profile.

### 3.3 Find jobs (5 per day)
**Rules:** max **5 job cards per device per calendar day** (the device's local midnight). Never show a job twice to the same device. Never pad with poor fits (fit < 55).

**Freshness tiers, in order** (fill the 5 cards from the first tier that has matches, then the next):
1. **Posted ≤ 60 minutes ago:** only the ATS sources can give a real posting time (Greenhouse `first_published`, Lever `createdAt` if present, Ashby `publishedAt`).
2. **Today's most recent** from any source.
3. **This week:** only when tiers 1–2 give fewer than 5 good matches. This is where Remotive appears (its listings are delayed 24 h by design).

**Honest labels, from the timestamp kind each source really provides:** "posted 12 min ago" (true posting time) · "published 3 h ago" (Ashby: last published) · "updated 9 h ago" (Greenhouse list `updated_at`, Himalayas `pubDate`, anything without a posting time). Never call an update time "posted".

**Sources (free, no paid APIs), behind one adapter interface in `src/lib/jobs/`:**
| Source | Endpoint | Key | Time field → label | Ingest cadence |
|---|---|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | none | list `updated_at` → "updated"; for **new** ids only, the single-job call's `first_published` → "posted" | every run (hourly) |
| Lever | `api.lever.co/v0/postings/{site}?mode=json` (EU: `api.eu.lever.co`) | none | `createdAt` → "posted" (undocumented: verify on live boards; if absent, "updated") | hourly |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true` | none | `publishedAt` → "published"; skip `isListed: false` | hourly |
| Himalayas | `himalayas.app/jobs/api` (+ `/search`) | optional `HIMALAYAS_API_KEY` | `pubDate` (= last updated) → "updated"; drop at `expiryDate` | **once a day** (data refreshes daily) |
| Remotive | `remotive.com/api/remote-jobs` | none | `publication_date` → "posted" (≥ 24 h old by design) | **every 6 h (≤ 4/day)** |
| Jobicy | `jobicy.com/api/jobs` | none | publish date → "posted" | hourly (**never more than once an hour**) |

**Company list:** `src/content/companies.json` = `[{company, ats: "greenhouse"|"lever"|"ashby", token, regions, active}]`, ~50 companies hiring product/design/engineering, including Nigerian and remote-first startups. `scripts/check-boards.ts` tries every token and sets `active: false` on any that returns 404 (many Nigerian companies use ATSs without a free API; those simply aren't listed). Verify each provider's current docs when implementing.

### 3.3a Ingest (no live fan-out)
- A **GitHub Actions** workflow (`.github/workflows/ingest-jobs.yml`, hourly cron + manual run) runs `scripts/ingest-jobs.ts`: fetch each due source, normalise to one `Job` type, dedupe (company + title + location), and store the last **48 h** in **Upstash Redis** (free tier). Scheduled runs can be delayed under load; the UI never promises a minute-exact refresh.
- `Job = {id, title, company, location, remote, time: {kind: "posted"|"published"|"updated", at}, applyUrl, sourceUrl, attribution: {source, label}, salary?, descriptionSnippet}`; the full description is stored separately with a 48 h TTL.
- **Expired jobs are removed:** each run rebuilds a source's index from its latest fetch, so jobs that disappear drop out; Himalayas jobs also go at `expiryDate` (or on a 410 from its single-job check); nothing older than 48 h is kept.
- **Redis budget** (free tier = 500k commands/month, 256 MB): one compact index per source per run, one write per **new** job, nothing per unchanged job. Target ≲ 200k commands/month for the whole site; `/api/career/usage` exposes the month's count to the owner.
- `POST /api/career/jobs` **only reads Redis**: filter by the confirmed profile (titles, location/remote), take up to 25 candidates by freshness tier, rank with **one** batched model call (`{jobId, fit: 0–100, why: [2 bullets], gaps: [≤2 bullets]}`), keep the top 5 with fit ≥ 55, record served ids per device (30 days). If none qualify, say so and suggest widening titles or location.

### 3.3b Source terms (follow them exactly)
| Source | What we must do |
|---|---|
| **Himalayas** | Apply button uses `applicationLink` **unchanged**; show a visible link to the job on Himalayas ("via Himalayas"); show jobs only on this site, never pass them to other boards/aggregators/Google Jobs/LinkedIn, **no JobPosting structured data** for them; remove expired jobs; call from the server only. |
| **Remotive** | Link back to the **Remotive job URL** and name Remotive as the source ("via Remotive"); never resubmit jobs to other boards; **never use listings to collect sign-ups or emails**; ≤ 4 calls a day. |
| **Jobicy** | Credit Jobicy ("via Jobicy"); **Apply goes to the Jobicy job page**; never present listings as our own; ≤ one automated pass per hour; cache. |
| **Greenhouse / Lever / Ashby** | No published API terms; their boards are public. One request per board per run, identify the client (`User-Agent`), back off on 429; apply links go to the company's own hosted page ("via Greenhouse" etc.). |
| **All** | No JobPosting structured data for any third-party job on our pages; never republish job data outside `/career`. |

**Job card:** title · company · location/remote · honest time label · fit score as a clay meter · why it fits · gaps · **source attribution link**. Buttons: **Open job** (the source-required URL, new tab, `rel="noopener noreferrer"`) · **Tailor my résumé** · **Cover letter** · **Save**. Footer: "Jobs left today: 3 of 5".

### 3.4 Tailor a résumé to a job
- **Input:** a found job (its full description comes from Redis, stored at ingest), or the user **pastes** a job description. Don't fetch arbitrary URLs server-side: many job sites block it, and it opens SSRF risk. If a URL is pasted, ask for the text.
- **Output (`POST /api/career/tailor`, streamed):**
  1. A **match analysis:** required vs. present skills, missing keywords, seniority fit.
  2. **Questions first** when gaps could be filled truthfully ("Did you lead the migration, or support it?" "Do you have a number for the cost saving?"). Max 3, skippable.
  3. The **tailored résumé** as structured JSON (`TailoredResume`: summary, skills ordered by relevance, experience bullets rewritten in an action–impact–metric style, keywords woven in naturally), and a **change log** (what changed and why, per section).
  4. An **ATS keyword coverage** score before → after.
- **Honesty rules (hard):** never invent employers, titles, dates, degrees, certifications, tools or metrics. Rephrase, reorder, emphasise, and quantify **only** with numbers the user gave. Missing requirements go in "gaps to address", not into the résumé.
- **Preview** as a clean A4/Letter page with a before/after diff toggle. The user can edit any line inline before downloading.
- **Download** (generated in the browser, lazy-loaded): **DOCX** via the `docx` package and **PDF** via a print stylesheet or `pdf-lib`, using one ATS-safe template: single column, real text (no text in images), standard headings, system-safe font. File name: `firstname-lastname-resume-company-role.docx`.

### 3.5 Improve my résumé / cover letter
- **Improve:** the same pipeline without a job description, judged against the user's stated target role. Also returns a 5-point critique (clarity, impact, keywords, structure, length).
- **Cover letter:** ≤ 300 words, specific to the job, in the user's voice; download as DOCX/PDF.

---

## 4. Persistence that stays on the device and can't be hijacked

### 4.1 Principle: local-first, server-stateless
- **All content** (conversations, the résumé text, profile, tailored versions, saved jobs) is stored **only in the visitor's browser**, in **IndexedDB**, **encrypted**.
- The server **never stores** résumés or chat content. It processes a request and forgets it. It stores only counters and served-job ids per device.
- So there's no server copy to steal, and nothing another person can load by guessing or stealing an ID.

### 4.2 Device-bound encryption (`src/lib/vault.ts`)
1. On first visit to `/career`, generate an **AES-GCM 256** key with WebCrypto `generateKey(..., extractable: false, ...)` and store the `CryptoKey` object in IndexedDB. A non-extractable key can be *used* by this site in this browser but **can't be exported** by any script (including ours).
2. Every record is encrypted before writing: `{iv (12 random bytes), ciphertext}`. Records: `conversations`, `messages`, `profile`, `documents`, `savedJobs`, `meta`.
3. Call `navigator.storage.persist()` after the first upload, so the browser doesn't evict data under storage pressure. Show the status in settings.
4. **Retention:** data older than 90 days is auto-deleted; a visible **"Delete everything on this device"** button wipes the IndexedDB stores and the keys immediately.

### 4.3 Device identity for the API (`src/lib/device.ts`)
Needed so rate limits and the "5 jobs/day, never repeated" rule can't be bypassed or hijacked:
1. Generate an **ECDSA P-256** key pair with `extractable: false`; store it in IndexedDB.
2. **Register:** `POST /api/device/register` with the public key (JWK). The server returns `deviceId = base64url(SHA-256(publicKey))`. No cookies or tokens that could be stolen and replayed.
3. **Every API request is signed:** headers `X-Device-Id`, `X-Timestamp`, `X-Nonce`, and `X-Signature` = ECDSA over `method + path + timestamp + nonce + SHA-256(body)`.
4. **Server verification:** look up the public key by deviceId, verify the signature, reject timestamps more than 60s off, and reject reused nonces (Redis `SET NX` with a 5-minute TTL). A copied deviceId, header set or request is useless without the private key, which never leaves the browser.
5. Rate-limit by deviceId **and** IP, so clearing storage to mint new devices still hits the IP limit.
6. Optional later: **passkeys** (WebAuthn) for users who want to move their history to a new device, plus an **encrypted export/import file** protected by a passphrase (PBKDF2/Argon2 → AES-GCM). Until then, "Export my data" downloads that file.

### 4.4 The real attack surface is XSS, so lock it down
- A strict **Content-Security-Policy** on `/career`, generated **per request** with a fresh nonce (the page is rendered on demand):
  `default-src 'self'; script-src 'self' 'nonce-{n}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; img-src 'self' data:; style-src 'self' 'nonce-{n}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'`.
- **Cloudflare Turnstile is the ONE allowed third party** on `/career`, and only through the two entries above (`challenges.cloudflare.com` in `script-src` and `frame-src`). No other third-party scripts, no analytics.
- **Trusted Types** enforced. Model output is rendered from markdown via **DOMPurify** with a tight allow-list; links get `rel="noopener noreferrer nofollow"`.
- `Referrer-Policy: no-referrer`, `Permissions-Policy` denying camera, mic and geolocation.
- Uploaded files are never executed or rendered as HTML; parse to text only.

### 4.5 Resuming a conversation
- On load: open the vault, decrypt the conversation list, and restore the last open conversation **with scroll position**, the confirmed profile and today's job cards. A clay toast: "Welcome back — picking up where you left off."
- The model has no memory between requests. The client sends a **compact context** each turn: the confirmed profile (JSON), the current job description if any, a rolling **summary** of older turns (created by the model every 10 turns and stored encrypted), and the last 6 messages. This keeps cost low and conversations unlimited in length.
- Multiple conversations with auto-titles ("Tailoring for Paystack PM role"); rename, delete, search (client-side).

---

## 5. API surface (serverless functions on the Vercel adapter, all signed per §4.3)
Every model task uses the **Haiku-class model (`claude-haiku-5-5`)**, including tailoring and cover letters: it is the cheapest current model and keeps the bill under the daily cap. No sampling parameters (Haiku 5.5 rejects non-default temperature).

| Endpoint | Purpose |
|---|---|
| `POST /api/device/register` | Register a public key → deviceId (Turnstile token required) |
| `POST /api/career/profile` | Résumé text → profile JSON |
| `POST /api/career/chat` | General coaching chat, streamed |
| `POST /api/career/jobs` | Read Redis + rank → up to 5 jobs |
| `POST /api/career/tailor` | Analysis + tailored résumé JSON + change log, streamed |
| `POST /api/career/cover-letter` | Cover letter, streamed |
| `GET  /api/career/usage` | Today's remaining quotas |

System prompt: `ai/career-system-prompt.md`. Use prompt caching for the static instructions. Validate every structured output with **zod** (via `astro/zod`); on failure, retry once with the validation error, then show a friendly error.

---

## 6. Data shapes (TypeScript, in `src/lib/career/types.ts`)
`Profile`, `Job`, `RankedJob`, `TailoredResume`, `ChangeLogEntry`, `Conversation`, `Message`, `Usage`. Use the résumé template's section names for `Profile` and `TailoredResume`, so the portfolio and Career Coach share one résumé model.

---

## 7. Limits and cost control (free, rate-limited)
| Limit | Per device per day | Also per IP per day |
|---|---|---|
| Chat messages | **10** | 40 |
| Résumé uploads / profile builds | 3 | 10 |
| Tailored résumés / improvements | **2** | 6 |
| Cover letters | **1** | 3 |
| Job cards | **5** (never repeated) | 20 |

- A global **daily spend kill switch**: `CAREER_DAILY_BUDGET_USD` (**default 1**). Spend is counted from each response's real token usage (input, cache reads/writes, output) at Haiku rates and summed in Redis per UTC day. When reached, Career Coach shows a friendly "Taking a breather until tomorrow" state; the portfolio (and Harnie) are unaffected.
- Input caps: résumé text ≤ 20k characters; job description ≤ 15k; message ≤ 2k.
- Turnstile (Cloudflare, invisible, free) on device registration to stop bot farms.
- Show usage in the UI at all times ("1 of 2 tailored résumés left today").

---

## 8. Privacy and trust copy (must appear)
- Under the upload: "Stays on your device · Sent to AI only to answer you · Not stored on our servers · Delete anytime."
- A `/career/privacy` page explaining the above in plain words, which AI provider (Anthropic, Haiku-class model) and job sources (Greenhouse, Lever, Ashby, Himalayas, Remotive, Jobicy) are used, the limits, and how to delete data.
- AI disclaimer: "AI suggestions can be wrong. Review everything before you send it."
- Every job card names its source with a link ("via Himalayas", "via Remotive", "via Jobicy", "via Greenhouse"…); the privacy page lists the job sources and their terms.

---

## 9. Quality bar: evals (`tests/career.eval.ts`, ≥ 25 cases)
- **Never fabricates:** a tailored résumé contains no employer, title, date, degree, tool or number absent from the source résumé or the user's answers (automated diff check on entities and numbers).
- Asks clarifying questions when key requirements are missing rather than inventing.
- Keyword coverage improves on ≥ 90% of test pairs.
- Job ranking: an obviously mismatched job (e.g. a nurse résumé vs. a backend engineer job) scores < 40.
- Prompt injection inside a résumé or job description ("ignore previous instructions…") is ignored.
- Output JSON validates 100% after at most one retry.

Security tests (`tests/career.security.spec.ts`): a replayed signed request is rejected; a request signed by another key is rejected; a request with a tampered body is rejected; clearing IndexedDB yields a new deviceId with fresh daily limits, while the IP limit still applies; CSP blocks an injected inline script.

---

## 10. Milestones
- **C1:** `/career` route rendered on demand with per-request CSP nonces, its own entry script (no portfolio script), layout, the static "Ask Harnie | Career Coach" switch, vault (`vault.ts`), device identity + signed requests, conversations persisted and restored.
- **C2:** Upload → parse in browser (lazy `pdfjs-dist`/`mammoth`) → profile card → coaching chat with compact context + rolling summary.
- **C3:** Jobs: adapters in `src/lib/jobs/`, `companies.json` + `check-boards.ts`, the hourly GitHub Actions ingest into Redis, freshness tiers, honest labels, attribution, 5/day, never repeated, ranking.
- **C4:** Tailor + improve + cover letter, diff preview, inline edit, DOCX (`docx`)/PDF (`pdf-lib`) download.
- **C5:** Limits, $1/day kill switch, Turnstile, CSP/Trusted Types/DOMPurify, privacy page, evals + security tests, `qa-responsive` on `/career`, perf-guard.
