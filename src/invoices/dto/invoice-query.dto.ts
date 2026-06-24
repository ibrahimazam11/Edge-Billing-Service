import {
  IsOptional,
  IsIn,
  IsUUID,
  IsISO8601,
  IsInt,
  Min,
} from "class-validator";
import { PaginationDto } from "../../common/dto/pagination.dto";

const INVOICE_STATUSES = ["draft", "finalized", "paid", "void"] as const;
const INVOICE_TYPES = ["onboarding", "one_time", "recurring"] as const;

export class InvoiceQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  /**
   * Override PaginationDto.limit for the invoice listing.
   *
   * PaginationDto.limit defaults to 20 (applied by the global ValidationPipe's
   * transform) and caps at 100. The customer-facing payment-history path lists
   * EVERY invoice for a customer and paginates client-side in the monolith
   * adapter, so a silent 20-row cap drops the newest invoices off the response.
   *
   * Dropping the inherited default lets the service distinguish "no limit
   * supplied" (→ return the full customer set, capped safely in the service)
   * from an explicit cursor-paginated limit. Dropping the Max(100) cap is
   * required because this endpoint must be able to return a customer's full
   * invoice history in one call (this is an internal, HMAC-authenticated
   * service). Cursor callers that pass an explicit limit keep limit+1 "has
   * more" semantics.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number = undefined;

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
