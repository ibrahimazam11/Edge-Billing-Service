import type { ChargeResponseDto } from "./charge-response.dto";
import type { InvoiceResponseDto } from "../../invoices/dto/invoice-response.dto";

export class OneTimeChargeResponseDto {
  charge!: ChargeResponseDto;
  invoice!: InvoiceResponseDto;
}
