import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class ResolveDiscrepancyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  resolutionNotes!: string;
}
