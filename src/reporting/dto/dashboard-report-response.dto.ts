export class DashboardReportResponseDto {
  activeSubscriptions!: number;
  monthlyRecurringRevenue!: number;
  currentMonthInvoiced!: number;
  currentMonthCollected!: number;
  currentMonthOutstanding!: number;
  paymentSuccessRate!: number;
  dunningRecoveryRate!: number;
  reconciliationStatus!: "balanced" | "discrepancy_found" | "failed" | "none";
  currency!: string;
  periodStart!: string;
  periodEnd!: string;
}
