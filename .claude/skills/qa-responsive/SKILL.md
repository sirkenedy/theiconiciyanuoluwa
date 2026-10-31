---
name: qa-responsive
description: Use to QA and fix layout on web and mobile — any "looks distorted / broken on phone / tablet" report, after every milestone that touches UI, and before deploy.
---

# Responsive QA (web + mobile)

Goal: the site looks intentional at every width from 320px to 1920px, in light and dark, portrait and landscape, with touch and mouse. Find problems with evidence, fix them at the root, and prove the fix.

## 1. Capture (automated)
Write `tests/responsive.spec.ts` (Playwright) and run it against `npm run preview`:
- **Viewports:** 320×568 (small Android), 360×800, 375×667 (iPhone SE), 390×844 (iPhone 15), 430×932 (Pro Max), 844×390 (phone landscape), 768×1024 and 820×1180 (tablets), 1024×768, 1280×800, 1440×900, 1920×1080.
- Use Playwright device descriptors for iPhone 15, Pixel 7 and iPad Mini as well (touch + device pixel ratio).
- For each viewport × theme (light, dark) × motion (normal, reduced): full-page screenshot to `qa/screens/<page>-<w>x<h>-<theme>-<motion>.png`, plus a screenshot after scrolling to each section (scroll animations change layout mid-scroll).
- **Automated assertions on every viewport:**
  - No horizontal overflow: `document.documentElement.scrollWidth <= window.innerWidth`. On failure, list offending elements (`el.getBoundingClientRect().right > innerWidth`).
  - No text clipped: elements with `scrollWidth > clientWidth` and `overflow: hidden` that contain text.
  - Tap targets ≥ 44×44px for every `a`, `button`, `input`, `[role=tab]`.
  - Inputs and textareas have font-size ≥ 16px (otherwise iOS Safari zooms in on focus).
  - No overlapping interactive elements (bounding-box intersection between siblings).
  - Sticky header doesn't cover anchor targets (`scroll-margin-top` is set).
  - Body text ≥ 16px; line length ≤ 75ch.
  - axe: 0 violations.

## 2. Review (by eye)
Open the screenshots and compare each against `reference/portfolio-reference.html` at the same width. Write `qa/REPORT.md` as a table, worst first:
| # | Page/section | Viewport | Theme | What's wrong | Screenshot | Root cause | Fix |

Known mobile hotspots to check deliberately:
1. **Hero:** headline clamp too large or too small at 320–390; the 3D stage overlapping text or overflowing; floating objects pushed past the edge by parallax or scatter transforms; stage order on mobile (above the text).
2. **Scroll animations:** `translateX(-55vw)` entrances and scatter exits causing sideways scroll. Parents of off-canvas animated elements need `overflow-x: clip` (not `hidden`, which breaks `position: sticky`).
3. **Journey:** track width math at small widths; cards `min(360px, 78vw)`; swipe and scroll don't fight; the last card is reachable.
4. **Contact marquee:** giant text must not widen the page (`overflow: clip` on the band).
5. **Header:** nav collapse < 760px; the menu sheet; safe-area insets (`env(safe-area-inset-*)`) on notched phones.
6. **Chat/dock:** bottom sheet with the on-screen keyboard open (use `visualViewport` to resize); `100dvh` not `100vh`; the input stays visible above the keyboard; the dock orb doesn't cover the footer links.
7. **Landscape phones (844×390):** hero must not require scrolling just to see the headline.
8. **Dark mode:** ledges and shadows still read; no white flashes on images.

## 3. Fix rules
- Fix the cause (container, clamp, min/max), never with one-off magic numbers per device.
- Prefer fluid layout: `clamp()`, `min()`, `minmax()`, `flex-wrap`, container queries (`@container`) for cards.
- Mobile-first media queries; breakpoints chosen by content, not device names.
- Use `dvh`/`svh` for full-height areas, never bare `vh` on mobile.
- After fixes, re-run the spec. Attach before/after screenshots for every row in `qa/REPORT.md` and mark it fixed.

## 4. Real-device check
Run `npm run dev -- --host`, open the LAN URL on a real phone (iOS Safari + Android Chrome), and walk through it: scroll every section, rotate, open the chat, type with the keyboard up, toggle theme. Note anything the emulator missed in the report.

## Done when
All assertions pass at every viewport in both themes; `qa/REPORT.md` has no open rows; Lighthouse mobile is still ≥ 98.
