import { IsString, IsNotEmpty } from "class-validator";

export class CreatePaymentMethodDto {
  @IsString()
  @IsNotEmpty()
  paymentMethodId!: string;
}
