export class InvoiceLineItemDetailResponseDto {
  id!: string;
  invoiceId!: string;
  type!: string;
  description!: string;
  amountCents!: number;
  quantity!: number;
  createdAt!: string;
}
