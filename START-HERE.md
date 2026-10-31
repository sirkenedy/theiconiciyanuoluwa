# Start here: set up the project and drive the AI

## 1. One-time setup (≈ 10 min)
1. Install **Node.js 20+** (nodejs.org) and **Git**.
2. Unzip this package where you keep projects. Rename the folder if you like; it is your project root:
   ```
   theIconicIyanuoluwa/
   ├─ START-HERE.md        ← this file
   ├─ CLAUDE.md            ← project memory (auto-read by Claude Code)
   ├─ AGENTS.md            ← same rules for Cursor / Codex / other agents
   ├─ prompt.md            ← full build brief
   ├─ .claude/skills/      ← 6 project skills: soft-clay-ui, scroll-motion, ai-twin, perf-guard, qa-responsive, career-coach
   ├─ design/tokens.css
   ├─ ai/resume.template.md, twin-system-prompt.md
   └─ reference/portfolio-reference.html
   ```
   Note: `.claude` is a hidden folder. On macOS, press Cmd+Shift+. in Finder to see it.
3. Open a terminal in the folder and run:
   ```bash
   git init && git add -A && git commit -m "Brief, tokens, skills"
   ```
   Commit after every milestone so you can always roll back.
4. **Fill in `ai/resume.template.md`** with your real résumé. Do this before milestone 2 (or ask the AI to convert your résumé PDF into it; see prompt B).
5. Install your AI coding tool:
   - **Claude Code (recommended; it uses `.claude/skills` and `CLAUDE.md` automatically):** `npm install -g @anthropic-ai/claude-code`, then run `claude` inside the folder.
   - **Cursor:** open the folder. It reads `AGENTS.md`; mention the skill files with `@` when relevant.
6. Get an Anthropic API key (console.anthropic.com) for the chat. Put it in `.env` as `ANTHROPIC_API_KEY=…` when milestone 5 asks for it. Never paste it into the chat.

## 2. The prompts: paste one per session, in order
Start a **fresh session per milestone** so context stays clean. The agent re-reads `CLAUDE.md` each time.

### A. Kickoff (plan only, no code)
```
Read CLAUDE.md, prompt.md, every SKILL.md in .claude/skills, design/tokens.css, ai/*.md,
and the <style> + structure of reference/portfolio-reference.html.
Do NOT write code yet. Reply with:
1) your build plan in ≤15 bullets mapped to the milestones in prompt.md §12,
2) the exact packages you'll install and why,
3) open questions (with the default you'll use if I don't answer),
4) risks to the performance budget.
```

### B. (Optional) Résumé → data
```
Here is my résumé [attach PDF or paste text]. Convert it into ai/resume.template.md exactly in
that structure. Use stable ids (exp-1…, proj-1…, post-1…). Do not invent anything; leave
[placeholders] where info is missing and list them for me at the end.
```

### C. Milestone 1: skeleton, tokens, theme
```
Milestone 1 from prompt.md §12. Use the soft-clay-ui skill.
Scaffold Astro 5 + TypeScript in this folder (keep existing files), set up self-hosted fonts,
import design/tokens.css, add the no-flash theme script + clay sun/moon ThemeToggle,
Header (sticky, progress line + orb) and Footer.
Finish by running the perf-guard skill and show the results table. Then stop.
```

### D. Milestone 2: static sections
```
Milestone 2. Use soft-clay-ui. Build Hero, About, Journey, Writing, Résumé, Contact as Astro
components rendered from src/content/resume.json (write the parser in src/lib/resume-parse.ts).
Match reference/portfolio-reference.html at 390/768/1024/1440 in light AND dark.
No animations yet. Run perf-guard, then stop.
```

### E. Milestone 3: scroll choreography
```
Milestone 3. Use the scroll-motion skill. Port all scroll-driven animations from the reference
(landing orbs, scatter, cards from 4 directions, sideways Journey, fan-in, 3D flip, counter-marquee,
progress orb), add the motion-fallback module and reduced-motion handling.
Run perf-guard (include INP while scrolling). Stop.
```

### F. Milestone 4: interactivity upgrades
```
Milestone 4. Use scroll-motion + soft-clay-ui. Implement the ⭐ upgrades in prompt.md §5.2:
pointer parallax, grab-and-throw clay, Journey drag/keys/snap/expand, reactions with clay confetti
(+ /api/react with KV, local fallback), paper-plane résumé download, magnetic contact, copy-email toast.
Run perf-guard. Stop.
```

### G. Milestone 5: AI twin
```
Milestone 5. Use the ai-twin skill. Build the chat per prompt.md §7: inline hero card with
instant FAQ chips, docked orb + non-modal panel with FLIP hand-off, orb states, /api/twin edge
streaming with prompt caching and rate limits, citations that scroll to and pulse Journey/Writing
cards, actions, and tests/twin.eval.ts (≥20 cases). Read ANTHROPIC_API_KEY from .env.
Run the evals and perf-guard; show both results. Stop.
```

### H. Milestone 6: polish & ship
```
Milestone 6. OG image (Satori), JSON-LD Person, sitemap, robots, clay 404 page, /resume HTML
fallback, final perf-guard. Then give me step-by-step deploy instructions for Vercel including
env vars and KV setup.
```

### I. Responsive QA: web + mobile (run after D, after F, and before every deploy)
```
Use the qa-responsive skill. QA the whole site on web and mobile.
1) Write and run tests/responsive.spec.ts across every viewport in the skill (320px → 1920px,
   phone landscape, tablets), light + dark, normal + reduced motion.
2) Save screenshots to qa/screens and write qa/REPORT.md, worst issue first, with root cause.
   [Optional: also describe what you see on your own phone, e.g. "Hero text overlaps the clay
   objects on my iPhone 13; Contact marquee makes the page scroll sideways."]
3) Fix every issue at the root (fluid layout, clamp(), overflow-x: clip, dvh), never per-device hacks.
4) Re-run until all assertions pass; add before/after screenshots to the report.
5) Run perf-guard to confirm nothing regressed. Then stop and summarise.
```

---

## Career Coach mode (brief 2: `career-mode.md`). Start only after H and I are done.

### J. C1: route, vault and device-bound sessions
```
Read career-mode.md, ai/career-system-prompt.md and the career-coach skill. Milestone C1:
build the /career route rendered on demand with per-request CSP nonces ("/" stays prerendered),
its own entry script (none of the portfolio's src/islands/main.ts), the layout (desktop rail + chat,
mobile bottom sheet), the "Ask Harnie | Career Coach" switch as static hero HTML (two real links,
no script-injected markup), src/lib/vault.ts (non-extractable
AES-GCM, IndexedDB, 90-day retention, delete-everything), src/lib/device.ts (non-extractable
ECDSA P-256, /api/device/register, signed requests, nonce + timestamp checks on the server), and
conversations that persist and restore exactly on reload. Show me the replay/tamper tests failing
as expected. Run qa-responsive on /career and perf-guard. Stop.
```

### K. C2: résumé upload, profile and coaching chat
```
Milestone C2 (career-coach skill). Upload PDF/DOCX ≤5MB with the consent line, parse in the
browser (lazy pdfjs-dist + mammoth), /api/career/profile → editable profile card, then the
coaching chat with compact context (profile + rolling summary + last 6 messages), orb states
incl. "reading". Confirm Career Coach code never loads on "/". Stop.
```

### L. C3: find jobs (5 per day, freshest first)
```
Milestone C3 (career-coach skill). Free sources only, behind adapters in src/lib/jobs/:
Greenhouse, Lever and Ashby boards (src/content/companies.json, ~50 companies incl. Nigerian and
remote-first startups; scripts/check-boards.ts marks 404 tokens inactive), plus Himalayas
(optional HIMALAYAS_API_KEY), Remotive and Jobicy. Re-read each provider's docs and terms first
and follow career-mode.md §3.3b exactly (attribution "via X", the required apply link, no
republishing, remove expired jobs, polling limits). Hourly GitHub Actions workflow
(.github/workflows/ingest-jobs.yml → scripts/ingest-jobs.ts) stores the last 48h in Upstash
Redis; /api/career/jobs only reads Redis. Rules: max 5 job cards per device per day; tiers
posted ≤ 60 min (ATS) → today's most recent → this week (Remotive) only if short of 5; honest
"posted / published / updated N ago" labels; never repeat a job; rank with one batched Haiku call;
drop fit < 55. Job cards with Open job (new tab), source attribution, Tailor, Cover letter, Save,
and "jobs left today". Report the Redis command estimate. Stop.
```

### M. C4: tailor, improve, cover letter and downloads
```
Milestone C4 (career-coach skill). Tailor to a found job or a pasted description: match analysis,
up to 3 quick questions, tailored résumé JSON + change log + ATS before/after, before/after diff
preview with inline edits, DOCX (docx) and PDF downloads in one ATS-safe template, all lazy-loaded.
Add "Improve my résumé" and cover letters. Add the code-level no-fabrication check (entities and
numbers diffed against the source). Stop.
```

### N. C5: limits, security, privacy and evals
```
Milestone C5 (career-coach skill). Per-device + per-IP daily limits from career-mode.md §7
(10 messages, 2 tailored résumés, 1 cover letter, 5 jobs), the global daily budget kill switch
(CAREER_DAILY_BUDGET_USD=1, counted from real token usage), Turnstile on device registration (the
only third party: challenges.cloudflare.com in script-src and frame-src), strict per-request CSP
nonces + Trusted Types + DOMPurify on /career, /career/privacy page, tests/career.eval.ts (≥25 cases) and
tests/career.security.spec.ts. Run both, then qa-responsive and perf-guard on / and /career.
List every env var I must add in Vercel. Stop.
```

## 3. Tips for steering
- **Review in the browser after every milestone:** `npm run dev`, then compare side by side with `reference/portfolio-reference.html`.
- **Fix things with precise feedback:** "Journey on 390px: cards overlap the road; match the reference spacing" works better than "it looks off".
- **Screenshots help:** drag a screenshot into the chat and point at the problem.
- **If it drifts from the brief:** "Re-read CLAUDE.md and the soft-clay-ui skill, then list what you changed that violates them."
- **Keep the budget honest:** never accept "Lighthouse 9x is fine". Ask it to run perf-guard and fix the failures.
