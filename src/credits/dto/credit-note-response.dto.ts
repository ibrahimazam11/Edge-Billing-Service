export class CreditNoteResponseDto {
  id!: string;
  customerId!: string;
  invoiceId!: string;
  amountCents!: number;
  currency!: string;
  reason!: string;
  status!: string;
  createdBy!: string | null;
  createdAt!: string;
}
