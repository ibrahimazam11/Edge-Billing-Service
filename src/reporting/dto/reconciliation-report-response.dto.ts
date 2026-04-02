export class DiscrepancyResponseDto {
  id!: string;
  type!: string;
  internalReferenceId!: string | null;
  stripeTransactionId!: string | null;
  expectedAmountCents!: number;
  actualAmountCents!: number;
  differenceCents!: number;
}

export class ReconciliationRunResponseDto {
  id!: string;
  periodStart!: string;
  periodEnd!: string;
  status!: string;
  recordsCompared!: number;
  totalInternalAmountCents!: number;
  totalStripeAmountCents!: number;
  createdAt!: string;
  discrepancies!: DiscrepancyResponseDto[];
}
