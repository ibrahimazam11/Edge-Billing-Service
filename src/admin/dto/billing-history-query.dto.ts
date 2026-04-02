import { IsOptional, IsISO8601, IsIn } from "class-validator";
import { PaginationDto } from "../../common/dto/pagination.dto";
import {
  BILLING_HISTORY_TYPES,
  type BillingHistoryType,
} from "./billing-history-types.constants";

export class BillingHistoryQueryDto extends PaginationDto {
  @IsOptional()
  @IsISO8601()
  declare cursor?: string;

  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @IsOptional()
  @IsIn([...BILLING_HISTORY_TYPES])
  type?: BillingHistoryType;
}
