import { IsIn, IsString } from "class-validator";
import { DISPUTE_STATUSES } from "./dispute-status.constants";

export class UpdateDisputeStatusDto {
  @IsString()
  @IsIn([...DISPUTE_STATUSES])
  status!: string;
}
