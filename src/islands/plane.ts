import { prefersReducedMotion } from './physics';

const SPRING = 'cubic-bezier(.34,1.56,.64,1)';

/** Download: the résumé card folds into a paper plane that flies off-screen, then the file downloads. */
export function initPlane() {
  const link = document.querySelector<HTMLAnchorElement>('[data-plane-download]');
  const paper = document.querySelector<HTMLElement>('[data-plane-paper]');
  const plane = document.querySelector<SVGElement>('[data-plane]');
  if (!link || !paper || !plane) return;
  let flying = false;

  link.addEventListener('click', (e) => {
    const paperOnScreen = paper.getBoundingClientRect().bottom > 0 && paper.getBoundingClientRect().top < innerHeight;
    if (flying || prefersReducedMotion() || !paperOnScreen || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    flying = true;

    paper.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: 'scale(0.9, 0.6) rotate(-6deg)', opacity: 1, offset: 0.45 },
        { transform: 'scale(0.3, 0.18) rotate(-14deg)', opacity: 0 },
      ],
      { duration: 380, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' },
    );
    const flight = plane.animate(
      [
        { transform: 'scale(0.3) rotate(-10deg)', opacity: 0 },
        { transform: 'scale(1) rotate(-6deg)', opacity: 1, offset: 0.22 },
        { transform: 'translate(22vw, -6vh) rotate(-12deg) scale(0.95)', opacity: 1, offset: 0.55 },
        { transform: 'translate(70vw, -70vh) rotate(-26deg) scale(0.6)', opacity: 0 },
      ],
      { duration: 1000, delay: 260, easing: 'cubic-bezier(.45,0,.55,1)' },
    );

    flight.finished.then(() => {
      const a = document.createElement('a');
      a.href = link.href;
      a.download = link.getAttribute('download') ?? '';
      a.click();
      paper.getAnimations().forEach((anim) => anim.cancel());
      paper.animate([{ transform: 'scale(0.85)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 500, easing: SPRING });
      flying = false;
    });
  });
}
