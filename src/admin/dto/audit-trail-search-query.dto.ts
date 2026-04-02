import { IsOptional, IsISO8601, IsString, MaxLength } from "class-validator";
import { PaginationDto } from "../../common/dto/pagination.dto";

export class AuditTrailSearchQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  entityType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  entityId?: string;

  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  adminUserId?: string;
}
