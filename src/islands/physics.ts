// One spring integrator (stiffness 170, damping 18) shared by parallax, grab-and-throw, tilt and magnetic hovers.
// All springs tick in a single rAF loop that stops as soon as everything is at rest.

export const STIFFNESS = 170;
export const DAMPING = 18;
const STEP = 1 / 120;

export class Spring2D {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  tx = 0;
  ty = 0;
  held = false;

  constructor(private render: (x: number, y: number) => void) {}

  /** Move the rest point; the body springs towards it. */
  target(x: number, y: number) {
    this.tx = x;
    this.ty = y;
    wake(this);
  }

  /** Pin the body to a position (dragging); velocity is tracked by the caller. */
  hold(x: number, y: number) {
    this.held = true;
    this.x = x;
    this.y = y;
    this.render(x, y);
  }

  /** Let go with a velocity in px/s; the spring carries it home. */
  release(vx: number, vy: number) {
    this.held = false;
    this.vx = vx;
    this.vy = vy;
    wake(this);
  }

  step(dt: number) {
    if (this.held) return;
    this.vx += (-STIFFNESS * (this.x - this.tx) - DAMPING * this.vx) * dt;
    this.vy += (-STIFFNESS * (this.y - this.ty) - DAMPING * this.vy) * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  get resting() {
    return this.held || (Math.abs(this.vx) + Math.abs(this.vy) < 0.5 && Math.abs(this.x - this.tx) + Math.abs(this.y - this.ty) < 0.05);
  }

  draw() {
    if (this.resting && !this.held) {
      this.x = this.tx;
      this.y = this.ty;
    }
    this.render(this.x, this.y);
  }
}

const active = new Set<Spring2D>();
let last = 0;
let frame = 0;

function wake(spring: Spring2D) {
  active.add(spring);
  if (!frame) frame = requestAnimationFrame(tick);
}

function tick(now: number) {
  const elapsed = Math.min(0.05, last ? (now - last) / 1000 : STEP);
  last = now;
  for (let t = 0; t < elapsed; t += STEP) for (const s of active) s.step(Math.min(STEP, elapsed - t));
  for (const s of active) {
    s.draw();
    if (s.resting) active.delete(s);
  }
  frame = active.size ? requestAnimationFrame(tick) : 0;
  if (!frame) last = 0;
}

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const finePointer = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
