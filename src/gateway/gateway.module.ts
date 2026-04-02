import { Inject, Module, Optional, type OnModuleInit } from "@nestjs/common";
import { CircuitBreakerService } from "./circuit-breaker/circuit-breaker.service";
import { StripeWebhookService } from "./stripe/stripe.webhooks";
import { paymentGatewayProvider } from "./gateway.factory";
import { PAYMENT_GATEWAY } from "./gateway.interface";
import type { PaymentGateway } from "./gateway.interface";
import { GatewayRegistry } from "./gateway.registry";
import { GatewayProvider } from "../common/enums/gateway-provider.enum";
import { adyenGatewayProvider, ADYEN_GATEWAY } from "./adyen/adyen.factory";

@Module({
  providers: [
    CircuitBreakerService,
    StripeWebhookService,
    paymentGatewayProvider,
    adyenGatewayProvider,
    GatewayRegistry,
  ],
  exports: [PAYMENT_GATEWAY, StripeWebhookService, GatewayRegistry],
})
export class GatewayModule implements OnModuleInit {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly stripeAdapter: PaymentGateway,
    private readonly registry: GatewayRegistry,
    @Optional()
    @Inject(ADYEN_GATEWAY)
    private readonly adyenAdapter?: PaymentGateway | null,
  ) {}

  onModuleInit(): void {
    this.registry.registerAdapter(GatewayProvider.Stripe, this.stripeAdapter);
    if (this.adyenAdapter) {
      this.registry.registerAdapter(GatewayProvider.Adyen, this.adyenAdapter);
    }
  }
}
