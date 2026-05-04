import {
  IsUUID,
  IsNotEmpty,
  IsInt,
  NotEquals,
  IsString,
  IsOptional,
} from "class-validator";

export class IssueCreditNoteDto {
  @IsUUID()
  @IsNotEmpty()
  customerId!: string;

  @IsOptional()
  @IsUUID()
  invoiceId?: string;

  // Negative values represent a credit-balance reduction (set-balance flow from monolith).
  @IsInt()
  @NotEquals(0)
  amountCents!: number;

  @IsString()
  @IsNotEmpty()
  reason!: string;

  @IsOptional()
  @IsString()
  createdBy?: string;
}
