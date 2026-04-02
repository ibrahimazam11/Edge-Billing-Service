import { IsOptional, IsIn, IsUUID, IsISO8601 } from "class-validator";
import { PaginationDto } from "../../common/dto/pagination.dto";

const SUBSCRIPTION_STATUSES = [
  "pending",
  "active",
  "paused",
  "canceled",
  "past_due",
] as const;

export class SubscriptionQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsIn(SUBSCRIPTION_STATUSES)
  status?: string;

  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @IsOptional()
  @IsISO8601()
  endDate?: string;
}
