import { Spring2D, finePointer, prefersReducedMotion } from './physics';

const MAX_PULL = 6;

export function initContact() {
  initMagnetic();
  initCopyEmail();
}

/** Social cards drift up to 6px towards the pointer and spring back on leave. Events come from the static parent. */
function initMagnetic() {
  document.querySelectorAll<HTMLElement>('[data-magnetic]').forEach((el) => {
    const host = el.parentElement ?? el;
    const spring = new Spring2D((x, y) => (el.style.translate = x || y ? `${x.toFixed(2)}px ${y.toFixed(2)}px` : ''));
    host.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse' && finePointer() && !prefersReducedMotion()) el.style.willChange = 'translate';
    });
    host.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'mouse' || prefersReducedMotion()) return;
        const r = host.getBoundingClientRect();
        const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
        const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
        spring.target(nx * MAX_PULL, ny * MAX_PULL);
      },
      { passive: true },
    );
    host.addEventListener('pointerleave', () => {
      spring.target(0, 0);
      el.style.willChange = '';
    });
  });
}

function initCopyEmail() {
  const toast = document.querySelector<HTMLElement>('[data-toast]');
  let hideTimer = 0;
  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.dataset.copy ?? '';
      let message = 'Email copied';
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        message = `Copy failed — it's ${value}`;
      }
      if (!toast) return;
      toast.textContent = message;
      toast.classList.add('is-on');
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => toast.classList.remove('is-on'), 2200);
    });
  });
}
