import { IsOptional, IsISO8601 } from "class-validator";
import { PaginationDto } from "../../common/dto/pagination.dto";

export class DunningHistoryQueryDto extends PaginationDto {
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;
}
