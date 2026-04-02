export const BILLING_HISTORY_TYPES = [
  "invoice",
  "payment",
  "credit",
  "refund",
] as const;

export type BillingHistoryType = (typeof BILLING_HISTORY_TYPES)[number];
