---
name: perf-guard
description: Use before every commit and at the end of each milestone to verify performance, accessibility and theme budgets for the Iyanuoluwa Anota portfolio.
---

# Performance & quality guard

Run all of these and report a table of the results. If any budget fails, fix it before moving on (or explain the trade-off and ask).

1. `npm run build`. Report the gzip size of each JS chunk and the CSS. Budgets: initial JS ≤ 30 KB, chat island ≤ 25 KB (not in the initial graph), CSS ≤ 22 KB.
2. `npm run preview`, then Lighthouse mobile ×3 (median). Budgets: Performance ≥ 98, Accessibility 100, Best Practices 100, SEO 100; LCP ≤ 1.8s, CLS ≤ 0.02, TBT ≤ 100ms.
3. Run axe (Playwright) on `/` in **light and dark**: 0 violations.
4. Reduced motion: emulate `prefers-reduced-motion: reduce` and confirm all content is visible and static.
5. JS disabled: content readable, nav links work, FAQ answers visible.
6. Fonts: 2 WOFF2 files, display font preloaded, no CLS on swap.
7. Grep the client bundle for `ANTHROPIC` or `sk-ant`, and the server bundle and `resume.twin.json` for every part of the owner's name: must find nothing.
8. Console: 0 errors and 0 warnings on load and during a full scroll.

Output format:
| Check | Budget | Result | Pass |
