import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class AdvanceCycleRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  monolithCustomerId!: string;
}
