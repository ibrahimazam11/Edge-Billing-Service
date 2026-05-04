import { IsArray, ArrayMinSize, ArrayMaxSize, IsNumber } from "class-validator";

export class VerifyMicrodepositsDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  amounts!: [number, number];
}
