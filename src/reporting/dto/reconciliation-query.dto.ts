import { IsOptional, IsIn, IsISO8601 } from "class-validator";
import { PaginationDto } from "../../common/dto/pagination.dto";

const RECONCILIATION_STATUSES = [
  "balanced",
  "discrepancy_found",
  "failed",
] as const;

export class ReconciliationQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(RECONCILIATION_STATUSES)
  status?: string;

  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @IsOptional()
  @IsISO8601()
  endDate?: string;
}
