export interface ChargeResultDto {
  chargeId: string;
  status: "pending" | "succeeded" | "failed";
  stripePaymentIntentId: string | null;
  failureReason?: string;
}
