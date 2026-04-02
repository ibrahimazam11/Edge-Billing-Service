import { FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PAYMENT_GATEWAY } from "./gateway.interface";
import { StripeAdapter } from "./stripe/stripe.adapter";
import { CircuitBreakerService } from "./circuit-breaker/circuit-breaker.service";

export const paymentGatewayProvider: FactoryProvider = {
  provide: PAYMENT_GATEWAY,
  useFactory: (
    configService: ConfigService,
    circuitBreaker: CircuitBreakerService,
  ) => {
    return new StripeAdapter(configService, circuitBreaker);
  },
  inject: [ConfigService, CircuitBreakerService],
};
