export class DiscrepancySearchResponseDto {
  id!: string;
  reconciliationRunId!: string;
  type!: string;
  internalReferenceId!: string | null;
  stripeTransactionId!: string | null;
  expectedAmountCents!: number;
  actualAmountCents!: number;
  differenceCents!: number;
  disputeStatus!: string;
  resolvedBy!: string | null;
  resolutionNotes!: string | null;
  resolvedAt!: string | null;
  createdAt!: string;
  periodStart!: string | null;
  periodEnd!: string | null;
}
