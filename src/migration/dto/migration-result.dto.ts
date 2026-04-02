export interface MigrationResult {
  monolithCustomerId: string;
  billingCustomerId?: string;
  status: "succeeded" | "skipped" | "failed";
  reason?: string;
  paymentMethodCount?: number;
}

export interface MigrationSummary {
  runId: string;
  scriptName: string;
  totalProcessed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  duration: number;
}
