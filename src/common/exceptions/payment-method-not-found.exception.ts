import { HttpStatus } from "@nestjs/common";
import { BillingException } from "./billing.exception";

export class PaymentMethodNotFoundException extends BillingException {
  constructor(paymentMethodId: string) {
    super(`Payment method not found: ${paymentMethodId}`, HttpStatus.NOT_FOUND);
  }
}
