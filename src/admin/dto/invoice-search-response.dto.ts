export class InvoiceSearchResponseDto {
  id!: string;
  customerId!: string;
  subscriptionId!: string | null;
  status!: string;
  totalAmountCents!: number;
  currency!: string;
  billingPeriodStart!: string;
  billingPeriodEnd!: string;
  dueDate!: string;
  paidAt!: string | null;
  voidedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;
}
