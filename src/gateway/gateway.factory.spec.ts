import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PAYMENT_GATEWAY } from "./gateway.interface";
import type { PaymentGateway } from "./gateway.interface";
import { CircuitBreakerService } from "./circuit-breaker/circuit-breaker.service";
import { paymentGatewayProvider } from "./gateway.factory";
import { StripeAdapter } from "./stripe/stripe.adapter";

jest.mock("stripe", () => {
  const mockStripeInstance = {
    customers: { create: jest.fn(), update: jest.fn() },
    paymentMethods: { attach: jest.fn(), detach: jest.fn() },
    paymentIntents: { create: jest.fn() },
    refunds: { create: jest.fn() },
    balanceTransactions: { list: jest.fn() },
    webhooks: { constructEvent: jest.fn() },
  };
  return { __esModule: true, default: jest.fn(() => mockStripeInstance) };
});

describe("Gateway Factory", () => {
  let gateway: PaymentGateway;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, string> = {
                "stripe.secretKey": "sk_test_123",
                "stripe.apiVersion": "2026-01-28.clover",
                "stripe.webhookSecret": "whsec_test_123",
                "stripe.apiBaseUrl": "",
              };
              return config[key];
            }),
          },
        },
        CircuitBreakerService,
        paymentGatewayProvider,
      ],
    }).compile();

    gateway = module.get<PaymentGateway>(PAYMENT_GATEWAY);
  });

  it("should resolve PAYMENT_GATEWAY token to StripeAdapter", () => {
    expect(gateway).toBeDefined();
    expect(gateway).toBeInstanceOf(StripeAdapter);
  });

  it("should provide an instance with all PaymentGateway methods", () => {
    expect(typeof gateway.createCustomer).toBe("function");
    expect(typeof gateway.updateCustomer).toBe("function");
    expect(typeof gateway.attachPaymentMethod).toBe("function");
    expect(typeof gateway.detachPaymentMethod).toBe("function");
    expect(typeof gateway.setDefaultPaymentMethod).toBe("function");
    expect(typeof gateway.createCharge).toBe("function");
    expect(typeof gateway.createRefund).toBe("function");
    expect(typeof gateway.getBalanceTransactions).toBe("function");
  });

  it("should be injectable via PAYMENT_GATEWAY symbol token", () => {
    // The fact that module.get() succeeded proves injectability
    expect(gateway).toBeTruthy();
  });
});
