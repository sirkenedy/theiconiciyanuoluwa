// Per device per day, plus per IP per day so minting new devices doesn't reset anything (career-mode.md §7).
// DAILY_LIMITS are shown in the usage panel; uploads and summaries are counted but not displayed.
export const DAILY_LIMITS = { messages: 10, jobs: 5, tailored: 2, letters: 1 } as const;
export const DEVICE_LIMITS = { ...DAILY_LIMITS, uploads: 3, summaries: 2 } as const;
/** Per network per day: 2 devices' worth, so a shared office or home network still works, but deleting and starting again gains at most one extra allowance. */
export const IP_LIMITS: Record<keyof typeof DEVICE_LIMITS, number> = { messages: 20, jobs: 10, tailored: 4, letters: 2, uploads: 6, summaries: 4 };

export type UsageKind = keyof typeof DAILY_LIMITS;
export type CountedKind = keyof typeof DEVICE_LIMITS;
/** `breather`: today's global AI budget is spent; Career Coach rests until midnight UTC. */
export type Usage = { day: string; limits: typeof DAILY_LIMITS; used: Record<UsageKind, number>; breather: boolean };

/** The device's own calendar day (limits reset at its local midnight), as YYYY-MM-DD. */
export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A local date is at most 14 h from UTC either way; anything further is a forged reset. */
export const plausibleDay = (day: string, now = Date.now()) =>
  /^\d{4}-\d{2}-\d{2}$/.test(day) && Math.abs(Date.parse(`${day}T12:00:00Z`) - now) < 40 * 3600_000;
