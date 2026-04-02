import { HttpStatus } from "@nestjs/common";
import { BillingException } from "./billing.exception";

export class SubscriptionNotFoundException extends BillingException {
  constructor(subscriptionId: string) {
    super(`Subscription not found: ${subscriptionId}`, HttpStatus.NOT_FOUND);
  }
}
