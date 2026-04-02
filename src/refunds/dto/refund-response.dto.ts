export class RefundResponseDto {
  id!: string;
  chargeId!: string;
  invoiceId!: string;
  customerId!: string;
  amountCents!: number;
  currency!: string;
  status!: string;
  reason!: string | null;
  idempotencyKey!: string;
  gatewayRefundId!: string | null;
  failureReason!: string | null;
  createdAt!: string;
  updatedAt!: string;
}
