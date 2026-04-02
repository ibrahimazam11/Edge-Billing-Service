import { IsString, IsOptional, IsDateString, IsObject } from "class-validator";

export class CustomerResponseDto {
  @IsString()
  id!: string;

  @IsString()
  monolithCustomerId!: string;

  @IsOptional()
  @IsString()
  stripeCustomerId!: string | null;

  @IsString()
  name!: string;

  @IsString()
  email!: string;

  @IsString()
  status!: string;

  @IsOptional()
  @IsObject()
  metadata!: Record<string, unknown> | null;

  @IsDateString()
  createdAt!: string;

  @IsDateString()
  updatedAt!: string;
}
