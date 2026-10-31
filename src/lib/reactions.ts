// Reaction keys are "<post-id>:<type>" for Writing cards and "site:<type>" for the Contact panel.
// The API only accepts keys built from these lists, so it never needs the résumé itself.

export const POST_REACTIONS = ['love', 'insight'] as const;
export const SITE_REACTIONS = ['love', 'insightful', 'hire', 'fun'] as const;

export const reactionKeys = (postIds: string[]) => [
  ...postIds.flatMap((id) => POST_REACTIONS.map((r) => `${id}:${r}`)),
  ...SITE_REACTIONS.map((r) => `site:${r}`),
];

export const VISITOR_PATTERN = /^[a-z0-9-]{8,64}$/i;
export const MAX_CHANGES = 16;

export type Counts = Record<string, number>;
export type ReactionChange = { key: string; on: boolean };
