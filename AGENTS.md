# AGENTS.md

> Same rules as CLAUDE.md, for Cursor, Codex and other agents. Skills live in `.claude/skills/*/SKILL.md`: read the relevant one before each task.


The AI agent reads this file automatically at the start of every session. Keep it short and true.

## What we're building
A single-page portfolio for Iyanuoluwa Anota (nickname theIconicIyanuoluwa), a product manager who builds AI products. The visual direction is "Soft Clay" (warm, playful, tactile 3D) with scroll motion that moves in many directions, light and dark mode, and an AI twin chat, **Harnie**, that answers only from the résumé.

## Read before working
1. `prompt.md`: the full build brief. **It wins on any conflict.**
2. `reference/portfolio-reference.html`: the visual and motion source of truth. Open it in Chrome and scroll.
3. `design/tokens.css`: the only allowed source of colours, type, radii and motion values.
4. `ai/resume.template.md` → `src/content/resume.json`: the only source of personal facts.

5. `career-mode.md`: brief 2, the Career Coach mode (`/career`). Build it only after the portfolio milestones.

## Skills in this repo (use them)
- `soft-clay-ui`: any visual or component work
- `scroll-motion`: any animation, scroll or interaction work
- `ai-twin`: anything about the portfolio chat, `/api/twin` or the résumé data
- `career-coach`: anything in `/career`: upload, device-bound encrypted storage, jobs, tailoring, export
- `qa-responsive`: any "looks broken on mobile/tablet" report, after UI milestones, and before deploy
- `perf-guard`: run before every commit and at the end of each milestone

## House rules
- Stack: Astro 5 + TypeScript, plain CSS, Preact islands only where interactive. No new dependencies without asking. Approved for `/career` only, lazy-loaded: `pdfjs-dist`, `mammoth`, `docx`, `pdf-lib`, `dompurify`. Stay on Astro 5 (no upgrade).
- Never invent biography facts. Show a visible `[placeholder]` when data is missing.
- No raw hex values in components; use tokens only. Check every screen in light **and** dark mode.
- Animate only `transform`, `opacity` (and `clip-path` on the heading reveal). Honour `prefers-reduced-motion`.
- Work one milestone at a time (prompt.md §12). Finish each with build + Lighthouse numbers + a short summary, then stop for review.
- Secrets live only in `.env` (never committed). `ANTHROPIC_API_KEY` is used server-side only.
- The owner's name and contact details never go to the Claude API: the server uses tokenised `resume.twin.json`; the browser expands `{{NAME}}` etc. (prompt.md §7.4).

## Commands
- dev: `npm run dev` (regenerates `src/content/resume.json` from `ai/resume.template.md` first)
- build: `npm run build && npm run preview` (preview serves `.vercel/output/static` with brotli on :4321; `astro preview` isn't supported by the Vercel adapter)
- checks: `npm run check` (astro check + raw-colour lint) · `npm run size` (bundle budgets + secret/name grep) · `npm run lh` (Lighthouse mobile ×3, median) · `npm run test:a11y` (Playwright: axe light/dark × 4 widths, JS-off, reduced motion, motion rules, forced fallback, fonts, console, theme flash) · `npm run perf:scroll` (INP + long tasks while scrolling, 4× CPU)
- `npm run test:unit` (twin privacy + stream helpers) · `npm run test:api` (/api/react vs fake Upstash, /api/twin vs fake Claude API) · `npm run test:twin` (28 live evals vs the real model; needs ANTHROPIC_API_KEY in .env, or EVAL_URL)
- AI twin: model `claude-haiku-5-5` (no temperature — Haiku 5.5 rejects non-default sampling), thinking off + effort low for first-token speed; server only ever sees tokenised `src/content/twin-prompt.ts`
- Interactive code lives in `src/islands/*.ts` (plain TS, one entry `main.ts`); shared spring in `physics.ts`. Env vars: see `.env.example`
- Fonts are pre-built WOFF2 in `public/fonts/` (fonttools instance + Latin subset); fallback metrics live in `src/styles/fonts.css`
