// Zod-free constants shared by the browser and the server (the browser must not bundle zod).
export const SENIORITY = ['intern', 'junior', 'mid', 'senior', 'lead', 'principal', 'executive'] as const;
export const REMOTE = ['remote', 'hybrid', 'onsite', 'flexible'] as const;
