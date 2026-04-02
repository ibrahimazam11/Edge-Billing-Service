import { Injectable } from "@nestjs/common";
import { GatewayProvider } from "../common/enums/gateway-provider.enum";
import { GatewayNotAvailableException } from "../common/exceptions/gateway-not-available.exception";
import type { PaymentGateway } from "./gateway.interface";

@Injectable()
export class GatewayRegistry {
  private readonly adapters = new Map<GatewayProvider, PaymentGateway>();

  registerAdapter(provider: GatewayProvider, adapter: PaymentGateway): void {
    this.adapters.set(provider, adapter);
  }

  getAdapter(provider: GatewayProvider): PaymentGateway {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new GatewayNotAvailableException(provider);
    }
    return adapter;
  }

  listProviders(): GatewayProvider[] {
    return [...this.adapters.keys()];
  }
}
