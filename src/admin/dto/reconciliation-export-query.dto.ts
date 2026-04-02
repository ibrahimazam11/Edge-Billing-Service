import { IsISO8601 } from "class-validator";

export class ReconciliationExportQueryDto {
  @IsISO8601()
  dateFrom!: string;

  @IsISO8601()
  dateTo!: string;
}
