export interface CyclePeriodState {
  billingPeriodStart: string;
  billingPeriodEnd: string;
  nextBillingDate: string | null;
}

export interface CycleInvoiceSummary {
  id: string;
  status: string;
  type: string;
  totalAmountCents: number;
  creditApplied: number;
  paymentStatus: "succeeded" | "pending" | "failed" | "skipped" | "unknown";
  stripePaymentIntentId: string | null;
}

export interface AdvanceCycleResponseDto {
  simulationId: string;
  customerId: string;
  monolithCustomerId: string;
  subscriptionId: string;
  beforeState: CyclePeriodState;
  invoice: CycleInvoiceSummary | null;
  afterState: CyclePeriodState & { advanceApplied: boolean };
  notes: string[];
}
