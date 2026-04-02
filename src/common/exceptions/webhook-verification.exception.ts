import { HttpStatus } from "@nestjs/common";
import { BillingException } from "./billing.exception";

export class WebhookVerificationException extends BillingException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, HttpStatus.UNAUTHORIZED, details);
  }
}
