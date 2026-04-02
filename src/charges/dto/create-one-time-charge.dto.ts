import {
  IsUUID,
  IsNotEmpty,
  IsInt,
  Min,
  IsString,
  IsOptional,
} from "class-validator";

export class CreateOneTimeChargeDto {
  @IsUUID()
  @IsNotEmpty()
  customerId!: string;

  @IsInt()
  @Min(1)
  amountCents!: number;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsOptional()
  @IsUUID()
  paymentMethodId?: string;
}
