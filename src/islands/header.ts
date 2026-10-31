import { prefersReducedMotion } from './physics';

const SPRING = 'cubic-bezier(.34,1.56,.64,1)';

/** Active-section pill that slides between nav links (FLIP), an orb hop per section, and Back to top. */
export function initHeader() {
  const pill = document.querySelector<HTMLElement>('.nav__pill');
  const dot = document.querySelector<HTMLElement>('.progress__dot');
  const links = new Map(
    [...document.querySelectorAll<HTMLAnchorElement>('.nav__links a')].map((a) => [a.hash.slice(1), a]),
  );
  let active = '';

  const hop = () => {
    if (!dot || prefersReducedMotion()) return;
    dot.animate(
      { transform: ['none', 'translateY(-10px) scale(0.9, 1.1)', 'translateY(0) scale(1.25, 0.8)', 'none'] },
      { duration: 520, easing: SPRING },
    );
  };

  const movePill = (link: HTMLAnchorElement | undefined) => {
    if (!pill) return;
    if (!link) {
      pill.classList.remove('is-on');
      return;
    }
    const wasOn = pill.classList.contains('is-on');
    const first = pill.getBoundingClientRect();
    pill.style.left = `${link.offsetLeft}px`;
    pill.style.width = `${link.offsetWidth}px`;
    pill.classList.add('is-on');
    if (!wasOn || prefersReducedMotion()) return;
    const last = pill.getBoundingClientRect();
    pill.animate(
      { transform: [`translateX(${first.left - last.left}px) scaleX(${first.width / last.width})`, 'none'] },
      { duration: 420, easing: SPRING },
    );
  };

  const visible = new Set<string>();
  const sections = ['top', ...links.keys(), 'contact'].map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
  // A thin line across the middle of the viewport decides which section is "current".
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      }
      const current = sections.find((s) => visible.has(s.id))?.id ?? '';
      if (current === active) return;
      const first = !active;
      active = current;
      for (const [id, a] of links) {
        if (id === current) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      }
      movePill(links.get(current));
      if (!first) hop();
    },
    { rootMargin: '-45% 0px -54% 0px' },
  );
  sections.forEach((s) => io.observe(s));

  // Back to top: the orb rides back along the bar with the smooth scroll, then lands with a hop.
  document.querySelectorAll<HTMLAnchorElement>('a[href="#top"]').forEach((a) =>
    a.addEventListener('click', () => {
      const land = () => scrollY < 4 && (hop(), removeEventListener('scroll', land));
      addEventListener('scroll', land, { passive: true });
    }),
  );
}
