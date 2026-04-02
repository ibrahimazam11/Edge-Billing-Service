import { IsISO8601 } from "class-validator";

export class RevenueQueryDto {
  @IsISO8601()
  startDate!: string;

  @IsISO8601()
  endDate!: string;
}
