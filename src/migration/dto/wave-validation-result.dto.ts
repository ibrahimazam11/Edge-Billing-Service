import type { CustomerValidationResult } from "./customer-validation-result.dto";

export interface WaveValidationResult {
  waveSize: number;
  consistent: number;
  discrepancyFound: number;
  errorCount: number;
  totalRecordsCompared: number;
  totalDiscrepancies: number;
  customerResults: CustomerValidationResult[];
}
