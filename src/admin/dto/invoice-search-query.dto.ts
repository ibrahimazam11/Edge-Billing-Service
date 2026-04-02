import {
  IsOptional,
  IsUUID,
  IsString,
  MaxLength,
  IsISO8601,
  IsInt,
  Min,
} from "class-validator";
import { PaginationDto } from "../../common/dto/pagination.dto";

export class InvoiceSearchQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  amountMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  amountMax?: number;
}
