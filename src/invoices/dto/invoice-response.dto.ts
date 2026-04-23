import type { InvoiceLineItemResponseDto } from "./invoice-line-item-response.dto";

export class InvoiceResponseDto {
  id!: string;
  customerId!: string;
  subscriptionId!: string | null;
  type!: string;
  status!: string;
  totalAmountCents!: number;
  currency!: string;
  billingPeriodStart!: string;
  billingPeriodEnd!: string;
  dueDate!: string;
  paidAt!: string | null;
  voidedAt!: string | null;
  metadata!: Record<string, unknown> | null;
  lineItems!: InvoiceLineItemResponseDto[];
  createdAt!: string;
  updatedAt!: string;
}
