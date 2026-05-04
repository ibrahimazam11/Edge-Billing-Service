import { IsString, IsNotEmpty, IsIn, IsOptional } from "class-validator";

export class CreateBankAccountSetupDto {
  @IsString()
  @IsNotEmpty()
  routingNumber!: string;

  @IsString()
  @IsNotEmpty()
  accountNumber!: string;

  @IsString()
  @IsIn(["individual", "company"])
  accountHolderType!: "individual" | "company";

  @IsString()
  @IsIn(["checking", "savings"])
  accountType!: "checking" | "savings";

  @IsString()
  @IsOptional()
  accountHolderName?: string;
}
