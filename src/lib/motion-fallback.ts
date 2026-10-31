// Scroll choreography for browsers without CSS scroll-driven animations (loaded only when <html> has .no-sda).
// Entrances play time-based versions of the same keyframes once an element enters; the progress bar,
// sideways Journey and counter-marquee are scrubbed from a single rAF-batched scroll handler.

const ENTRANCES = '.land-l,.land-r,.land-u,.land-s,.pad,.reveal,.rise,.from-l,.from-r,.from-t,.from-b,.fan-l,.fan-c,.fan-r,.flip';

/** Progress through an element's `cover` range, remapped to [from, to] and clamped to 0–1. */
function cover(rect: DOMRect, viewport: number, from = 0, to = 1) {
  const c = (viewport - rect.top) / (viewport + rect.height);
  return Math.min(1, Math.max(0, (c - from) / (to - from)));
}

export function start() {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px' },
  );
  document.querySelectorAll(ENTRANCES).forEach((el) => io.observe(el));

  const root = document.documentElement;
  const progress = document.querySelector<HTMLElement>('.progress');
  const journey = document.getElementById('journey');
  const contact = document.getElementById('contact');
  let queued = false;

  const frame = () => {
    queued = false;
    // Read everything first, then write.
    const vh = innerHeight;
    const max = root.scrollHeight - vh;
    const p = max > 0 ? scrollY / max : 0;
    const jp = journey ? cover(journey.getBoundingClientRect(), vh, 0.18, 0.88) : 0;
    const mq = contact ? cover(contact.getBoundingClientRect(), vh) : 0;
    progress?.style.setProperty('--p', p.toFixed(4));
    journey?.style.setProperty('--jp', jp.toFixed(4));
    contact?.style.setProperty('--mq', mq.toFixed(4));
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(frame);
  };
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule, { passive: true });
  frame();
}
