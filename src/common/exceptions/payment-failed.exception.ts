import { HttpStatus } from "@nestjs/common";
import { BillingException } from "./billing.exception";

export class PaymentFailedException extends BillingException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
}
