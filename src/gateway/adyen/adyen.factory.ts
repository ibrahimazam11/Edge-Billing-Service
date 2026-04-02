import { FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdyenAdapter } from "./adyen.adapter";
import { CircuitBreakerService } from "../circuit-breaker/circuit-breaker.service";

export const ADYEN_GATEWAY = Symbol("ADYEN_GATEWAY");

export const adyenGatewayProvider: FactoryProvider = {
  provide: ADYEN_GATEWAY,
  useFactory: (
    configService: ConfigService,
    circuitBreaker: CircuitBreakerService,
  ) => {
    const apiKey = configService.get<string>("adyen.apiKey");
    if (!apiKey) {
      return null;
    }
    return new AdyenAdapter(configService, circuitBreaker);
  },
  inject: [ConfigService, CircuitBreakerService],
};
