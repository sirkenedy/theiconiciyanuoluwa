import { finePointer, prefersReducedMotion } from './physics';

const MAX_TILT = 6;

/**
 * Cards with [data-tilt] lean towards the pointer (±6°); the CSS transition gives the spring settle.
 * Pointer events come from the parent, which doesn't move, so a tilted edge can't slip out from under the cursor.
 */
export function initTilt() {
  document.querySelectorAll<HTMLElement>('[data-tilt]').forEach((el) => {
    const host = el.parentElement ?? el;
    let pointer: { x: number; y: number } | null = null;
    let queued = false;
    const frame = () => {
      queued = false;
      if (!pointer) return;
      const r = el.getBoundingClientRect();
      const nx = ((pointer.x - r.left) / r.width) * 2 - 1;
      const ny = ((pointer.y - r.top) / r.height) * 2 - 1;
      el.style.setProperty('--ry', `${(nx * MAX_TILT).toFixed(2)}deg`);
      el.style.setProperty('--rx', `${(-ny * MAX_TILT).toFixed(2)}deg`);
    };
    host.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse' && finePointer() && !prefersReducedMotion()) el.style.willChange = 'transform';
    });
    host.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'mouse' || prefersReducedMotion()) return;
        pointer = { x: e.clientX, y: e.clientY };
        if (!queued) {
          queued = true;
          requestAnimationFrame(frame);
        }
      },
      { passive: true },
    );
    host.addEventListener('pointerleave', () => {
      pointer = null;
      el.style.removeProperty('--rx');
      el.style.removeProperty('--ry');
      el.style.willChange = '';
    });
  });
}
