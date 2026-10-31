---
name: soft-clay-ui
description: Use for any visual, layout or component work on the Iyanuoluwa Anota portfolio — building sections, cards, buttons, clay 3D objects, dark mode, responsive layout.
---

# Soft Clay UI

## Before you start
Open `reference/portfolio-reference.html` and find the section you are building. Match its structure, spacing and copy slots. Import `design/tokens.css` and use only those tokens.

## Rules
1. **Type:** Display uses `--font-display` 800 with tight tracking (−0.03em). UI and body use `--font-body`. Use the sizes from the `--fs-*` scale only.
2. **Clay surfaces:** white or pastel fill + a solid **ledge** below (`box-shadow: var(--ledge-md) var(--*-ledge)`). Pressed state: `translateY(2px)`. Hover: lift `-3px` with `--ease-spring`.
3. **Clay 3D objects:** use the `.clay-sphere` + `.clay--{peach|lilac|mint|butter}` recipes. Build other shapes (sparkle, ring, chat bubble, cursor, card) as in the reference. Make each one its own `ClayObject.astro` with `shape`, `tone` and `size` props, and mark them `aria-hidden`.
4. **Radii:** pills for chips and buttons; `--r-lg`/`--r-xl` for cards; `--r-sm`/`--r-md` for icon tiles.
5. **Icons:** inline SVG, stroke 2, round caps and joins, `currentColor`. No emoji, no icon fonts.
6. **Dark mode:** never hard-code colours. After building a component, view it with `data-theme="dark"` and check contrast (AA: 4.5:1 body, 3:1 for ≥ 24px).
7. **Responsive:** check at 390, 768, 1024 and 1440 px. Touch targets ≥ 44px. Never put information in hover only.
8. **Accessibility:** real `<button>`/`<a>`, visible focus ring (2px `--lilac-deep`, 3px offset), one `h1`, logical headings.

## Never
Gradient-wash backgrounds, glassmorphism (except the header), left-border accent cards, stock illustrations, lorem ipsum, invented facts.

## Done when
It matches the reference at all four widths in both themes, uses no raw hex values, and has no accessibility violations (axe).
