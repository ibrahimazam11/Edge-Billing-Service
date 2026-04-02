import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from "class-validator";

export class UpsertSurchargeConfigDto {
  @IsBoolean()
  allowCreditCard!: boolean;

  @ValidateIf(
    (o: UpsertSurchargeConfigDto) =>
      o.surchargeValue != null || o.surchargeType != null,
  )
  @IsIn(["percentage", "flat_fee"])
  surchargeType?: "percentage" | "flat_fee" | null;

  @ValidateIf(
    (o: UpsertSurchargeConfigDto) =>
      o.surchargeType != null || o.surchargeValue != null,
  )
  @IsInt()
  @Min(0)
  surchargeValue?: number | null;

  @IsOptional()
  @IsString()
  reason?: string | null;

  @IsOptional()
  @IsString()
  notes?: string | null;

  @IsOptional()
  @IsString()
  enabledBy?: string | null;
}
