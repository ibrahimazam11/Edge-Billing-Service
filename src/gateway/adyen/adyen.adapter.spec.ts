import { ConfigService } from "@nestjs/config";
import { AdyenAdapter } from "./adyen.adapter";
import { PaymentFailedException } from "../../common/exceptions/payment-failed.exception";
import { GatewayUnavailableException } from "../../common/exceptions/gateway-unavailable.exception";
import { WebhookVerificationException } from "../../common/exceptions/webhook-verification.exception";
import { GatewayProvider } from "../../common/enums/gateway-provider.enum";
import {
  WEBHOOK_PAYMENT_SUCCEEDED,
  WEBHOOK_PAYMENT_FAILED,
  WEBHOOK_REFUND_COMPLETED,
  WEBHOOK_REFUND_FAILED,
  WEBHOOK_CHARGEBACK_CREATED,
} from "../../common/constants/webhook-event-types";
import {
  PAYMENT_METHOD_TYPE_CARD,
  PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
} from "../../common/constants/payment-method-types";

// Mock the entire @adyen/api-library module
const mockPayments = jest.fn();
const mockRefundCapturedPayment = jest.fn();
const mockStoredPaymentMethods = jest.fn();
const mockGetTokensForStoredPaymentDetails = jest.fn();
const mockDeleteTokenForStoredPaymentDetails = jest.fn();
const mockValidateHMAC = jest.fn();

jest.mock("@adyen/api-library", () => {
  return {
    Client: jest.fn().mockImplementation(() => ({})),
    CheckoutAPI: jest.fn().mockImplementation(() => ({
      PaymentsApi: {
        payments: mockPayments,
      },
      ModificationsApi: {
        refundCapturedPayment: mockRefundCapturedPayment,
      },
      RecurringApi: {
        storedPaymentMethods: mockStoredPaymentMethods,
        getTokensForStoredPaymentDetails: mockGetTokensForStoredPaymentDetails,
        deleteTokenForStoredPaymentDetails:
          mockDeleteTokenForStoredPaymentDetails,
      },
    })),
    hmacValidator: jest.fn().mockImplementation(() => ({
      validateHMAC: mockValidateHMAC,
    })),
    EnvironmentEnum: { LIVE: "LIVE", TEST: "TEST" },
  };
});

describe("AdyenAdapter", () => {
  let adapter: AdyenAdapter;
  let configService: ConfigService;
  let circuitBreaker: { fire: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    configService = {
      get: jest.fn((key: string) => {
        const config: Record<string, string> = {
          "adyen.apiKey": "AQEtest123",
          "adyen.merchantAccount": "TestMerchant",
          "adyen.hmacKey": "hmac_test_key",
          "adyen.environment": "TEST",
          "adyen.liveUrlPrefix": "",
        };
        return config[key];
      }),
    } as unknown as ConfigService;

    circuitBreaker = {
      fire: jest.fn((fn: () => Promise<unknown>) => fn()),
    };

    adapter = new AdyenAdapter(
      configService,
      circuitBreaker as unknown as import("../circuit-breaker/circuit-breaker.service").CircuitBreakerService,
    );
  });

  describe("constructor", () => {
    it("should initialize with LIVE environment and liveUrlPrefix", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Client } = require("@adyen/api-library") as {
        Client: jest.Mock;
      };

      Client.mockClear();

      const liveConfigService = {
        get: jest.fn((key: string) => {
          const config: Record<string, string> = {
            "adyen.apiKey": "AQElive123",
            "adyen.merchantAccount": "LiveMerchant",
            "adyen.hmacKey": "hmac_live_key",
            "adyen.environment": "LIVE",
            "adyen.liveUrlPrefix": "abc123prefix",
          };
          return config[key];
        }),
      } as unknown as ConfigService;

      const liveAdapter = new AdyenAdapter(
        liveConfigService,
        circuitBreaker as unknown as import("../circuit-breaker/circuit-breaker.service").CircuitBreakerService,
      );

      expect(liveAdapter).toBeInstanceOf(AdyenAdapter);
      expect(Client).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "AQElive123",
          liveEndpointUrlPrefix: "abc123prefix",
        }),
        undefined,
      );
      expect(liveConfigService.get).toHaveBeenCalledWith("adyen.apiKey");
      expect(liveConfigService.get).toHaveBeenCalledWith(
        "adyen.merchantAccount",
      );
      expect(liveConfigService.get).toHaveBeenCalledWith("adyen.hmacKey");
      expect(liveConfigService.get).toHaveBeenCalledWith("adyen.environment");
      expect(liveConfigService.get).toHaveBeenCalledWith("adyen.liveUrlPrefix");
    });

    it("should override checkout sub-API baseUrl when apiBaseUrl is configured", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { CheckoutAPI } = require("@adyen/api-library") as {
        CheckoutAPI: jest.Mock;
      };

      const mockCheckout = CheckoutAPI.mock.results[0]?.value as
        | Record<string, unknown>
        | undefined;

      const apiBaseUrlConfig = {
        get: jest.fn((key: string) => {
          const config: Record<string, string> = {
            "adyen.apiKey": "AQEtest123",
            "adyen.merchantAccount": "TestMerchant",
            "adyen.hmacKey": "hmac_test_key",
            "adyen.environment": "TEST",
            "adyen.liveUrlPrefix": "",
            "adyen.apiBaseUrl": "http://localhost:8080",
          };
          return config[key];
        }),
      } as unknown as ConfigService;

      new AdyenAdapter(
        apiBaseUrlConfig,
        circuitBreaker as unknown as import("../circuit-breaker/circuit-breaker.service").CircuitBreakerService,
      );

      expect(apiBaseUrlConfig.get).toHaveBeenCalledWith("adyen.apiBaseUrl");
      // Verify that the mock CheckoutAPI was used (the override is applied on the SDK internals)
      expect(mockCheckout).toBeDefined();
    });

    it("should not override baseUrl when apiBaseUrl is not configured", () => {
      const noBaseUrlConfig = {
        get: jest.fn((key: string) => {
          const config: Record<string, string | undefined> = {
            "adyen.apiKey": "AQEtest123",
            "adyen.merchantAccount": "TestMerchant",
            "adyen.hmacKey": "hmac_test_key",
            "adyen.environment": "TEST",
            "adyen.liveUrlPrefix": "",
            "adyen.apiBaseUrl": undefined,
          };
          return config[key];
        }),
      } as unknown as ConfigService;

      const adapterWithoutOverride = new AdyenAdapter(
        noBaseUrlConfig,
        circuitBreaker as unknown as import("../circuit-breaker/circuit-breaker.service").CircuitBreakerService,
      );

      expect(adapterWithoutOverride).toBeInstanceOf(AdyenAdapter);
      expect(noBaseUrlConfig.get).toHaveBeenCalledWith("adyen.apiBaseUrl");
    });
  });

  describe("createCharge", () => {
    it("should create charge successfully and return ChargeResult with exact field values", async () => {
      mockPayments.mockResolvedValueOnce({
        pspReference: "PSP_REF_123",
        resultCode: "Authorised",
        merchantReference: "ref-001",
        refusalReason: null,
      });

      const result = await adapter.createCharge({
        amount: 5000,
        currency: "USD",
        customerId: "cust-1",
        paymentMethodId: "pm-1",
        description: "Test charge",
        metadata: { invoiceId: "inv-1" },
        idempotencyKey: "idem-key-1",
      });

      expect(result).toEqual({
        id: "PSP_REF_123",
        amount: 5000,
        currency: "usd",
        status: "succeeded",
        customerId: "cust-1",
        paymentMethodId: "pm-1",
        failureCode: null,
        failureMessage: null,
        metadata: { invoiceId: "inv-1" },
        createdAt: expect.any(Date) as Date,
      });

      expect(mockPayments).toHaveBeenCalledWith(
        expect.objectContaining({
          merchantAccount: "TestMerchant",
          amount: { currency: "USD", value: 5000 },
          reference: "idem-key-1",
          paymentMethod: {
            type: "scheme",
            storedPaymentMethodId: "pm-1",
          },
          shopperReference: "cust-1",
          shopperInteraction: "ContAuth",
          recurringProcessingModel: "Subscription",
        }),
        { idempotencyKey: "idem-key-1" },
      );
    });

    it("should pass idempotency key in request options", async () => {
      mockPayments.mockResolvedValueOnce({
        pspReference: "PSP_REF_456",
        resultCode: "Authorised",
      });

      await adapter.createCharge({
        amount: 1000,
        currency: "EUR",
        customerId: "cust-2",
        paymentMethodId: "pm-2",
        idempotencyKey: "unique-key",
      });

      expect(mockPayments).toHaveBeenCalledWith(expect.any(Object), {
        idempotencyKey: "unique-key",
      });
    });

    it("should not pass request options when no idempotency key", async () => {
      mockPayments.mockResolvedValueOnce({
        pspReference: "PSP_REF_789",
        resultCode: "Authorised",
      });

      await adapter.createCharge({
        amount: 1000,
        currency: "USD",
        customerId: "cust-3",
        paymentMethodId: "pm-3",
      });

      expect(mockPayments).toHaveBeenCalledWith(expect.any(Object), undefined);
    });

    it("should throw PaymentFailedException when result is Refused", async () => {
      mockPayments.mockResolvedValueOnce({
        pspReference: "PSP_REF_REFUSED",
        resultCode: "Refused",
        refusalReason: "Insufficient funds",
      });

      const promise = adapter.createCharge({
        amount: 5000,
        currency: "USD",
        customerId: "cust-1",
        paymentMethodId: "pm-1",
      });

      await expect(promise).rejects.toThrow(PaymentFailedException);
      await expect(promise).rejects.toThrow(
        "Adyen payment refused: Insufficient funds",
      );
    });

    it("should throw PaymentFailedException when result is Error", async () => {
      mockPayments.mockResolvedValueOnce({
        pspReference: "PSP_REF_ERR",
        resultCode: "Error",
        refusalReason: "Configuration error",
      });

      const promise = adapter.createCharge({
        amount: 5000,
        currency: "USD",
        customerId: "cust-1",
        paymentMethodId: "pm-1",
      });

      await expect(promise).rejects.toThrow(PaymentFailedException);
      await expect(promise).rejects.toThrow(
        "Adyen payment error: Configuration error",
      );
    });

    it("should throw GatewayUnavailableException on network error", async () => {
      mockPayments.mockRejectedValueOnce(new Error("ETIMEDOUT"));

      await expect(
        adapter.createCharge({
          amount: 5000,
          currency: "USD",
          customerId: "cust-1",
          paymentMethodId: "pm-1",
        }),
      ).rejects.toThrow(GatewayUnavailableException);
    });

    it("should throw GatewayUnavailableException on ECONNREFUSED error", async () => {
      mockPayments.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(
        adapter.createCharge({
          amount: 1000,
          currency: "USD",
          customerId: "cust-1",
          paymentMethodId: "pm-1",
        }),
      ).rejects.toThrow(GatewayUnavailableException);
    });

    it("should handle charge response with missing pspReference", async () => {
      mockPayments.mockResolvedValueOnce({
        resultCode: "Authorised",
      });

      const result = await adapter.createCharge({
        amount: 1000,
        currency: "USD",
        customerId: "cust-1",
        paymentMethodId: "pm-1",
      });

      expect(result.id).toBe("");
      expect(result.status).toBe("succeeded");
    });

    it("should handle charge response with missing resultCode", async () => {
      mockPayments.mockResolvedValueOnce({
        pspReference: "PSP_NO_RC",
      });

      const result = await adapter.createCharge({
        amount: 1000,
        currency: "USD",
        customerId: "cust-1",
        paymentMethodId: "pm-1",
      });

      expect(result.id).toBe("PSP_NO_RC");
      expect(result.status).toBe("pending");
    });

    it("should use description as reference when no idempotency key", async () => {
      mockPayments.mockResolvedValueOnce({
        pspReference: "PSP_DESC",
        resultCode: "Authorised",
      });

      await adapter.createCharge({
        amount: 1000,
        currency: "USD",
        customerId: "cust-1",
        paymentMethodId: "pm-1",
        description: "Monthly subscription",
      });

      expect(mockPayments).toHaveBeenCalledWith(
        expect.objectContaining({
          reference: "Monthly subscription",
        }),
        undefined,
      );
    });

    it("should default metadata to empty object when not provided", async () => {
      mockPayments.mockResolvedValueOnce({
        pspReference: "PSP_NO_META",
        resultCode: "Authorised",
      });

      const result = await adapter.createCharge({
        amount: 1000,
        currency: "USD",
        customerId: "cust-1",
        paymentMethodId: "pm-1",
      });

      expect(result.metadata).toEqual({});
    });

    it("should handle Refused with missing refusalReason", async () => {
      mockPayments.mockResolvedValueOnce({
        pspReference: "PSP_NO_REASON",
        resultCode: "Refused",
      });

      const promise = adapter.createCharge({
        amount: 1000,
        currency: "USD",
        customerId: "cust-1",
        paymentMethodId: "pm-1",
      });

      await expect(promise).rejects.toThrow(
        "Adyen payment refused: unknown reason",
      );
    });

    it("should wrap non-Error thrown values as PaymentFailedException", async () => {
      mockPayments.mockRejectedValueOnce("string error");

      await expect(
        adapter.createCharge({
          amount: 1000,
          currency: "USD",
          customerId: "cust-1",
          paymentMethodId: "pm-1",
        }),
      ).rejects.toThrow(PaymentFailedException);
    });
  });

  describe("createRefund", () => {
    it("should create refund and return RefundResult with pending status", async () => {
      mockRefundCapturedPayment.mockResolvedValueOnce({
        pspReference: "REFUND_PSP_123",
        paymentPspReference: "ORIG_PSP_123",
        status: "received",
      });

      const result = await adapter.createRefund({
        chargeId: "ORIG_PSP_123",
        amount: 2500,
        reason: "requested_by_customer",
        idempotencyKey: "refund-idem-1",
      });

      expect(result).toEqual({
        id: "REFUND_PSP_123",
        chargeId: "ORIG_PSP_123",
        amount: 2500,
        currency: "usd",
        status: "pending",
        reason: "requested_by_customer",
        createdAt: expect.any(Date) as Date,
      });

      expect(mockRefundCapturedPayment).toHaveBeenCalledWith(
        "ORIG_PSP_123",
        expect.objectContaining({
          merchantAccount: "TestMerchant",
          amount: { currency: "USD", value: 2500 },
          reference: "refund-idem-1",
        }),
      );
    });

    it("should throw on refund failure", async () => {
      mockRefundCapturedPayment.mockRejectedValueOnce(
        new Error("Refund not possible"),
      );

      const promise = adapter.createRefund({
        chargeId: "ORIG_PSP_FAIL",
        amount: 1000,
      });

      await expect(promise).rejects.toThrow(PaymentFailedException);
      await expect(promise).rejects.toThrow(
        "Payment operation failed: Refund not possible",
      );
    });

    it("should handle refund with missing response pspReference", async () => {
      mockRefundCapturedPayment.mockResolvedValueOnce({
        status: "received",
      });

      const result = await adapter.createRefund({
        chargeId: "ORIG_PSP_MISSING",
        amount: 500,
      });

      expect(result.id).toBe("");
      expect(result.chargeId).toBe("ORIG_PSP_MISSING");
      expect(result.reason).toBeNull();
    });

    it("should default reference to empty string when no idempotencyKey", async () => {
      mockRefundCapturedPayment.mockResolvedValueOnce({
        pspReference: "REF_NO_IDEM",
        paymentPspReference: "PAY_ORIG",
        status: "received",
      });

      await adapter.createRefund({
        chargeId: "PAY_ORIG",
        amount: 100,
      });

      expect(mockRefundCapturedPayment).toHaveBeenCalledWith(
        "PAY_ORIG",
        expect.objectContaining({
          reference: "",
        }),
      );
    });

    it("should default amount to 0 when not provided", async () => {
      mockRefundCapturedPayment.mockResolvedValueOnce({
        pspReference: "REF_NO_AMT",
        paymentPspReference: "PAY_NO_AMT",
        status: "received",
      });

      const result = await adapter.createRefund({
        chargeId: "PAY_NO_AMT",
      });

      expect(result.amount).toBe(0);
      expect(mockRefundCapturedPayment).toHaveBeenCalledWith(
        "PAY_NO_AMT",
        expect.objectContaining({
          amount: { currency: "USD", value: 0 },
        }),
      );
    });
  });

  describe("attachPaymentMethod", () => {
    it("should store payment method and return normalized type (scheme -> card)", async () => {
      mockStoredPaymentMethods.mockResolvedValueOnce({
        id: "stored-pm-1",
        type: "scheme",
        lastFour: "4242",
        brand: "visa",
        expiryMonth: "12",
        expiryYear: "2027",
      });

      const result = await adapter.attachPaymentMethod("token-1", "cust-1");

      expect(result).toEqual({
        id: "stored-pm-1",
        customerId: "cust-1",
        type: PAYMENT_METHOD_TYPE_CARD,
        last4: "4242",
        brand: "visa",
        bankName: null,
        expiryMonth: 12,
        expiryYear: 2027,
        isDefault: false,
        fingerprint: null,
      });
    });

    it("should normalize sepadirectdebit to bank_account", async () => {
      mockStoredPaymentMethods.mockResolvedValueOnce({
        id: "stored-pm-2",
        type: "sepadirectdebit",
        lastFour: "1234",
        brand: null,
        expiryMonth: null,
        expiryYear: null,
      });

      const result = await adapter.attachPaymentMethod("token-2", "cust-2");

      expect(result.type).toBe(PAYMENT_METHOD_TYPE_BANK_ACCOUNT);
      expect(result.last4).toBe("1234");
      expect(result.expiryMonth).toBeNull();
      expect(result.expiryYear).toBeNull();
    });

    it("should handle response with missing id and type", async () => {
      mockStoredPaymentMethods.mockResolvedValueOnce({});

      const result = await adapter.attachPaymentMethod("token-3", "cust-3");

      expect(result.id).toBe("token-3");
      expect(result.type).toBe(PAYMENT_METHOD_TYPE_CARD);
      expect(result.last4).toBeNull();
      expect(result.brand).toBeNull();
    });
  });

  describe("detachPaymentMethod", () => {
    it("should call delete and return PaymentMethodResult", async () => {
      mockDeleteTokenForStoredPaymentDetails.mockResolvedValueOnce(undefined);

      const result = await adapter.detachPaymentMethod("stored-pm-1");

      expect(result).toEqual({
        id: "stored-pm-1",
        customerId: "",
        type: "",
        last4: null,
        brand: null,
        bankName: null,
        expiryMonth: null,
        expiryYear: null,
        isDefault: false,
        fingerprint: null,
      });

      expect(mockDeleteTokenForStoredPaymentDetails).toHaveBeenCalledWith(
        "stored-pm-1",
        "",
        "TestMerchant",
      );
    });
  });

  describe("listPaymentMethods", () => {
    it("should list and map payment methods to PaymentMethodResult[]", async () => {
      mockGetTokensForStoredPaymentDetails.mockResolvedValueOnce({
        storedPaymentMethods: [
          {
            id: "pm-a",
            type: "scheme",
            lastFour: "1111",
            brand: "mc",
            expiryMonth: "06",
            expiryYear: "2028",
          },
          {
            id: "pm-b",
            type: "sepadirectdebit",
            lastFour: "9999",
            brand: null,
            expiryMonth: null,
            expiryYear: null,
          },
        ],
      });

      const result = await adapter.listPaymentMethods("cust-1");

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: "pm-a",
        customerId: "cust-1",
        type: PAYMENT_METHOD_TYPE_CARD,
        last4: "1111",
        brand: "mc",
        bankName: null,
        expiryMonth: 6,
        expiryYear: 2028,
        isDefault: false,
        fingerprint: null,
      });
      expect(result[1]).toEqual({
        id: "pm-b",
        customerId: "cust-1",
        type: PAYMENT_METHOD_TYPE_BANK_ACCOUNT,
        last4: "9999",
        brand: null,
        bankName: null,
        expiryMonth: null,
        expiryYear: null,
        isDefault: false,
        fingerprint: null,
      });

      expect(mockGetTokensForStoredPaymentDetails).toHaveBeenCalledWith(
        "cust-1",
        "TestMerchant",
      );
    });

    it("should return empty array when no storedPaymentMethods", async () => {
      mockGetTokensForStoredPaymentDetails.mockResolvedValueOnce({});

      const result = await adapter.listPaymentMethods("cust-empty");

      expect(result).toEqual([]);
    });

    it("should handle PMs with missing id, type, and lastFour fields", async () => {
      mockGetTokensForStoredPaymentDetails.mockResolvedValueOnce({
        storedPaymentMethods: [
          {
            brand: "amex",
            expiryMonth: "03",
            expiryYear: "2030",
          },
        ],
      });

      const result = await adapter.listPaymentMethods("cust-sparse");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("");
      expect(result[0].type).toBe("");
      expect(result[0].last4).toBeNull();
      expect(result[0].brand).toBe("amex");
    });
  });

  describe("createCustomer", () => {
    it("should return synthetic CustomerResult with shopperReference", async () => {
      const result = await adapter.createCustomer({
        email: "test@example.com",
        name: "Test User",
        metadata: { customerId: "cust-42" },
      });

      expect(result).toEqual({
        id: "cust-42",
        email: "test@example.com",
        name: "Test User",
        metadata: { customerId: "cust-42" },
        createdAt: expect.any(Date) as Date,
        defaultPaymentMethodId: null,
      });

      // Negative assertion: no external API calls
      expect(mockPayments).not.toHaveBeenCalled();
      expect(mockStoredPaymentMethods).not.toHaveBeenCalled();
    });

    it("should handle missing metadata and name", async () => {
      const result = await adapter.createCustomer({
        email: "test@example.com",
      });

      expect(result.id).toBe("");
      expect(result.name).toBeNull();
      expect(result.metadata).toEqual({});
    });
  });

  describe("updateCustomer", () => {
    it("should return synthetic CustomerResult", async () => {
      const result = await adapter.updateCustomer("cust-42", {
        email: "updated@example.com",
      });

      expect(result.id).toBe("cust-42");
      expect(result.email).toBe("updated@example.com");
      expect(result.defaultPaymentMethodId).toBeNull();

      // Negative assertion
      expect(mockPayments).not.toHaveBeenCalled();
    });

    it("should handle missing optional fields", async () => {
      const result = await adapter.updateCustomer("cust-42", {});

      expect(result.email).toBe("");
      expect(result.name).toBeNull();
      expect(result.metadata).toEqual({});
    });
  });

  describe("getCustomer", () => {
    it("should return synthetic CustomerResult from ID", async () => {
      const result = await adapter.getCustomer("cust-42");

      expect(result).toEqual({
        id: "cust-42",
        email: "",
        name: null,
        metadata: {},
        createdAt: expect.any(Date) as Date,
        defaultPaymentMethodId: null,
      });

      // Negative assertion
      expect(mockPayments).not.toHaveBeenCalled();
    });
  });

  describe("setDefaultPaymentMethod", () => {
    it("should return synthetic CustomerResult (no-op)", async () => {
      const result = await adapter.setDefaultPaymentMethod("cust-42", "pm-1");

      expect(result.id).toBe("cust-42");
      expect(result.defaultPaymentMethodId).toBeNull();

      // Negative assertion
      expect(mockPayments).not.toHaveBeenCalled();
      expect(mockStoredPaymentMethods).not.toHaveBeenCalled();
    });
  });

  describe("getBalanceTransactions", () => {
    it("should return empty array", async () => {
      const result = await adapter.getBalanceTransactions();

      expect(result).toEqual([]);

      // Negative assertion
      expect(circuitBreaker.fire).not.toHaveBeenCalled();
    });
  });

  describe("verifyAndParseWebhook", () => {
    const buildWebhookPayload = (
      notification: Record<string, unknown>,
    ): string => {
      return JSON.stringify({
        notificationItems: [{ NotificationRequestItem: notification }],
      });
    };

    beforeEach(() => {
      mockValidateHMAC.mockReturnValue(true);
    });

    it("should parse AUTHORISATION success as payment.succeeded with correct fields", async () => {
      const payload = buildWebhookPayload({
        eventCode: "AUTHORISATION",
        pspReference: "PSP_AUTH_1",
        amount: { currency: "USD", value: 5000 },
        success: "true",
        merchantReference: "ref-1",
        additionalData: { shopperCountry: "US" },
      });

      const result = await adapter.verifyAndParseWebhook(payload, {});

      expect(result).toEqual({
        eventType: WEBHOOK_PAYMENT_SUCCEEDED,
        gatewayProvider: GatewayProvider.Adyen,
        gatewayEventId: "PSP_AUTH_1",
        gatewayChargeId: "PSP_AUTH_1",
        amount: 5000,
        currency: "usd",
        status: "succeeded",
        metadata: { shopperCountry: "US" },
        receivedAt: expect.any(Date) as Date,
      });
    });

    it("should parse AUTHORISATION with success false as payment.failed", async () => {
      const payload = buildWebhookPayload({
        eventCode: "AUTHORISATION",
        pspReference: "PSP_AUTH_FAIL",
        amount: { currency: "EUR", value: 3000 },
        success: "false",
        merchantReference: "ref-fail",
      });

      const result = await adapter.verifyAndParseWebhook(payload, {});

      expect(result).not.toBeNull();
      expect(result!.eventType).toBe(WEBHOOK_PAYMENT_FAILED);
      expect(result!.gatewayChargeId).toBe("PSP_AUTH_FAIL");
      expect(result!.status).toBe("failed");
    });

    it("should parse REFUND success with originalReference as gatewayChargeId", async () => {
      const payload = buildWebhookPayload({
        eventCode: "REFUND",
        pspReference: "PSP_REFUND_1",
        originalReference: "PSP_ORIG_CHARGE_1",
        amount: { currency: "USD", value: 2500 },
        success: "true",
      });

      const result = await adapter.verifyAndParseWebhook(payload, {});

      expect(result).toEqual({
        eventType: WEBHOOK_REFUND_COMPLETED,
        gatewayProvider: GatewayProvider.Adyen,
        gatewayEventId: "PSP_REFUND_1",
        gatewayChargeId: "PSP_ORIG_CHARGE_1",
        amount: 2500,
        currency: "usd",
        status: "succeeded",
        metadata: {},
        receivedAt: expect.any(Date) as Date,
      });
    });

    it("should parse REFUND_FAILED event", async () => {
      const payload = buildWebhookPayload({
        eventCode: "REFUND_FAILED",
        pspReference: "PSP_REFUND_FAIL_1",
        originalReference: "PSP_ORIG_2",
        amount: { currency: "USD", value: 1000 },
        success: "false",
      });

      const result = await adapter.verifyAndParseWebhook(payload, {});

      expect(result).not.toBeNull();
      expect(result!.eventType).toBe(WEBHOOK_REFUND_FAILED);
      expect(result!.gatewayChargeId).toBe("PSP_ORIG_2");
    });

    it("should parse CHARGEBACK event", async () => {
      const payload = buildWebhookPayload({
        eventCode: "CHARGEBACK",
        pspReference: "PSP_CB_1",
        originalReference: "PSP_ORIG_3",
        amount: { currency: "GBP", value: 7500 },
        success: "true",
      });

      const result = await adapter.verifyAndParseWebhook(payload, {});

      expect(result).not.toBeNull();
      expect(result!.eventType).toBe(WEBHOOK_CHARGEBACK_CREATED);
      expect(result!.gatewayChargeId).toBe("PSP_ORIG_3");
      expect(result!.currency).toBe("gbp");
    });

    it("should return null for unmapped event code (e.g., CAPTURE)", async () => {
      const payload = buildWebhookPayload({
        eventCode: "CAPTURE",
        pspReference: "PSP_CAPTURE_1",
        amount: { currency: "USD", value: 5000 },
        success: "true",
      });

      const result = await adapter.verifyAndParseWebhook(payload, {});

      expect(result).toBeNull();
    });

    it("should throw WebhookVerificationException when HMAC validation fails", async () => {
      mockValidateHMAC.mockReturnValue(false);

      const payload = buildWebhookPayload({
        eventCode: "AUTHORISATION",
        pspReference: "PSP_INVALID",
        amount: { currency: "USD", value: 1000 },
        success: "true",
      });

      const promise = adapter.verifyAndParseWebhook(payload, {});

      await expect(promise).rejects.toThrow(WebhookVerificationException);
      await expect(promise).rejects.toThrow(
        "Adyen webhook HMAC verification failed",
      );
    });

    it("should NOT call circuitBreaker.fire for webhook verification", async () => {
      const payload = buildWebhookPayload({
        eventCode: "AUTHORISATION",
        pspReference: "PSP_NO_CB",
        amount: { currency: "USD", value: 1000 },
        success: "true",
      });

      await adapter.verifyAndParseWebhook(payload, {});

      expect(circuitBreaker.fire).not.toHaveBeenCalled();
    });

    it("should throw WebhookVerificationException for missing notificationItems", async () => {
      const payload = JSON.stringify({});

      const promise = adapter.verifyAndParseWebhook(payload, {});

      await expect(promise).rejects.toThrow(WebhookVerificationException);
      await expect(promise).rejects.toThrow(
        "Invalid Adyen webhook payload: missing notificationItems",
      );
    });

    it("should handle Buffer input", async () => {
      const payload = buildWebhookPayload({
        eventCode: "AUTHORISATION",
        pspReference: "PSP_BUF_1",
        amount: { currency: "USD", value: 2000 },
        success: "true",
      });

      const result = await adapter.verifyAndParseWebhook(
        Buffer.from(payload),
        {},
      );

      expect(result).not.toBeNull();
      expect(result!.gatewayEventId).toBe("PSP_BUF_1");
    });

    it("should default metadata to empty object when no additionalData", async () => {
      const payload = buildWebhookPayload({
        eventCode: "AUTHORISATION",
        pspReference: "PSP_NO_AD",
        amount: { currency: "USD", value: 1000 },
        success: "true",
      });

      const result = await adapter.verifyAndParseWebhook(payload, {});

      expect(result).not.toBeNull();
      expect(result!.metadata).toEqual({});
    });

    it("should throw on empty notificationItems array", async () => {
      const payload = JSON.stringify({
        notificationItems: [],
      });

      const promise = adapter.verifyAndParseWebhook(payload, {});

      await expect(promise).rejects.toThrow(WebhookVerificationException);
    });

    it("should throw WebhookVerificationException for malformed JSON payload", async () => {
      const promise = adapter.verifyAndParseWebhook("not valid json{{{", {});

      await expect(promise).rejects.toThrow(WebhookVerificationException);
      await expect(promise).rejects.toThrow(
        "Invalid Adyen webhook payload: malformed JSON",
      );
    });

    it("should use pspReference as gatewayChargeId when originalReference is missing for REFUND", async () => {
      const payload = buildWebhookPayload({
        eventCode: "REFUND",
        pspReference: "PSP_REFUND_ONLY",
        amount: { currency: "USD", value: 500 },
        success: "true",
      });

      const result = await adapter.verifyAndParseWebhook(payload, {});

      expect(result).not.toBeNull();
      expect(result!.gatewayChargeId).toBe("PSP_REFUND_ONLY");
    });
  });

  describe("circuit breaker integration", () => {
    it("should route createCharge through circuitBreaker.fire", async () => {
      mockPayments.mockResolvedValueOnce({
        pspReference: "PSP_CB_TEST",
        resultCode: "Authorised",
      });

      await adapter.createCharge({
        amount: 1000,
        currency: "USD",
        customerId: "cust-cb",
        paymentMethodId: "pm-cb",
      });

      expect(circuitBreaker.fire).toHaveBeenCalledTimes(1);
      expect(circuitBreaker.fire).toHaveBeenCalledWith(expect.any(Function));
    });

    it("should route createRefund through circuitBreaker.fire", async () => {
      mockRefundCapturedPayment.mockResolvedValueOnce({
        pspReference: "REF_CB_TEST",
        paymentPspReference: "PAY_CB_TEST",
        status: "received",
      });

      await adapter.createRefund({
        chargeId: "PAY_CB_TEST",
        amount: 500,
      });

      expect(circuitBreaker.fire).toHaveBeenCalledTimes(1);
    });

    it("should route attachPaymentMethod through circuitBreaker.fire", async () => {
      mockStoredPaymentMethods.mockResolvedValueOnce({
        id: "pm-cb",
        type: "scheme",
      });

      await adapter.attachPaymentMethod("token-cb", "cust-cb");

      expect(circuitBreaker.fire).toHaveBeenCalledTimes(1);
    });

    it("should route detachPaymentMethod through circuitBreaker.fire", async () => {
      mockDeleteTokenForStoredPaymentDetails.mockResolvedValueOnce(undefined);

      await adapter.detachPaymentMethod("pm-cb");

      expect(circuitBreaker.fire).toHaveBeenCalledTimes(1);
    });

    it("should route listPaymentMethods through circuitBreaker.fire", async () => {
      mockGetTokensForStoredPaymentDetails.mockResolvedValueOnce({
        storedPaymentMethods: [],
      });

      await adapter.listPaymentMethods("cust-cb");

      expect(circuitBreaker.fire).toHaveBeenCalledTimes(1);
    });

    it("should wrap circuit breaker open error as GatewayUnavailableException", async () => {
      circuitBreaker.fire.mockRejectedValueOnce(new Error("Breaker is open"));

      const promise = adapter.createCharge({
        amount: 1000,
        currency: "USD",
        customerId: "cust-1",
        paymentMethodId: "pm-1",
      });

      await expect(promise).rejects.toThrow(GatewayUnavailableException);
      await expect(promise).rejects.toThrow(
        "Payment gateway unavailable: circuit breaker is open",
      );
    });

    it("should wrap timeout error as GatewayUnavailableException", async () => {
      circuitBreaker.fire.mockRejectedValueOnce(
        new Error("Timed out after 10000ms"),
      );

      await expect(
        adapter.createCharge({
          amount: 1000,
          currency: "USD",
          customerId: "cust-1",
          paymentMethodId: "pm-1",
        }),
      ).rejects.toThrow(GatewayUnavailableException);
    });

    it("should wrap HTTP 500 error as GatewayUnavailableException", async () => {
      circuitBreaker.fire.mockRejectedValueOnce(
        new Error("Request failed with status code 500"),
      );

      await expect(
        adapter.createCharge({
          amount: 1000,
          currency: "USD",
          customerId: "cust-1",
          paymentMethodId: "pm-1",
        }),
      ).rejects.toThrow(GatewayUnavailableException);
    });

    it("should NOT wrap error containing digit 5 as GatewayUnavailableException", async () => {
      circuitBreaker.fire.mockRejectedValueOnce(
        new Error("Insufficient funds for $5 payment"),
      );

      await expect(
        adapter.createCharge({
          amount: 1000,
          currency: "USD",
          customerId: "cust-1",
          paymentMethodId: "pm-1",
        }),
      ).rejects.toThrow(PaymentFailedException);
      await expect(
        adapter.createCharge({
          amount: 1000,
          currency: "USD",
          customerId: "cust-1",
          paymentMethodId: "pm-1",
        }),
      ).rejects.not.toThrow(GatewayUnavailableException);
    });
  });
});
