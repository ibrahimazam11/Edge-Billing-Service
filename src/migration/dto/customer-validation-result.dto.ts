export interface ValidationDiscrepancy {
  field: string;
  billingServiceValue: unknown;
  monolithValue: unknown;
  recordReference?: string;
}

export interface CustomerValidationResult {
  customerId: string;
  status: "consistent" | "discrepancy_found" | "error";
  error?: string;
  recordsCompared: number;
  discrepancies: ValidationDiscrepancy[];
}
