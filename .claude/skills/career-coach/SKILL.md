---
name: career-coach
description: Use for anything in the Career Coach mode — /career route, résumé upload/parsing, device-bound encrypted persistence, signed API requests, job search + ranking, résumé tailoring, DOCX/PDF export, limits and security.
---

# Career Coach

The spec is `career-mode.md`; the model instructions are in `ai/career-system-prompt.md`. Read both before any work. These are the checks that matter most.

## Non-negotiables
1. **Local-first:** conversations, résumé, profile and documents live only in IndexedDB, encrypted with a **non-extractable** AES-GCM key (`src/lib/vault.ts`). The server stores no content, only counters and served-job ids.
2. **Device-bound requests:** every `/api/career/*` call is signed with a non-extractable ECDSA P-256 key (`src/lib/device.ts`). The server verifies the signature, a timestamp within ±60s and a single-use nonce. No bearer tokens or session cookies.
3. **Never fabricate** in tailored résumés or letters. Enforce it in the prompt **and** in code: after generation, diff entities and numbers in the output against the source résumé + user answers, and flag anything new for the user instead of silently shipping it.
4. **5 job cards per device per day**; tiers: posted ≤ 60 min (ATS) → today's most recent → this week (only when short of 5, where Remotive appears). Honest labels from the real timestamp kind: "posted" / "published" / "updated N ago". Never repeat a job; never pad with poor fits (fit < 55).
5. **Free job sources only**, behind adapters in `src/lib/jobs/`: Greenhouse, Lever, Ashby (from `src/content/companies.json`), Himalayas, Remotive, Jobicy. No paid job APIs. An hourly **GitHub Actions** ingest writes the last 48 h to **Upstash Redis**; `/api/career/jobs` only reads Redis (no live fan-out). Respect each source's polling limit (Himalayas daily, Remotive ≤ 4/day, Jobicy ≤ hourly).
6. **Follow each source's terms** (`career-mode.md` §3.3b): visible "via X" attribution with a link, the source-required apply link (Himalayas `applicationLink` unchanged, Remotive and Jobicy job pages), no republishing or JobPosting structured data, expired jobs removed, never use listings to collect emails.
7. **Cost:** the only bill is AI. Every task uses the Haiku-class model (`claude-haiku-5-5`, no temperature). Global kill switch `CAREER_DAILY_BUDGET_USD` (default 1) counted from real token usage. Per device per day: 10 messages, 2 tailored résumés, 1 cover letter, 5 jobs (plus per-IP caps).
8. **No auto-applying.** "Open job" opens the employer/listing page in a new tab.
9. **Isolation from the portfolio:** `/career` is rendered on demand (per-request CSP nonce) while `/` stays prerendered; `/career` doesn't load the portfolio's `src/islands/main.ts`, and nothing from `/career` loads on `/`. The approved libraries (`pdfjs-dist`, `mammoth`, `docx`, `pdf-lib`, `dompurify`) load only on `/career`, via dynamic `import()` when used. The "Ask Harnie | Career Coach" switch is static hero HTML.
10. **Lock down XSS:** strict CSP with per-request nonces, Trusted Types, DOMPurify on all model output. **Turnstile is the only third party** on `/career`: `https://challenges.cloudflare.com` in `script-src` and `frame-src`, nothing else.

## Build order
C1 vault + device + persistence → C2 upload/profile/chat → C3 jobs → C4 tailor/improve/letter + export → C5 limits, security, privacy page, evals (see `career-mode.md` §10). Stop after each for review.

## Verify each milestone
- Reload the page: the conversation, scroll position and profile restore exactly.
- DevTools → Application → IndexedDB: values are ciphertext, not readable text.
- Copy the request headers into curl and replay: rejected. Change one byte of the body: rejected.
- Network tab on `/`: no Career Coach chunks. Network tab on `/career`: no portfolio entry script.
- Job cards: every one shows its source link and an honest time label; the ingest log stays within each source's polling limit.
- Run `tests/career.eval.ts` and `tests/career.security.spec.ts`, then the `qa-responsive` and `perf-guard` skills on `/career`.
