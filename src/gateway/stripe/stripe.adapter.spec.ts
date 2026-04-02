import { ConfigService } from "@nestjs/config";
import Stripe from "stripe";
import { StripeAdapter } from "./stripe.adapter";
import { CircuitBreakerService } from "../circuit-breaker/circuit-breaker.service";
import { PaymentFailedException } from "../../common/exceptions/payment-failed.exception";
import { GatewayUnavailableException } from "../../common/exceptions/gateway-unavailable.exception";
import { WebhookVerificationException } from "../../common/exceptions/webhook-verification.exception";
import { GatewayProvider } from "../../common/enums/gateway-provider.enum";

// Mock the stripe module
jest.mock("stripe", () => {
  const mockStripeInstance = {
    customers: {
      create: jest.fn(),
      update: jest.fn(),
      retrieve: jest.fn(),
    },
    paymentMethods: {
      attach: jest.fn(),
      detach: jest.fn(),
      list: jest.fn(),
    },
    paymentIntents: {
      create: jest.fn(),
    },
    refunds: {
      create: jest.fn(),
    },
    balanceTransactions: {
      list: jest.fn(),
    },
    webhooks: {
      constructEvent: jest.fn(),
    },
  };

  const StripeMock = jest.fn(
    () => mockStripeInstance,
  ) as unknown as jest.Mock & {
    errors: typeof Stripe.errors;
  };
  StripeMock.errors = jest.requireActual("stripe").errors;
  return { __esModule: true, default: StripeMock };
});

describe("StripeAdapter", () => {
  let adapter: StripeAdapter;
  let mockStripeInstance: {
    customers: { create: jest.Mock; update: jest.Mock; retrieve: jest.Mock };
    paymentMethods: { attach: jest.Mock; detach: jest.Mock; list: jest.Mock };
    paymentIntents: { create: jest.Mock };
    refunds: { create: jest.Mock };
    balanceTransactions: { list: jest.Mock };
    webhooks: { constructEvent: jest.Mock };
  };
  let mockCircuitBreaker: CircuitBreakerService;
  let mockConfigService: ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, string> = {
          "stripe.secretKey": "sk_test_123",
          "stripe.apiVersion": "2026-01-28.clover",
          "stripe.apiBaseUrl": "",
          "stripe.webhookSecret": "whsec_test_123",
        };
        return config[key];
      }),
    } as unknown as ConfigService;

    mockCircuitBreaker = {
      fire: jest.fn((action: () => Promise<unknown>) => action()),
    } as unknown as CircuitBreakerService;

    adapter = new StripeAdapter(mockConfigService, mockCircuitBreaker);

    // Get the mock stripe instance
    const calls = (Stripe as unknown as jest.Mock).mock.results;
    mockStripeInstance = calls[calls.length - 1].value;
  });

  const makeStripeCustomer = (
    overrides: Partial<Stripe.Customer> = {},
  ): Stripe.Customer =>
    ({
      id: "cus_123",
      object: "customer",
      email: "test@example.com",
      name: "Test User",
      metadata: { tenantId: "tenant-1" },
      created: 1700000000,
      ...overrides,
    }) as Stripe.Customer;

  const makeStripePaymentMethod = (
    overrides: Partial<Stripe.PaymentMethod> = {},
  ): Stripe.PaymentMethod =>
    ({
      id: "pm_123",
      object: "payment_method",
      customer: "cus_123",
      type: "card",
      card: {
        last4: "4242",
        brand: "visa",
        exp_month: 12,
        exp_year: 2027,
      },
      ...overrides,
    }) as Stripe.PaymentMethod;

  const makeStripePaymentIntent = (
    overrides: Partial<Stripe.PaymentIntent> = {},
  ): Stripe.PaymentIntent =>
    ({
      id: "pi_123",
      object: "payment_intent",
      amount: 5000,
      currency: "usd",
      status: "succeeded",
      customer: "cus_123",
      payment_method: "pm_123",
      last_payment_error: null,
      metadata: {},
      created: 1700000000,
      ...overrides,
    }) as Stripe.PaymentIntent;

  const makeStripeRefund = (
    overrides: Partial<Stripe.Refund> = {},
  ): Stripe.Refund =>
    ({
      id: "re_123",
      object: "refund",
      charge: "pi_123",
      amount: 5000,
      currency: "usd",
      status: "succeeded",
      reason: null,
      created: 1700000000,
      ...overrides,
    }) as Stripe.Refund;

  const makeStripeBalanceTransaction = (
    overrides: Partial<Stripe.BalanceTransaction> = {},
  ): Stripe.BalanceTransaction =>
    ({
      id: "txn_123",
      object: "balance_transaction",
      amount: 5000,
      currency: "usd",
      type: "charge",
      fee: 175,
      net: 4825,
      source: "pi_123",
      description: "Payment for invoice",
      created: 1700000000,
      ...overrides,
    }) as Stripe.BalanceTransaction;

  describe("createCustomer", () => {
    it("should create a customer and return domain result", async () => {
      mockStripeInstance.customers.create.mockResolvedValue(
        makeStripeCustomer(),
      );

      const result = await adapter.createCustomer({
        email: "test@example.com",
        name: "Test User",
        metadata: { tenantId: "tenant-1" },
      });

      expect(result).toEqual({
        id: "cus_123",
        email: "test@example.com",
        name: "Test User",
        metadata: { tenantId: "tenant-1" },
        createdAt: new Date(1700000000 * 1000),
        defaultPaymentMethodId: null,
      });
      expect(mockStripeInstance.customers.create).toHaveBeenCalledWith({
        email: "test@example.com",
        name: "Test User",
        metadata: { tenantId: "tenant-1" },
      });
    });

    it("should throw PaymentFailedException on Stripe 4xx error", async () => {
      mockStripeInstance.customers.create.mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          message: "Invalid email",
          type: "invalid_request_error",
        }),
      );

      await expect(adapter.createCustomer({ email: "bad" })).rejects.toThrow(
        PaymentFailedException,
      );
    });
  });

  describe("updateCustomer", () => {
    it("should update a customer and return domain result", async () => {
      mockStripeInstance.customers.update.mockResolvedValue(
        makeStripeCustomer({ name: "Updated User" }),
      );

      const result = await adapter.updateCustomer("cus_123", {
        name: "Updated User",
      });

      expect(result.name).toBe("Updated User");
      expect(mockStripeInstance.customers.update).toHaveBeenCalledWith(
        "cus_123",
        { name: "Updated User", email: undefined, metadata: undefined },
      );
    });
  });

  describe("getCustomer", () => {
    it("should retrieve a customer and return domain result", async () => {
      mockStripeInstance.customers.retrieve.mockResolvedValue(
        makeStripeCustomer(),
      );

      const result = await adapter.getCustomer("cus_123");

      expect(result).toEqual({
        id: "cus_123",
        email: "test@example.com",
        name: "Test User",
        metadata: { tenantId: "tenant-1" },
        createdAt: new Date(1700000000 * 1000),
        defaultPaymentMethodId: null,
      });
      expect(mockStripeInstance.customers.retrieve).toHaveBeenCalledWith(
        "cus_123",
      );
    });

    it("should return defaultPaymentMethodId from invoice_settings", async () => {
      mockStripeInstance.customers.retrieve.mockResolvedValue(
        makeStripeCustomer({
          invoice_settings: {
            default_payment_method: "pm_default_123",
          } as Stripe.Customer.InvoiceSettings,
        }),
      );

      const result = await adapter.getCustomer("cus_123");

      expect(result.defaultPaymentMethodId).toBe("pm_default_123");
    });

    it("should throw PaymentFailedException when customer is deleted without double-wrapping", async () => {
      mockStripeInstance.customers.retrieve.mockResolvedValue({
        ...makeStripeCustomer(),
        deleted: true,
      });

      await expect(adapter.getCustomer("cus_123")).rejects.toThrow(
        PaymentFailedException,
      );
      // Regression test for M2: verify exact message, not double-wrapped as
      // "Payment operation failed: Stripe customer not found: cus_123"
      const error = await adapter
        .getCustomer("cus_123")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PaymentFailedException);
      expect((error as Error).message).toBe(
        "Stripe customer not found: cus_123",
      );
    });

    it("should throw PaymentFailedException for 404 resource_missing", async () => {
      const notFoundError = new Stripe.errors.StripeInvalidRequestError({
        message: "No such customer: 'cus_invalid'",
        type: "invalid_request_error",
      });
      Object.defineProperty(notFoundError, "code", {
        value: "resource_missing",
      });

      mockStripeInstance.customers.retrieve.mockRejectedValue(notFoundError);

      await expect(adapter.getCustomer("cus_invalid")).rejects.toThrow(
        PaymentFailedException,
      );
    });

    it("should retry on 5xx errors and succeed", async () => {
      jest
        .spyOn(adapter as never, "sleep" as never)
        .mockResolvedValue(undefined as never);

      const serverError = new Stripe.errors.StripeAPIError({
        message: "Server error",
        type: "api_error",
      });
      Object.defineProperty(serverError, "statusCode", { value: 500 });

      mockStripeInstance.customers.retrieve
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce(makeStripeCustomer());

      const result = await adapter.getCustomer("cus_123");

      expect(result.id).toBe("cus_123");
      expect(mockStripeInstance.customers.retrieve).toHaveBeenCalledTimes(2);
    });
  });

  describe("attachPaymentMethod", () => {
    it("should attach payment method and return domain result", async () => {
      mockStripeInstance.paymentMethods.attach.mockResolvedValue(
        makeStripePaymentMethod(),
      );

      const result = await adapter.attachPaymentMethod("pm_123", "cus_123");

      expect(result).toEqual({
        id: "pm_123",
        customerId: "cus_123",
        type: "card",
        last4: "4242",
        brand: "visa",
        bankName: null,
        expiryMonth: 12,
        expiryYear: 2027,
        isDefault: false,
      });
    });
  });

  describe("detachPaymentMethod", () => {
    it("should detach payment method and return domain result", async () => {
      mockStripeInstance.paymentMethods.detach.mockResolvedValue(
        makeStripePaymentMethod({ customer: null }),
      );

      const result = await adapter.detachPaymentMethod("pm_123");

      expect(result.id).toBe("pm_123");
      expect(mockStripeInstance.paymentMethods.detach).toHaveBeenCalledWith(
        "pm_123",
      );
    });
  });

  describe("setDefaultPaymentMethod", () => {
    it("should set default payment method on customer", async () => {
      mockStripeInstance.customers.update.mockResolvedValue(
        makeStripeCustomer(),
      );

      const result = await adapter.setDefaultPaymentMethod("cus_123", "pm_456");

      expect(result.id).toBe("cus_123");
      expect(mockStripeInstance.customers.update).toHaveBeenCalledWith(
        "cus_123",
        { invoice_settings: { default_payment_method: "pm_456" } },
      );
    });
  });

  describe("listPaymentMethods", () => {
    it("should list payment methods and return domain results", async () => {
      mockStripeInstance.paymentMethods.list.mockResolvedValue({
        data: [
          makeStripePaymentMethod(),
          makeStripePaymentMethod({
            id: "pm_456",
            type: "card",
            card: {
              last4: "1234",
              brand: "mastercard",
              exp_month: 6,
              exp_year: 2028,
            } as Stripe.PaymentMethod.Card,
          }),
        ],
        has_more: false,
      });

      const result = await adapter.listPaymentMethods("cus_123");

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: "pm_123",
        customerId: "cus_123",
        type: "card",
        last4: "4242",
        brand: "visa",
        bankName: null,
        expiryMonth: 12,
        expiryYear: 2027,
        isDefault: false,
      });
      expect(result[1]?.id).toBe("pm_456");
      expect(mockStripeInstance.paymentMethods.list).toHaveBeenCalledWith({
        customer: "cus_123",
        limit: 100,
      });
    });

    it("should return empty array when no payment methods exist", async () => {
      mockStripeInstance.paymentMethods.list.mockResolvedValue({
        data: [],
        has_more: false,
      });

      const result = await adapter.listPaymentMethods("cus_123");

      expect(result).toEqual([]);
    });
  });

  describe("createCharge", () => {
    it("should create a payment intent and return domain charge result", async () => {
      mockStripeInstance.paymentIntents.create.mockResolvedValue(
        makeStripePaymentIntent(),
      );

      const result = await adapter.createCharge({
        amount: 5000,
        currency: "usd",
        customerId: "cus_123",
        paymentMethodId: "pm_123",
      });

      expect(result).toEqual({
        id: "pi_123",
        amount: 5000,
        currency: "usd",
        status: "succeeded",
        customerId: "cus_123",
        paymentMethodId: "pm_123",
        failureCode: null,
        failureMessage: null,
        metadata: {},
        createdAt: new Date(1700000000 * 1000),
      });
    });

    it("should pass idempotencyKey when provided", async () => {
      mockStripeInstance.paymentIntents.create.mockResolvedValue(
        makeStripePaymentIntent(),
      );

      await adapter.createCharge({
        amount: 1000,
        currency: "usd",
        customerId: "cus_123",
        paymentMethodId: "pm_123",
        idempotencyKey: "idk_123",
      });

      expect(mockStripeInstance.paymentIntents.create).toHaveBeenCalledWith(
        expect.any(Object),
        { idempotencyKey: "idk_123" },
      );
    });

    it("should map failed payment intent status", async () => {
      mockStripeInstance.paymentIntents.create.mockResolvedValue(
        makeStripePaymentIntent({
          status: "canceled",
          last_payment_error: {
            code: "card_declined",
            message: "Card was declined",
          } as Stripe.PaymentIntent.LastPaymentError,
        }),
      );

      const result = await adapter.createCharge({
        amount: 5000,
        currency: "usd",
        customerId: "cus_123",
        paymentMethodId: "pm_123",
      });

      expect(result.status).toBe("failed");
      expect(result.failureCode).toBe("card_declined");
      expect(result.failureMessage).toBe("Card was declined");
    });
  });

  describe("createRefund", () => {
    it("should create a refund and return domain result", async () => {
      mockStripeInstance.refunds.create.mockResolvedValue(makeStripeRefund());

      const result = await adapter.createRefund({ chargeId: "pi_123" });

      expect(result).toEqual({
        id: "re_123",
        chargeId: "pi_123",
        amount: 5000,
        currency: "usd",
        status: "succeeded",
        reason: null,
        createdAt: new Date(1700000000 * 1000),
      });
    });
  });

  describe("getBalanceTransactions", () => {
    it("should return list of balance transactions", async () => {
      mockStripeInstance.balanceTransactions.list.mockResolvedValue({
        data: [makeStripeBalanceTransaction()],
        has_more: false,
      });

      const result = await adapter.getBalanceTransactions({ limit: 5 });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "txn_123",
        amount: 5000,
        currency: "usd",
        type: "charge",
        fee: 175,
        net: 4825,
        source: "pi_123",
        description: "Payment for invoice",
        createdAt: new Date(1700000000 * 1000),
      });
    });

    it("should pass date filter to Stripe API", async () => {
      mockStripeInstance.balanceTransactions.list.mockResolvedValue({
        data: [makeStripeBalanceTransaction()],
        has_more: false,
      });

      await adapter.getBalanceTransactions({
        createdGte: 1700000000,
        createdLte: 1700086400,
      });

      expect(mockStripeInstance.balanceTransactions.list).toHaveBeenCalledWith(
        expect.objectContaining({
          created: { gte: 1700000000, lte: 1700086400 },
        }),
      );
    });

    it("should paginate through all pages", async () => {
      mockStripeInstance.balanceTransactions.list
        .mockResolvedValueOnce({
          data: [makeStripeBalanceTransaction({ id: "txn_1" })],
          has_more: true,
        })
        .mockResolvedValueOnce({
          data: [makeStripeBalanceTransaction({ id: "txn_2" })],
          has_more: false,
        });

      const result = await adapter.getBalanceTransactions({ limit: 1 });

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("txn_1");
      expect(result[1].id).toBe("txn_2");
      expect(mockStripeInstance.balanceTransactions.list).toHaveBeenCalledTimes(
        2,
      );
      expect(
        mockStripeInstance.balanceTransactions.list,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({ starting_after: "txn_1" }),
      );
    });

    it("should pass createdLt (exclusive) filter to Stripe API", async () => {
      mockStripeInstance.balanceTransactions.list.mockResolvedValue({
        data: [makeStripeBalanceTransaction()],
        has_more: false,
      });

      await adapter.getBalanceTransactions({
        createdGte: 1700000000,
        createdLt: 1700086400,
      });

      expect(mockStripeInstance.balanceTransactions.list).toHaveBeenCalledWith(
        expect.objectContaining({
          created: { gte: 1700000000, lt: 1700086400 },
        }),
      );
    });

    it("should use default limit of 100 when not specified", async () => {
      mockStripeInstance.balanceTransactions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });

      await adapter.getBalanceTransactions();

      expect(mockStripeInstance.balanceTransactions.list).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });
  });

  describe("error handling", () => {
    beforeEach(() => {
      jest
        .spyOn(adapter as never, "sleep" as never)
        .mockResolvedValue(undefined as never);
    });

    it("should wrap Stripe 4xx errors as PaymentFailedException", async () => {
      mockStripeInstance.customers.create.mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          message: "No such customer",
          type: "invalid_request_error",
        }),
      );

      await expect(
        adapter.createCustomer({ email: "test@test.com" }),
      ).rejects.toThrow(PaymentFailedException);
    });

    it("should wrap Stripe 5xx errors as GatewayUnavailableException after retries", async () => {
      const serverError = new Stripe.errors.StripeAPIError({
        message: "Internal server error",
        type: "api_error",
      });
      Object.defineProperty(serverError, "statusCode", { value: 500 });

      mockStripeInstance.customers.create.mockRejectedValue(serverError);

      await expect(
        adapter.createCustomer({ email: "test@test.com" }),
      ).rejects.toThrow(GatewayUnavailableException);

      // Should have retried 3 times
      expect(mockStripeInstance.customers.create).toHaveBeenCalledTimes(3);
    });

    it("should wrap circuit breaker open errors as GatewayUnavailableException", async () => {
      (mockCircuitBreaker.fire as jest.Mock).mockRejectedValue(
        new Error("Breaker is open"),
      );

      await expect(
        adapter.createCustomer({ email: "test@test.com" }),
      ).rejects.toThrow(GatewayUnavailableException);
    });

    it("should wrap timeout errors as GatewayUnavailableException", async () => {
      (mockCircuitBreaker.fire as jest.Mock).mockRejectedValue(
        new Error("Timed out after 10000ms"),
      );

      await expect(
        adapter.createCustomer({ email: "test@test.com" }),
      ).rejects.toThrow(GatewayUnavailableException);
    });
  });

  describe("retry behavior", () => {
    beforeEach(() => {
      // Mock sleep to avoid real delays in tests
      jest
        .spyOn(adapter as never, "sleep" as never)
        .mockResolvedValue(undefined as never);
    });

    it("should retry on 429 rate limit errors", async () => {
      const rateLimitError = new Stripe.errors.StripeRateLimitError({
        message: "Rate limit exceeded",
        type: "rate_limit_error",
      });
      Object.defineProperty(rateLimitError, "statusCode", { value: 429 });

      mockStripeInstance.customers.create
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(makeStripeCustomer());

      const result = await adapter.createCustomer({
        email: "test@example.com",
      });

      expect(result.id).toBe("cus_123");
      expect(mockStripeInstance.customers.create).toHaveBeenCalledTimes(2);
    });

    it("should not retry on 4xx errors (except 429)", async () => {
      mockStripeInstance.customers.create.mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          message: "Invalid request",
          type: "invalid_request_error",
        }),
      );

      await expect(adapter.createCustomer({ email: "bad" })).rejects.toThrow(
        PaymentFailedException,
      );

      // Should NOT have retried — only 1 call
      expect(mockStripeInstance.customers.create).toHaveBeenCalledTimes(1);
    });

    it("should retry on 5xx errors up to max retries", async () => {
      const serverError = new Stripe.errors.StripeAPIError({
        message: "Server error",
        type: "api_error",
      });
      Object.defineProperty(serverError, "statusCode", { value: 502 });

      mockStripeInstance.customers.create.mockRejectedValue(serverError);

      await expect(
        adapter.createCustomer({ email: "test@test.com" }),
      ).rejects.toThrow(GatewayUnavailableException);

      expect(mockStripeInstance.customers.create).toHaveBeenCalledTimes(3);
    });

    it("should succeed on retry after transient failure", async () => {
      const serverError = new Stripe.errors.StripeAPIError({
        message: "Server error",
        type: "api_error",
      });
      Object.defineProperty(serverError, "statusCode", { value: 500 });

      mockStripeInstance.customers.create
        .mockRejectedValueOnce(serverError)
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce(makeStripeCustomer());

      const result = await adapter.createCustomer({
        email: "test@example.com",
      });

      expect(result.id).toBe("cus_123");
      expect(mockStripeInstance.customers.create).toHaveBeenCalledTimes(3);
    });
  });

  describe("circuit breaker integration", () => {
    it("should route all calls through circuit breaker", async () => {
      mockStripeInstance.customers.create.mockResolvedValue(
        makeStripeCustomer(),
      );

      await adapter.createCustomer({ email: "test@example.com" });

      expect(mockCircuitBreaker.fire).toHaveBeenCalledTimes(1);
      expect(mockCircuitBreaker.fire).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });
  });

  describe("verifyAndParseWebhook", () => {
    const makeStripeEvent = (
      type: string,
      dataObject: Record<string, unknown> = {},
      overrides: Partial<Stripe.Event> = {},
    ): Stripe.Event =>
      ({
        id: "evt_test_123",
        object: "event",
        type,
        data: {
          object: {
            id: "pi_webhook_123",
            amount: 5000,
            currency: "usd",
            status: "succeeded",
            metadata: { invoiceId: "inv_123" },
            ...dataObject,
          },
        },
        ...overrides,
      }) as unknown as Stripe.Event;

    it("should return NormalizedWebhookEvent for payment_intent.succeeded", async () => {
      const event = makeStripeEvent("payment_intent.succeeded");
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      const result = await adapter.verifyAndParseWebhook("raw-payload", {
        "stripe-signature": "sig_test_123",
      });

      expect(result).toEqual({
        eventType: "payment.succeeded",
        gatewayProvider: GatewayProvider.Stripe,
        gatewayEventId: "evt_test_123",
        gatewayChargeId: "pi_webhook_123",
        amount: 5000,
        currency: "usd",
        status: "succeeded",
        metadata: { invoiceId: "inv_123" },
        receivedAt: expect.any(Date),
      });
    });

    it("should return NormalizedWebhookEvent for payment_intent.payment_failed", async () => {
      const event = makeStripeEvent("payment_intent.payment_failed", {
        status: "requires_payment_method",
        last_payment_error: {
          code: "card_declined",
          message: "Your card was declined",
        },
      });
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      const result = await adapter.verifyAndParseWebhook("raw-payload", {
        "stripe-signature": "sig_test_123",
      });

      expect(result).toEqual({
        eventType: "payment.failed",
        gatewayProvider: GatewayProvider.Stripe,
        gatewayEventId: "evt_test_123",
        gatewayChargeId: "pi_webhook_123",
        amount: 5000,
        currency: "usd",
        status: "requires_payment_method",
        metadata: {
          invoiceId: "inv_123",
          failureCode: "card_declined",
          failureMessage: "Your card was declined",
        },
        receivedAt: expect.any(Date),
      });
    });

    it("should return NormalizedWebhookEvent for charge.refunded", async () => {
      const event = makeStripeEvent("charge.refunded", {
        id: "ch_refund_123",
        amount: 2500,
        currency: "eur",
        status: "succeeded",
        metadata: {},
      });
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      const result = await adapter.verifyAndParseWebhook("raw-payload", {
        "stripe-signature": "sig_test_123",
      });

      expect(result).toEqual({
        eventType: "refund.completed",
        gatewayProvider: GatewayProvider.Stripe,
        gatewayEventId: "evt_test_123",
        gatewayChargeId: "ch_refund_123",
        amount: 2500,
        currency: "eur",
        status: "succeeded",
        metadata: {},
        receivedAt: expect.any(Date),
      });
    });

    it("should return null for unmapped event types", async () => {
      const event = makeStripeEvent("customer.updated");
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      const result = await adapter.verifyAndParseWebhook("raw-payload", {
        "stripe-signature": "sig_test_123",
      });

      expect(result).toBeNull();
    });

    it("should throw WebhookVerificationException on invalid signature", async () => {
      mockStripeInstance.webhooks.constructEvent.mockImplementation(() => {
        throw new Error("Invalid signature");
      });

      await expect(
        adapter.verifyAndParseWebhook("raw-payload", {
          "stripe-signature": "bad_sig",
        }),
      ).rejects.toThrow(WebhookVerificationException);

      await expect(
        adapter.verifyAndParseWebhook("raw-payload", {
          "stripe-signature": "bad_sig",
        }),
      ).rejects.toThrow("Stripe webhook signature verification failed");
    });

    it("should throw WebhookVerificationException when stripe-signature header is missing", async () => {
      await expect(
        adapter.verifyAndParseWebhook("raw-payload", {}),
      ).rejects.toThrow(WebhookVerificationException);

      await expect(
        adapter.verifyAndParseWebhook("raw-payload", {}),
      ).rejects.toThrow("Missing stripe-signature header");
    });

    it("should preserve amount in smallest unit (cents)", async () => {
      const event = makeStripeEvent("payment_intent.succeeded", {
        amount: 12345,
      });
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      const result = await adapter.verifyAndParseWebhook("raw-payload", {
        "stripe-signature": "sig_test_123",
      });

      expect(result!.amount).toBe(12345);
    });

    it("should return currency in lowercase ISO 4217", async () => {
      const event = makeStripeEvent("payment_intent.succeeded", {
        currency: "USD",
      });
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      const result = await adapter.verifyAndParseWebhook("raw-payload", {
        "stripe-signature": "sig_test_123",
      });

      expect(result!.currency).toBe("usd");
    });

    it("should set gatewayEventId to Stripe event ID", async () => {
      const event = makeStripeEvent("payment_intent.succeeded", {}, {
        id: "evt_unique_456",
      } as Partial<Stripe.Event>);
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      const result = await adapter.verifyAndParseWebhook("raw-payload", {
        "stripe-signature": "sig_test_123",
      });

      expect(result!.gatewayEventId).toBe("evt_unique_456");
    });

    it("should set gatewayChargeId to PaymentIntent ID from data.object", async () => {
      const event = makeStripeEvent("payment_intent.succeeded", {
        id: "pi_specific_789",
      });
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      const result = await adapter.verifyAndParseWebhook("raw-payload", {
        "stripe-signature": "sig_test_123",
      });

      expect(result!.gatewayChargeId).toBe("pi_specific_789");
    });

    it("should set receivedAt as a valid Date instance", async () => {
      const event = makeStripeEvent("payment_intent.succeeded");
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      const before = new Date();
      const result = await adapter.verifyAndParseWebhook("raw-payload", {
        "stripe-signature": "sig_test_123",
      });
      const after = new Date();

      expect(result!.receivedAt).toBeInstanceOf(Date);
      expect(result!.receivedAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect(result!.receivedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("should include metadata from Stripe event", async () => {
      const event = makeStripeEvent("payment_intent.succeeded", {
        metadata: { orderId: "order-42", source: "api" },
      });
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      const result = await adapter.verifyAndParseWebhook("raw-payload", {
        "stripe-signature": "sig_test_123",
      });

      expect(result!.metadata).toEqual({ orderId: "order-42", source: "api" });
    });

    it("should NOT call executeWithResilience for webhook verification", async () => {
      const event = makeStripeEvent("payment_intent.succeeded");
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      // Reset circuit breaker call count
      (mockCircuitBreaker.fire as jest.Mock).mockClear();

      await adapter.verifyAndParseWebhook("raw-payload", {
        "stripe-signature": "sig_test_123",
      });

      expect(mockCircuitBreaker.fire).not.toHaveBeenCalled();
    });

    it("should call constructEvent with correct arguments", async () => {
      const event = makeStripeEvent("payment_intent.succeeded");
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      await adapter.verifyAndParseWebhook("raw-payload-body", {
        "stripe-signature": "sig_header_value",
      });

      expect(mockStripeInstance.webhooks.constructEvent).toHaveBeenCalledWith(
        "raw-payload-body",
        "sig_header_value",
        "whsec_test_123",
      );
    });

    it("should default metadata to empty object when null", async () => {
      const event = makeStripeEvent("payment_intent.succeeded", {
        metadata: null,
      });
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      const result = await adapter.verifyAndParseWebhook("raw-payload", {
        "stripe-signature": "sig_test_123",
      });

      expect(result!.metadata).toEqual({});
    });
  });
});
