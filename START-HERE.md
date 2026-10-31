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
   ├─ .claude/skills/      ← 4 project skills: soft-clay-ui, scroll-motion, ai-twin, perf-guard
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

## 3. Tips for steering
- **Review in the browser after every milestone:** `npm run dev`, then compare side by side with `reference/portfolio-reference.html`.
- **Fix things with precise feedback:** "Journey on 390px: cards overlap the road; match the reference spacing" works better than "it looks off".
- **Screenshots help:** drag a screenshot into the chat and point at the problem.
- **If it drifts from the brief:** "Re-read CLAUDE.md and the soft-clay-ui skill, then list what you changed that violates them."
- **Keep the budget honest:** never accept "Lighthouse 9x is fine". Ask it to run perf-guard and fix the failures.
