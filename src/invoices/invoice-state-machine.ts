import type { AllowedTransitions } from "../common/utils/state-machine.util";

export type InvoiceStatus = "draft" | "finalized" | "paid" | "void";

export const INVOICE_TRANSITIONS: AllowedTransitions<InvoiceStatus> = {
  draft: ["finalized"],
  finalized: ["paid", "void"],
  paid: [],
  void: [],
};
