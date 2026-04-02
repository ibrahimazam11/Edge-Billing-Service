import { GatewayModule } from "./gateway.module";
import { GatewayRegistry } from "./gateway.registry";
import { GatewayProvider } from "../common/enums/gateway-provider.enum";
import type { PaymentGateway } from "./gateway.interface";

describe("GatewayModule", () => {
  let registry: GatewayRegistry;
  let mockStripeAdapter: PaymentGateway;
  let mockAdyenAdapter: PaymentGateway;

  const buildMockAdapter = (): PaymentGateway =>
    ({
      createCustomer: jest.fn(),
      updateCustomer: jest.fn(),
      getCustomer: jest.fn(),
      attachPaymentMethod: jest.fn(),
      detachPaymentMethod: jest.fn(),
      setDefaultPaymentMethod: jest.fn(),
      createCharge: jest.fn(),
      createRefund: jest.fn(),
      listPaymentMethods: jest.fn(),
      getBalanceTransactions: jest.fn(),
      verifyAndParseWebhook: jest.fn(),
    }) as PaymentGateway;

  beforeEach(() => {
    registry = new GatewayRegistry();
    mockStripeAdapter = buildMockAdapter();
    mockAdyenAdapter = buildMockAdapter();
  });

  describe("onModuleInit", () => {
    it("should register Stripe adapter in the registry", () => {
      const module = new GatewayModule(mockStripeAdapter, registry);
      const registerSpy = jest.spyOn(registry, "registerAdapter");

      module.onModuleInit();

      expect(registerSpy).toHaveBeenCalledWith(
        GatewayProvider.Stripe,
        mockStripeAdapter,
      );
    });

    it("should register the exact injected Stripe adapter instance", () => {
      const module = new GatewayModule(mockStripeAdapter, registry);

      module.onModuleInit();

      const result = registry.getAdapter(GatewayProvider.Stripe);
      expect(result).toBe(mockStripeAdapter);
    });

    it("should not register Adyen adapter when not provided", () => {
      const module = new GatewayModule(mockStripeAdapter, registry);

      module.onModuleInit();

      const providers = registry.listProviders();
      expect(providers).toEqual([GatewayProvider.Stripe]);
      expect(providers).not.toContain(GatewayProvider.Adyen);
    });

    it("should not register Adyen adapter when null (no Adyen config)", () => {
      const module = new GatewayModule(mockStripeAdapter, registry, null);

      module.onModuleInit();

      const providers = registry.listProviders();
      expect(providers).toEqual([GatewayProvider.Stripe]);
      expect(providers).not.toContain(GatewayProvider.Adyen);
    });

    it("should register Adyen adapter when provided", () => {
      const module = new GatewayModule(
        mockStripeAdapter,
        registry,
        mockAdyenAdapter,
      );
      const registerSpy = jest.spyOn(registry, "registerAdapter");

      module.onModuleInit();

      expect(registerSpy).toHaveBeenCalledWith(
        GatewayProvider.Adyen,
        mockAdyenAdapter,
      );
    });

    it("should register the exact injected Adyen adapter instance", () => {
      const module = new GatewayModule(
        mockStripeAdapter,
        registry,
        mockAdyenAdapter,
      );

      module.onModuleInit();

      const result = registry.getAdapter(GatewayProvider.Adyen);
      expect(result).toBe(mockAdyenAdapter);
    });

    it("should list both providers when both configured", () => {
      const module = new GatewayModule(
        mockStripeAdapter,
        registry,
        mockAdyenAdapter,
      );

      module.onModuleInit();

      const providers = registry.listProviders();
      expect(providers).toEqual([
        GatewayProvider.Stripe,
        GatewayProvider.Adyen,
      ]);
    });
  });
});
