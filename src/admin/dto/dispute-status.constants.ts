export const DISPUTE_STATUSES = [
  "open",
  "investigating",
  "resolved",
  "dismissed",
] as const;

export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
