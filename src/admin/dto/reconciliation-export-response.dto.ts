import type { DisputeStatus } from "./dispute-status.constants";
import type { DiscrepancySearchResponseDto } from "./discrepancy-search-response.dto";

export class ReconciliationExportResponseDto {
  exportDate!: string;
  dateRange!: {
    from: string;
    to: string;
  };
  summary!: {
    totalDiscrepancies: number;
    byStatus: Record<DisputeStatus, number>;
    totalDifferenceCents: number;
  };
  discrepancies!: DiscrepancySearchResponseDto[];
}
