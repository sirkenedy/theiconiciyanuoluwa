---
name: scroll-motion
description: Use for any animation, scroll choreography, hover/drag interaction or physics on the Iyanuoluwa Anota portfolio.
---

# Scroll & interaction motion

## Concept
"Every section is a landing": a clay orb flies in from a different direction, squashes on its shadow pad, then the heading reveals. No two adjacent sections enter from the same direction. The full per-section table is in `prompt.md` §5.2.

## Engine
1. **Primary:** CSS scroll-driven animations. Copy the `@keyframes` and `animation-range` values from the `<style>` in `reference/portfolio-reference.html` into `src/styles/motion.css`, inside `@supports (animation-timeline: view())`.
2. **Fallback:** `src/lib/motion-fallback.ts` (≤ 3 KB), loaded dynamically only when `!CSS.supports('animation-timeline: view()')`. It uses `IntersectionObserver` to add `.is-in` (time-based keyframes) plus one rAF loop for the Journey `translateX` and the progress bar.
3. **Physics:** `src/islands/physics.ts` is one spring integrator (stiffness 170, damping 18) shared by parallax, grab-and-throw and magnetic hovers. No animation libraries.

## Rules
- Animate only `transform` and `opacity` (`clip-path` is allowed only for the heading reveal).
- Pointer and scroll listeners must be `passive` and rAF-batched: read all values first, then write.
- Add `will-change` on `pointerenter` and remove it on `pointerleave`.
- Pause idle loops when off-screen (IntersectionObserver → `animation-play-state`) or when `document.hidden`.
- Touch devices: no drag on the hero objects (tap = squish only); swipe works on Journey.
- `prefers-reduced-motion: reduce` → no scroll choreography, no floats, no parallax; all content visible and static; hovers change colour only.

## Easing
- `--ease-spring`: presses, hovers, landings (clay overshoot)
- `--ease-out`: entrances
- `--ease-inout`: scrubbed travel
- Durations come from the `--dur-*` tokens.

## Done when
Chrome matches the reference; Firefox shows the fallback with no broken layout; reduced motion is fully static; Performance panel shows no long tasks over 50ms while scrolling, and INP is ≤ 150ms during animations.
