export class PaymentHistoryResponseDto {
  id!: string;
  invoiceId!: string;
  amountCents!: number;
  currency!: string;
  status!: string;
  paymentMethodType!: string | null;
  gatewayProvider!: string | null;
  gatewayChargeId!: string | null;
  failureReason!: string | null;
  attemptNumber!: number;
  createdAt!: string;
}
