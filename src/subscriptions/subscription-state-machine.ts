import type { AllowedTransitions } from "../common/utils/state-machine.util";

export type SubscriptionStatus =
  | "pending"
  | "active"
  | "paused"
  | "canceled"
  | "past_due";

export const SUBSCRIPTION_TRANSITIONS: AllowedTransitions<SubscriptionStatus> =
  {
    pending: ["active"],
    active: ["paused", "canceled", "past_due"],
    paused: ["active", "canceled"],
    past_due: ["active", "canceled"],
    canceled: [],
  };
