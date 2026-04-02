import { GatewayRegistry } from "./gateway.registry";
import { GatewayProvider } from "../common/enums/gateway-provider.enum";
import { GatewayNotAvailableException } from "../common/exceptions/gateway-not-available.exception";
import type { PaymentGateway } from "./gateway.interface";

describe("GatewayRegistry", () => {
  let registry: GatewayRegistry;
  let mockStripeAdapter: PaymentGateway;
  let mockAdyenAdapter: PaymentGateway;

  beforeEach(() => {
    registry = new GatewayRegistry();

    mockStripeAdapter = {
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
    } as PaymentGateway;

    mockAdyenAdapter = {
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
    } as PaymentGateway;
  });

  describe("registerAdapter", () => {
    it("should register an adapter for a provider", () => {
      registry.registerAdapter(GatewayProvider.Stripe, mockStripeAdapter);

      const result = registry.getAdapter(GatewayProvider.Stripe);
      expect(result).toBe(mockStripeAdapter);
    });

    it("should overwrite existing registration with new adapter", () => {
      const originalAdapter = mockStripeAdapter;
      const replacementAdapter = mockAdyenAdapter;

      registry.registerAdapter(GatewayProvider.Stripe, originalAdapter);
      registry.registerAdapter(GatewayProvider.Stripe, replacementAdapter);

      const result = registry.getAdapter(GatewayProvider.Stripe);
      expect(result).toBe(replacementAdapter);
      expect(result).not.toBe(originalAdapter);
    });
  });

  describe("getAdapter", () => {
    it("should return the exact registered adapter instance", () => {
      registry.registerAdapter(GatewayProvider.Stripe, mockStripeAdapter);

      const result = registry.getAdapter(GatewayProvider.Stripe);
      expect(result).toBe(mockStripeAdapter);
    });

    it("should throw GatewayNotAvailableException for unregistered provider", () => {
      expect(() => registry.getAdapter(GatewayProvider.Adyen)).toThrow(
        GatewayNotAvailableException,
      );
    });

    it("should throw with message containing the provider name", () => {
      expect(() => registry.getAdapter(GatewayProvider.Adyen)).toThrow(
        "Gateway provider 'adyen' is not available",
      );
    });

    it("should throw with HTTP status 503 (Service Unavailable)", () => {
      try {
        registry.getAdapter(GatewayProvider.Adyen);
        throw new Error("Expected GatewayNotAvailableException");
      } catch (error) {
        expect(error).toBeInstanceOf(GatewayNotAvailableException);
        expect((error as GatewayNotAvailableException).getStatus()).toBe(503);
      }
    });

    it("should return correct adapter when multiple providers are registered", () => {
      registry.registerAdapter(GatewayProvider.Stripe, mockStripeAdapter);
      registry.registerAdapter(GatewayProvider.Adyen, mockAdyenAdapter);

      expect(registry.getAdapter(GatewayProvider.Stripe)).toBe(
        mockStripeAdapter,
      );
      expect(registry.getAdapter(GatewayProvider.Adyen)).toBe(mockAdyenAdapter);
    });

    it("should not return Adyen adapter when requesting Stripe", () => {
      registry.registerAdapter(GatewayProvider.Stripe, mockStripeAdapter);
      registry.registerAdapter(GatewayProvider.Adyen, mockAdyenAdapter);

      const result = registry.getAdapter(GatewayProvider.Stripe);
      expect(result).not.toBe(mockAdyenAdapter);
    });
  });

  describe("listProviders", () => {
    it("should return empty array when no adapters registered", () => {
      const result = registry.listProviders();
      expect(result).toEqual([]);
    });

    it("should return only registered providers", () => {
      registry.registerAdapter(GatewayProvider.Stripe, mockStripeAdapter);

      const result = registry.listProviders();
      expect(result).toEqual([GatewayProvider.Stripe]);
    });

    it("should return all registered providers", () => {
      registry.registerAdapter(GatewayProvider.Stripe, mockStripeAdapter);
      registry.registerAdapter(GatewayProvider.Adyen, mockAdyenAdapter);

      const result = registry.listProviders();
      expect(result).toEqual([GatewayProvider.Stripe, GatewayProvider.Adyen]);
    });

    it("should not include unregistered providers", () => {
      registry.registerAdapter(GatewayProvider.Stripe, mockStripeAdapter);

      const result = registry.listProviders();
      expect(result).not.toContain(GatewayProvider.Adyen);
    });
  });
});
