import {
  IsString,
  IsNotEmpty,
  IsInt,
  Min,
  IsDateString,
  IsOptional,
  IsEnum,
  IsUUID,
  IsObject,
  Length,
} from "class-validator";

export enum BillingInterval {
  MONTHLY = "monthly",
}

export class CreateSubscriptionDto {
  @IsUUID()
  @IsNotEmpty()
  customerId!: string;

  @IsString()
  @IsNotEmpty()
  planName!: string;

  @IsInt()
  @Min(1)
  amountCents!: number;

  @IsDateString()
  @IsNotEmpty()
  billingStartDate!: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @IsEnum(BillingInterval)
  billingInterval?: BillingInterval;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
