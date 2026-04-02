import { IsOptional, IsString, IsEnum, MaxLength } from "class-validator";
import { PaginationDto } from "../../common/dto/pagination.dto";
import { CustomerStatus } from "../../customers/dto/customer-query.dto";

export class CustomerSearchQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalId?: string;

  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;
}
