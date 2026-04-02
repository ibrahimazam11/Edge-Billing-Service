import {
  IsUUID,
  IsNotEmpty,
  IsInt,
  Min,
  IsString,
  IsDateString,
} from "class-validator";

export class CreateOnboardingChargeDto {
  @IsUUID()
  @IsNotEmpty()
  customerId!: string;

  @IsInt()
  @Min(1)
  amountCents!: number;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsDateString()
  @IsNotEmpty()
  scheduledDate!: string;
}
