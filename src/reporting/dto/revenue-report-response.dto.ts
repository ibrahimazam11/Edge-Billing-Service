export class RevenueReportResponseDto {
  totalInvoiced!: number;
  totalCollected!: number;
  totalOutstanding!: number;
  totalWriteOff!: number;
  totalCreditsIssued!: number;
  netRevenue!: number;
  currency!: string;
  periodStart!: string;
  periodEnd!: string;
}
