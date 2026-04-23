import { IsOptional, IsIn, IsUUID, IsISO8601 } from "class-validator";
import { PaginationDto } from "../../common/dto/pagination.dto";

const INVOICE_STATUSES = ["draft", "finalized", "paid", "void"] as const;
const INVOICE_TYPES = ["onboarding", "one_time", "recurring"] as const;

export class InvoiceQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsIn(INVOICE_STATUSES)
  status?: string;

  @IsOptional()
  @IsIn(INVOICE_TYPES)
  type?: string;

  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @IsOptional()
  @IsISO8601()
  endDate?: string;
}
