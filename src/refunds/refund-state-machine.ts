import type { AllowedTransitions } from "../common/utils/state-machine.util";

export type RefundStatus = "pending" | "processing" | "succeeded" | "failed";

export const REFUND_TRANSITIONS: AllowedTransitions<RefundStatus> = {
  pending: ["processing"],
  processing: ["succeeded", "failed"],
  succeeded: [], // Terminal state
  failed: [], // Terminal state
};
