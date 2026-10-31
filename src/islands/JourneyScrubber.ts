import { prefersReducedMotion } from './physics';

// Must match the `slide` animation-range in motion.css (cover 18% → cover 88%) and its 92vw end offset.
const RANGE_START = 0.18;
const RANGE_END = 0.88;
const END_INSET_VW = 0.92;
const DRAG_SLOP = 6;
// Snap only within 15% of the gap between stops: smaller than one wheel notch (~20%), so it can never trap a reader.
const SNAP_REACH = 0.15;
const SNAP_IDLE_MS = 220;

/**
 * Journey road: vertical scroll drives the sideways track (CSS or motion-fallback). This adds drag-to-scrub,
 * ←/→/Home/End keys, a soft snap to the nearest milestone, click-to-expand, and `journey:focus` deep links.
 * With reduced motion the road is a native horizontal scroller and the same controls move scrollLeft instead.
 */
export function initJourney() {
  const section = document.getElementById('journey');
  const wrap = section?.querySelector<HTMLElement>('.track-wrap');
  const track = wrap?.querySelector<HTMLElement>('.track');
  if (!section || !wrap || !track) return;
  const stops = [...track.querySelectorAll<HTMLElement>(':scope > li')];
  const scrollDriven = () => !prefersReducedMotion();

  // ---------- geometry: scroll position ↔ track progress ----------
  const geometry = () => {
    const vh = innerHeight;
    const vw = innerWidth;
    const top = section.getBoundingClientRect().top + scrollY;
    const height = section.offsetHeight;
    const travel = Math.max(0, track.offsetWidth - END_INSET_VW * vw);
    const span = (RANGE_END - RANGE_START) * (vh + height);
    const yAt = (t: number) => top - vh + (RANGE_START + (RANGE_END - RANGE_START) * t) * (vh + height);
    const progress = () => Math.min(1, Math.max(0, (scrollY - yAt(0)) / span));
    const stopT = stops.map((li) => (travel ? Math.min(1, Math.max(0, (li.offsetLeft + li.offsetWidth / 2 - vw / 2) / travel)) : 0));
    return { travel, span, yAt, progress, stopT };
  };

  // Where each stop sits (track progress, or scrollLeft when native) and where the road is now.
  // Several stops can share a position when the road is shorter than the screen, so keys step between distinct ones.
  const positions = () => {
    if (scrollDriven()) return geometry().stopT;
    const max = wrap.scrollWidth - wrap.clientWidth;
    return stops.map((li) => Math.min(max, Math.max(0, li.offsetLeft + li.offsetWidth / 2 - wrap.clientWidth / 2)));
  };
  const current = () => (scrollDriven() ? geometry().progress() : wrap.scrollLeft);
  const step = (dir: 1 | -1) => {
    const at = positions();
    const now = current();
    const eps = scrollDriven() ? 0.005 : 2;
    if (dir > 0) {
      const i = at.findIndex((v) => v > now + eps);
      return i < 0 ? stops.length - 1 : i;
    }
    const i = at.findLastIndex((v) => v < now - eps);
    return i < 0 ? 0 : i;
  };

  const nearest = () => {
    if (!scrollDriven()) {
      const centre = wrap.scrollLeft + wrap.clientWidth / 2;
      return closestIndex(stops.map((li) => li.offsetLeft + li.offsetWidth / 2), centre);
    }
    const g = geometry();
    return closestIndex(g.stopT, g.progress());
  };

  const goTo = (i: number, behavior: ScrollBehavior = prefersReducedMotion() ? 'instant' : 'smooth') => {
    const index = Math.max(0, Math.min(stops.length - 1, i));
    if (!scrollDriven()) {
      const li = stops[index];
      wrap.scrollTo({ left: li.offsetLeft + li.offsetWidth / 2 - wrap.clientWidth / 2, behavior });
      return;
    }
    const g = geometry();
    scrollTo({ top: g.yAt(g.stopT[index]), behavior });
  };

  // ---------- soft snap after scrolling stops inside the road ----------
  let dragging = false;
  const snap = () => {
    if (dragging || !scrollDriven()) return;
    const g = geometry();
    const p = g.progress();
    if (p <= 0 || p >= 1) return;
    const i = closestIndex(g.stopT, p);
    const spacing = 1 / Math.max(1, stops.length - 1);
    const off = Math.abs(g.stopT[i] - p);
    if (off > 0.005 && off < spacing * SNAP_REACH) goTo(i);
  };
  // Wait for a real pause: wheels fire scrollend after every notch.
  let idle = 0;
  const later = () => {
    clearTimeout(idle);
    idle = window.setTimeout(snap, SNAP_IDLE_MS);
  };
  addEventListener('scroll', () => clearTimeout(idle), { passive: true });
  if ('onscrollend' in window) addEventListener('scrollend', later);
  else addEventListener('scroll', later, { passive: true });

  // ---------- drag / swipe to scrub ----------
  let start: { x: number; id: number } | null = null;
  let moved = false;
  let pendingDx = 0;
  let queued = false;
  const applyDrag = () => {
    queued = false;
    const dx = pendingDx;
    pendingDx = 0;
    if (!scrollDriven()) {
      wrap.scrollLeft -= dx;
      return;
    }
    const g = geometry();
    if (g.travel) scrollBy({ top: (-dx * g.span) / g.travel, behavior: 'instant' });
  };
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // Stops a mouse drag from selecting card text; clicks still fire.
    if (e.pointerType === 'mouse' && !(e.target as Element).closest('summary, a, button')) e.preventDefault();
    start = { x: e.clientX, id: e.pointerId };
    moved = false;
  });
  wrap.addEventListener(
    'pointermove',
    (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      if (!moved) {
        if (Math.abs(dx) < DRAG_SLOP) return;
        moved = true;
        dragging = true;
        wrap.setPointerCapture(e.pointerId);
        wrap.classList.add('is-dragging');
      }
      pendingDx += dx;
      start.x = e.clientX;
      if (!queued) {
        queued = true;
        requestAnimationFrame(applyDrag);
      }
    },
    { passive: true },
  );
  const endDrag = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    start = null;
    wrap.classList.remove('is-dragging');
    if (!moved) return;
    dragging = false;
    requestAnimationFrame(() => goTo(nearest()));
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);
  // A drag must not also count as a click on the card underneath.
  wrap.addEventListener(
    'click',
    (e) => {
      if (!moved) return;
      e.preventDefault();
      e.stopPropagation();
      moved = false;
    },
    true,
  );

  // ---------- keys ----------
  wrap.addEventListener('keydown', (e) => {
    if (e.target !== wrap) return;
    const keys: Record<string, () => number> = {
      ArrowRight: () => step(1),
      ArrowLeft: () => step(-1),
      Home: () => 0,
      End: () => stops.length - 1,
    };
    if (!keys[e.key]) return;
    e.preventDefault();
    goTo(keys[e.key]());
  });

  // ---------- click a stop to expand its highlights ----------
  for (const li of stops) {
    const details = li.querySelector('details');
    const card = li.querySelector<HTMLElement>('.stop__card');
    if (!details || !card) continue;
    card.addEventListener('click', (e) => {
      if ((e.target as Element).closest('summary, a, button')) return;
      details.open = !details.open;
    });
    details.addEventListener('toggle', () => {
      if (prefersReducedMotion()) return;
      card.animate({ scale: ['1', '1.03 0.97', '1'] }, { duration: 420, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      if (!details.open) return;
      details.querySelectorAll('li').forEach((item, i) =>
        item.animate(
          [
            { opacity: 0, transform: 'translateY(12px)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 360, delay: 40 * i, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' },
        ),
      );
    });
  }

  // ---------- deep link: scroll to a stop and pulse it (used by the AI twin's citations) ----------
  document.addEventListener('journey:focus', (e) => {
    const id = (e as CustomEvent<{ id: string }>).detail?.id;
    const index = stops.findIndex((li) => li.id === id);
    if (index < 0) return;
    if (scrollDriven()) goTo(index);
    else {
      section.scrollIntoView({ behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
      goTo(index);
    }
    const card = stops[index].querySelector<HTMLElement>('.stop__card');
    card?.classList.remove('is-pulse');
    requestAnimationFrame(() => card?.classList.add('is-pulse'));
    setTimeout(() => card?.classList.remove('is-pulse'), 2600);
  });
}

function closestIndex(values: number[], target: number) {
  let best = 0;
  values.forEach((v, i) => {
    if (Math.abs(v - target) < Math.abs(values[best] - target)) best = i;
  });
  return best;
}
