export class SubscriptionResponseDto {
  id!: string;
  customerId!: string;
  planName!: string;
  status!: string;
  amountCents!: number;
  currency!: string;
  billingInterval!: string;
  billingPeriodStart!: string;
  billingPeriodEnd!: string;
  nextBillingDate!: string | null;
  stripeSubscriptionId!: string | null;
  metadata!: Record<string, unknown> | null;
  createdAt!: string;
  updatedAt!: string;
}
