import { IsOptional, IsEnum } from "class-validator";
import { PaginationDto } from "../../common/dto/pagination.dto";

export enum CustomerStatus {
  ACTIVE = "active",
  INACTIVE = "inactive",
}

export class CustomerQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;
}
