import { HttpStatus } from "@nestjs/common";
import { BillingException } from "./billing.exception";

export class CustomerNotFoundException extends BillingException {
  constructor(customerId: string) {
    super(`Customer not found: ${customerId}`, HttpStatus.NOT_FOUND);
  }
}
