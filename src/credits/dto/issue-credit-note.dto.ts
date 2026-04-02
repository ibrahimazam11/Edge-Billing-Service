import {
  IsUUID,
  IsNotEmpty,
  IsInt,
  Min,
  IsString,
  IsOptional,
} from "class-validator";

export class IssueCreditNoteDto {
  @IsUUID()
  @IsNotEmpty()
  customerId!: string;

  @IsUUID()
  @IsNotEmpty()
  invoiceId!: string;

  @IsInt()
  @Min(1)
  amountCents!: number;

  @IsString()
  @IsNotEmpty()
  reason!: string;

  @IsOptional()
  @IsString()
  createdBy?: string;
}
