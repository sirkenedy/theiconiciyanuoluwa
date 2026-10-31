import type { Page } from '@playwright/test';

/**
 * Waits for every finite, time-based animation (load-ins, fallback entrances) to finish.
 * Animations inside a section skipped by content-visibility don't advance, so the wait is capped.
 */
export async function settle(page: Page, timeout = 3000) {
  await page.evaluate(
    (ms) =>
      Promise.race([
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.timeline === document.timeline && a.effect?.getComputedTiming().endTime !== Infinity)
            .map((a) => a.finished.catch(() => null)),
        ),
        new Promise((r) => setTimeout(r, ms)),
      ]),
    timeout,
  );
}

/** Centres a section in the viewport without smooth scrolling. */
export async function centre(page: Page, id: string) {
  await page.locator(`#${id}`).evaluate((el) => {
    const r = el.getBoundingClientRect();
    scrollTo({ top: scrollY + r.top + r.height / 2 - innerHeight / 2, behavior: 'instant' });
  });
}
