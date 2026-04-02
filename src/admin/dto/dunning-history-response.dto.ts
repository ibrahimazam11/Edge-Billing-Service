export class DunningHistoryResponseDto {
  id!: string;
  invoiceId!: string;
  chargeId!: string | null;
  paymentMethodId!: string | null;
  attemptNumber!: number;
  scheduledDate!: string;
  executedAt!: string | null;
  status!: string;
  failureReason!: string | null;
  paymentMethodType!: string | null;
  gatewayProvider!: string | null;
  createdAt!: string;
}
