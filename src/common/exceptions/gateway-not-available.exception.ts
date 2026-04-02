import { HttpStatus } from "@nestjs/common";
import { BillingException } from "./billing.exception";
import { GatewayProvider } from "../enums/gateway-provider.enum";

export class GatewayNotAvailableException extends BillingException {
  constructor(provider: GatewayProvider) {
    super(
      `Gateway provider '${provider}' is not available`,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
