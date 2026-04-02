export class ChargeResponseDto {
  id!: string;
  invoiceId!: string;
  customerId!: string;
  paymentMethodId!: string;
  amountCents!: number;
  currency!: string;
  status!: string;
  stripePaymentIntentId!: string | null;
  idempotencyKey!: string;
  failureReason!: string | null;
  attemptNumber!: number;
  createdAt!: string;
  updatedAt!: string;
}
