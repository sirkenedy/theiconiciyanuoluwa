---
name: ai-twin
description: Use for anything about the AI twin chat — UI states, docking, /api/twin, streaming, the résumé data pipeline, guardrails and evals.
---

# AI twin

The spec is `prompt.md` §7. These are the steps and checks.

## Data pipeline
1. `src/lib/resume-parse.ts` parses `ai/resume.template.md` → `src/content/resume.json` at build time.
2. Validate it: required `identity` fields; every experience/project/post has a unique `id`; fail the build on errors.
3. The same JSON feeds Journey, Writing, `/resume` and the FAQ chips.
4. Also write `src/content/resume.twin.json`: identity name, nickname, email, linkedin and instagram become `{{NAME}}`, `{{NICKNAME}}`, `{{EMAIL}}`, `{{LINKEDIN}}`, `{{INSTAGRAM}}`, and any other occurrence of a name part (case-insensitive) becomes `{{NAME}}`. Fail the build if a name part survives. Only this file feeds the system prompt.

## Server: `src/pages/api/twin.ts` (edge)
- System prompt = `ai/twin-system-prompt.md` with `{{RESUME_JSON}}` filled from `resume.twin.json`, sent as a **cached** block. The server never imports `resume.json`.
- Model: the fastest current Claude Haiku-class model, `max_tokens` 350, temperature 0.4, streamed.
- Send SSE events `token`, `meta`, `done` and `error` (the contract is in §7.6).
- Never send the `<meta>…</meta>` text as tokens: buffer once `<meta>` starts, parse it, validate `cite` ids against `resume.json` and whitelist `action`.
- Limits: input ≤ 500 chars, last 6 turns, 20 messages/IP/hour (KV), 15s timeout. Strip HTML from input.
- Don't store transcripts unless explicitly enabled.

## Client: `src/islands/ChatTwin.tsx`
- The inline hero card is plain HTML first; the FAQ chips answer instantly from build-time data, with no API call.
- Hydrate on `requestIdleCallback`, or on focus/tap of the input, whichever comes first.
- One shared store (plus `sessionStorage`) for the inline card and the docked orb panel. FLIP/View Transition the orb from the hero to the dock.
- Orb states: idle, typing, thinking, streaming, answered, unknown, error (§7.2).
- Name privacy: replace name parts in visitor input with `{{NAME}}` before sending; store history tokenised; expand placeholders only at render, buffering a partial `{{…` across stream chunks.
- Batch streamed tokens into one DOM write per frame; use `aria-live="polite"` and announce the final answer.
- Citations → scroll to the Journey/Writing card and pulse it. Actions: `download_resume`, `email`, `scroll:*`.

## Evals: `tests/twin.eval.ts`
At least 20 cases: cited facts, unknown facts, boundary topics (salary), prompt injection, off-topic, ≤ 80 words, valid meta JSON. Need ≥ 95% pass before shipping. Run with `npm run test:twin`.

## Never
Send any part of the owner's name or contact details to the Claude API, put the API key in the client, answer facts that aren't in `resume.json`, or block page scrolling while the chat is open on desktop.
