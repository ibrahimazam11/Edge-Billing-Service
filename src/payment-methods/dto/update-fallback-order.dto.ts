import { IsInt, Min, ValidateIf } from "class-validator";

export class UpdateFallbackOrderDto {
  @ValidateIf((_o, value) => value !== null)
  @IsInt()
  @Min(0)
  fallbackOrder!: number | null;
}
