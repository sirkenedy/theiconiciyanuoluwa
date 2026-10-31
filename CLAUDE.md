# Project memory: Iyanuoluwa Anota portfolio (Soft Clay · PM × AI)

The AI agent reads this file automatically at the start of every session. Keep it short and true.

## What we're building
A single-page portfolio for Iyanuoluwa Anota (nickname theIconicIyanuoluwa), a product manager who builds AI products. The visual direction is "Soft Clay" (warm, playful, tactile 3D) with scroll motion that moves in many directions, light and dark mode, and an AI twin chat that answers only from the résumé.

## Read before working
1. `prompt.md`: the full build brief. **It wins on any conflict.**
2. `reference/portfolio-reference.html`: the visual and motion source of truth. Open it in Chrome and scroll.
3. `design/tokens.css`: the only allowed source of colours, type, radii and motion values.
4. `ai/resume.template.md` → `src/content/resume.json`: the only source of personal facts.

## Skills in this repo (use them)
- `soft-clay-ui`: any visual or component work
- `scroll-motion`: any animation, scroll or interaction work
- `ai-twin`: anything about the chat, `/api/twin` or the résumé data
- `perf-guard`: run before every commit and at the end of each milestone

## House rules
- Stack: Astro 5 + TypeScript, plain CSS, Preact islands only where interactive. No new dependencies without asking.
- Never invent biography facts. Show a visible `[placeholder]` when data is missing.
- No raw hex values in components; use tokens only. Check every screen in light **and** dark mode.
- Animate only `transform`, `opacity` (and `clip-path` on the heading reveal). Honour `prefers-reduced-motion`.
- Work one milestone at a time (prompt.md §12). Finish each with build + Lighthouse numbers + a short summary, then stop for review.
- Secrets live only in `.env` (never committed). `ANTHROPIC_API_KEY` is used server-side only.
- The owner's name and contact details never go to the Claude API: the server uses tokenised `resume.twin.json`; the browser expands `{{NAME}}` etc. (prompt.md §7.4).

## Commands (fill in once scaffolded)
- dev: `npm run dev`
- build: `npm run build && npm run preview`
- checks: `npm run check` (astro check + lint) · `npm run test:twin` (chat evals) · `npm run lh` (Lighthouse CI)
