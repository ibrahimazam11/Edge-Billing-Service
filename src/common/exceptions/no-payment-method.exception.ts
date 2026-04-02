import { HttpStatus } from "@nestjs/common";
import { BillingException } from "./billing.exception";

export class NoPaymentMethodException extends BillingException {
  constructor(customerId: string) {
    super(
      `Customer has no default active payment method: ${customerId}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      { errorCode: "CUSTOMER_NO_PAYMENT_METHOD" },
    );
  }
}
