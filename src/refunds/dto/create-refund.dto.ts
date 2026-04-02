import {
  IsUUID,
  IsInt,
  Min,
  IsString,
  IsNotEmpty,
  IsOptional,
} from "class-validator";

export interface CreateRefundInput {
  chargeId: string;
  amountCents: number;
  reason: string;
  customerId?: string;
}

export class CreateRefundDto implements CreateRefundInput {
  @IsUUID()
  @IsNotEmpty()
  chargeId!: string;

  @IsInt()
  @Min(1)
  amountCents!: number;

  @IsString()
  @IsNotEmpty()
  reason!: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;
}
