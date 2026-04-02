import { IsOptional, IsISO8601, IsUUID, IsIn } from "class-validator";
import { PaginationDto } from "../../common/dto/pagination.dto";
import { DISPUTE_STATUSES } from "./dispute-status.constants";

export class DiscrepancySearchQueryDto extends PaginationDto {
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @IsOptional()
  @IsIn([...DISPUTE_STATUSES])
  disputeStatus?: string;

  @IsOptional()
  @IsUUID()
  runId?: string;
}
