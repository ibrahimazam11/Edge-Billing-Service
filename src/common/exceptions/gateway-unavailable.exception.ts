import { HttpStatus } from "@nestjs/common";
import { BillingException } from "./billing.exception";

export class GatewayUnavailableException extends BillingException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, HttpStatus.SERVICE_UNAVAILABLE, details);
  }
}
