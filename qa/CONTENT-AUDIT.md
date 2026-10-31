# Content launch audit

Branch `content-launch-audit`, 2026-10-31. Sources of truth, in order: `ai/resume.template.md`, `public/resume/iyanuoluwa-anota-cv.pdf`, the owner's answers.

**Owner decisions:**
- No metrics on the site for now (they stay in the PDF).
- Phone number stays off.
- Location is "Ontario, Canada", open to remote, hybrid or on-site; 2-week notice.
- Résumé updated Oct 2026.
- Spidra link is https://spidra.io/.
- Domain is theiconiciyanuoluwa.com.
- Sample blog posts stay as an approved exception.
- Hero and FAQ copy is drawn from the résumé.

**Guard:** `scripts/check-content.ts` runs in `npm run build` before `astro build` (sources) and after it (`--dist`). It fails on `[…]` placeholders, Sirkay, lorem, TODO, TBD, example.com, `href="#"` and sample names. The Writing section's sample posts are allowlisted by the owner.

No hits anywhere for: Sirkay, lorem, TODO/TBD, example.com, Acme, Jane/John Doe, `href="#"`, empty `alt`. The favicon is custom.

## 1 · Placeholders and demo content

| # | Location (file:line) | Was | Problem | Fix applied | Source | Status |
|---|---|---|---|---|---|---|
| 1 | `src/components/Writing.astro` (home §03) | 3 sample posts | Demo titles | **Kept by owner decision**; allowlisted in the guard | Owner | Exception |
| 2 | `src/components/Writing.astro:55` | `[Date] · [X] min read` | Placeholder | Kept with the sample posts | Owner | Exception |
| 3 | `ai/resume.template.md` writing section | `[one line]`, `/blog/[slug]` | Placeholder | Kept with the sample posts | Owner | Exception |
| 4 | `src/components/Header.astro:16` | "Writing" nav link | Points to the sample section | Kept with the sample posts | Owner | Exception |
| 5 | `ai/resume.template.md` exp-2, proj-2 | `[Product Name]` | Placeholder (also in the PDF) | "an AI-powered automation platform"; project named "Creator automation platform (SkillHat)" | Résumé | Fixed (PDF: owner to fix) |
| 6 | `ai/resume.template.md` faq | `[Your answer, ≤ 60 words]` | Placeholder in hero chips | Answer built from the résumé summary and SkillHat bullets | Résumé | Fixed |
| 7 | `src/components/Resume.astro:50` | `Updated [Month Year]` | Hard-coded placeholder | Reads `identity.resume_updated` → "Oct 2026" | Owner | Fixed |
| 8 | `ai/resume.template.md:13` | `Hamilton, Ontario, Canada · open to [remote / hybrid / on-site]` | Placeholder; city not in PDF | "Ontario, Canada · open to remote, hybrid or on-site" | Owner | Fixed |
| 9 | `ai/resume.template.md` projects | `link: [url or "private"]` ×5 | Placeholder | proj-1 → https://spidra.io/; others `private` | Owner | Fixed |
| 10 | `ai/resume.template.md` proj-1, proj-3 | `[How you evaluated it]` | Placeholder | Replaced with what the résumé says (MCP pulls live web data; AI core to Worksync) | Résumé | Fixed |
| 11 | `ai/resume.template.md` proj-4, proj-5; `src/pages/resume.astro:82` | `[AI angle, if any]` | Placeholder; résumé gives no AI angle | Left empty; `/resume` hides the "AI angle" line when empty | Résumé | Fixed |
| 12 | `ai/resume.template.md` certs | AI Consultant Accelerator `[issuer] — [year]` | Placeholder | SkillHat — 2025 | Certificate (17 Oct 2025) | Fixed |
| 13 | `ai/resume.template.md` certs | Agile Project Management `[issuer] — [year]` | Placeholder | SkillHat — 2025 | Certificate (17 Sep 2025) | Fixed |
| 14 | `ai/resume.template.md` certs | "Google Project Management (certificate) — Google — [year]" | Mislabelled: the file is Google's *Agile Project Management* course on Coursera | "Agile Project Management (course certificate, via Coursera) — Google — 2023" | Certificate (13 Jul 2023) | Fixed |

## 2 · Copy

| # | Location (file:line) | Was | Problem | Fix applied | Source | Status |
|---|---|---|---|---|---|---|
| 15 | `src/components/Hero.astro:35-37`, `src/pages/og.png.ts`, `src/layouts/Base.astro` og:image:alt | "I shape AI into products people love." | Generic tagline | "I take products from concept to market." (7 words), stored once as `identity.hero` and used by the hero, OG image and alt text | Résumé summary | Fixed |
| 16 | `src/components/About.astro:30` | "I live where users, data and models meet." | Stock line | "Strategic thinking, hands-on execution." | Résumé summary | Fixed |
| 17 | `src/components/About.astro:18-23` | Process cards listed skill names only | No copy in your voice | One sentence per stage (19–22 words), with the stage's skills underneath as small tags | Résumé | Fixed |
| 18 | `ai/twin-system-prompt.md:12` | "…a product manager who builds AI products." | Narrower than the résumé | "…builds technology products across AI, SaaS and Fintech." | Résumé | Fixed |
| 19 | `src/components/Resume.astro:19` | "…an AI product team." | Narrow | "…a product team." | Résumé | Fixed |
| 20 | `src/components/Contact.astro:41` | "Got a product idea, a role, or a model that needs a home?" | Gimmicky | "Got a product to build, or a role to fill?" | n/a | Fixed |
| 21 | `ai/resume.template.md` faq "Are you open to work?" | 2-week notice only | Missing work mode | Adds "open to remote, hybrid or on-site roles" | Owner | Fixed |
| 22 | `src/lib/person-schema.ts:8` | Location parsed as city, region, country | "Ontario, Canada" became locality "Ontario" | Parses from the end: region Ontario, country Canada | n/a | Fixed |
| 23 | `src/components/Hero.astro:93,95` | "PRD · v3", "+ AI" props | Decorative, no claim | Kept | n/a | OK |

## 3 · Metrics removed (owner: "no numbers on the site for now")

| # | Item | Was | Now | Status |
|---|---|---|---|---|
| 24 | exp-1 templates | 90+ templates, 40% DAU | "ready-made templates… growing daily active users" | Fixed |
| 25 | exp-2 | 35% scope creep, 18% efficiency, 10 creators, 80%+ satisfaction | Same bullets, no figures ("high user satisfaction") | Fixed |
| 26 | exp-3 / proj-3..5 | ~60% cost, 5 engineers, five modules, 100,000+ applicants, under 5 min, 600+ hours, 4-person team, 6 client products, two flagships | Same bullets, no figures | Fixed |
| 27 | exp-4 | 74% satisfaction | Clause removed | Fixed |
| 28 | Harnie | Saw every metric | Server prompt has no metrics; evals check Harnie doesn't quote any | Fixed |
| 29 | About summary | "4+ years of experience" | **Kept**: years of experience isn't an impact metric. Remove it in the template if you want it gone | Check with owner |

## 4 · Résumé PDF vs template

| # | Item | Status |
|---|---|---|
| 30 | Phone (289) 682-7325: in PDF, off the site | OK (owner) |
| 31 | Website theiconiciyanuoluwa.com: in PDF; used as `site` in `astro.config.mjs` | OK. **DNS not live yet**; point the domain at Vercel |
| 32 | PDF typos: `[Product Name]`, "Bachelor of Science,, Microbiology" | **Owner: fix in the Google Doc and re-export** to `public/resume/iyanuoluwa-anota-cv.pdf` |
| 33 | PDF contains the metrics the site now hides | Intended (owner) |
| 34 | Instagram, availability, certifications: not in PDF, on the site | OK |

## 5 · Links (built site)

| # | Link | Result |
|---|---|---|
| 35 | All internal links and `#anchors` in `/`, `/resume/`, `/404` | 0 broken |
| 36 | https://spidra.io/ | 200 |
| 37 | 3 × Google Drive certificates | 200, public |
| 38 | `mailto:anotaiyanuoluwa@gmail.com` | Matches the PDF |
| 39 | LinkedIn / Instagram | Bot-blocked (999 / login wall): **owner to click once** |
| 40 | https://theiconiciyanuoluwa.com (canonical, OG, sitemap) | No DNS yet: **owner to point at Vercel** |
| 41 | `/resume/iyanuoluwa-anota-cv.pdf` | Present, clean filename |

## 6 · Decisions recorded

- **Harnie's prompt stays tokenised** (`{{NAME}}`, per `CLAUDE.md` and `prompt.md` §7.4). Visitors see your real name; the Claude API never receives it.
- **Twin evals:** 30 cases. They now check for no metrics, Ontario (no city), and remote/hybrid/on-site. They were **not run**: there's no `ANTHROPIC_API_KEY` in `.env`. Run `npm run test:twin` once the key is added.
