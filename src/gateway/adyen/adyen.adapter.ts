import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Client,
  CheckoutAPI,
  Config,
  hmacValidator as HmacValidator,
  EnvironmentEnum,
} from "@adyen/api-library";
import type { Types } from "@adyen/api-library";
import type { PaymentGateway } from "../gateway.interface";
import type {
  CustomerResult,
  PaymentMethodResult,
  ChargeResult,
  RefundResult,
  BalanceTransactionResult,
  CreateCustomerInput,
  UpdateCustomerInput,
  CreateChargeInput,
  CreateRefundInput,
  GetBalanceTransactionsInput,
} from "../gateway.types";
import { CircuitBreakerService } from "../circuit-breaker/circuit-breaker.service";
import { BillingException } from "../../common/exceptions/billing.exception";
import { PaymentFailedException } from "../../common/exceptions/payment-failed.exception";
import { GatewayUnavailableException } from "../../common/exceptions/gateway-unavailable.exception";
import { WebhookVerificationException } from "../../common/exceptions/webhook-verification.exception";
import { GatewayProvider } from "../../common/enums/gateway-provider.enum";
import type { NormalizedWebhookEvent } from "../../common/interfaces/normalized-webhook-event.interface";
import { WEBHOOK_PAYMENT_FAILED } from "../../common/constants/webhook-event-types";
import {
  ADYEN_EVENT_MAP,
  mapAdyenResultCode,
  normalizeAdyenPmType,
} from "./adyen.types";

interface AdyenNotificationItem {
  eventCode: string;
  pspReference: string;
  originalReference?: string;
  merchantReference?: string;
  amount: { currency: string; value: number };
  success: string;
  additionalData?: Record<string, string>;
}

/**
 * HTTP client using fetch() that supports both http:// and https:// URLs.
 * The default Adyen SDK HttpURLConnectionClient hardcodes https.request(),
 * which rejects http:// URLs like WireMock's E2E test endpoint.
 */
class AdyenHttpClient {
  async request(
    endpoint: string,
    json: string,
    config: Config,
    isApiKeyRequired: boolean,
    requestOptions?: Record<string, unknown>,
  ): Promise<string> {
    const method = (requestOptions?.["method"] as string | undefined) ?? "POST";
    const idempotencyKey = requestOptions?.["idempotencyKey"] as
      | string
      | undefined;
    const params = requestOptions?.["params"] as
      | Record<string, string>
      | undefined;

    let url = endpoint;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      url += (url.includes("?") ? "&" : "?") + qs;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (isApiKeyRequired && config.apiKey) {
      headers["x-API-key"] = config.apiKey;
    }

    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    const response = await fetch(url, {
      method,
      headers,
      ...(json && method !== "GET" && method !== "DELETE"
        ? { body: json }
        : {}),
    });

    const body = await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP Exception: ${String(response.status)}. ${response.statusText}`,
      );
    }

    return body;
  }
}

export class AdyenAdapter implements PaymentGateway {
  private readonly logger = new Logger(AdyenAdapter.name);
  private readonly checkoutApi: CheckoutAPI;
  private readonly merchantAccount: string;
  private readonly hmacKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    const apiKey = this.configService.get<string>("adyen.apiKey")!;
    this.merchantAccount = this.configService.get<string>(
      "adyen.merchantAccount",
    )!;
    this.hmacKey = this.configService.get<string>("adyen.hmacKey")!;
    const environment = this.configService.get<string>("adyen.environment")!;
    const liveUrlPrefix = this.configService.get<string>("adyen.liveUrlPrefix");
    const apiBaseUrl = this.configService.get<string>("adyen.apiBaseUrl");

    const client = new Client(
      {
        apiKey,
        environment:
          environment === "LIVE" ? EnvironmentEnum.LIVE : EnvironmentEnum.TEST,
        ...(liveUrlPrefix ? { liveEndpointUrlPrefix: liveUrlPrefix } : {}),
      },
      apiBaseUrl ? new AdyenHttpClient() : undefined,
    );

    const checkoutApi = new CheckoutAPI(client);

    if (apiBaseUrl) {
      // Override checkout sub-API base URLs to point to WireMock for E2E testing.
      // The Adyen SDK uses getters that create new instances each time, so we
      // cache modified instances and replace the getters with static values.
      const targetBaseUrl = `${apiBaseUrl}/v71`;
      const paymentsApi = checkoutApi.PaymentsApi;
      const recurringApi = checkoutApi.RecurringApi;
      const modificationsApi = checkoutApi.ModificationsApi;

      (paymentsApi as unknown as { baseUrl: string }).baseUrl = targetBaseUrl;
      (recurringApi as unknown as { baseUrl: string }).baseUrl = targetBaseUrl;
      (modificationsApi as unknown as { baseUrl: string }).baseUrl =
        targetBaseUrl;

      Object.defineProperty(checkoutApi, "PaymentsApi", {
        value: paymentsApi,
      });
      Object.defineProperty(checkoutApi, "RecurringApi", {
        value: recurringApi,
      });
      Object.defineProperty(checkoutApi, "ModificationsApi", {
        value: modificationsApi,
      });
    }

    this.checkoutApi = checkoutApi;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createCustomer(input: CreateCustomerInput): Promise<CustomerResult> {
    // Adyen uses shopperReference (our customer ID), not a separate customer object
    return {
      id: input.metadata?.customerId ?? "",
      email: input.email,
      name: input.name ?? null,
      metadata: input.metadata ?? {},
      createdAt: new Date(),
      defaultPaymentMethodId: null,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async updateCustomer(
    customerId: string,
    input: UpdateCustomerInput,
  ): Promise<CustomerResult> {
    // Adyen shopperReference is immutable — no equivalent API
    return {
      id: customerId,
      email: input.email ?? "",
      name: input.name ?? null,
      metadata: input.metadata ?? {},
      createdAt: new Date(),
      defaultPaymentMethodId: null,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getCustomer(customerId: string): Promise<CustomerResult> {
    // Adyen has no customer retrieval API — return synthetic result
    return {
      id: customerId,
      email: "",
      name: null,
      metadata: {},
      createdAt: new Date(),
      defaultPaymentMethodId: null,
    };
  }

  async attachPaymentMethod(
    paymentMethodId: string,
    customerId: string,
  ): Promise<PaymentMethodResult> {
    return this.executeWithResilience("attachPaymentMethod", async () => {
      const response = await this.checkoutApi.RecurringApi.storedPaymentMethods(
        {
          merchantAccount: this.merchantAccount,
          shopperReference: customerId,
          paymentMethod: {
            type: "scheme",
            storedPaymentMethodId: paymentMethodId,
          },
        } as unknown as Types.checkout.StoredPaymentMethodRequest,
      );

      const storedPm =
        response as unknown as Types.checkout.StoredPaymentMethodResource;

      return {
        id: storedPm.id ?? paymentMethodId,
        customerId,
        type: normalizeAdyenPmType(storedPm.type ?? "scheme"),
        last4: storedPm.lastFour ?? null,
        brand: storedPm.brand ?? null,
        bankName: null,
        expiryMonth: storedPm.expiryMonth
          ? parseInt(storedPm.expiryMonth, 10)
          : null,
        expiryYear: storedPm.expiryYear
          ? parseInt(storedPm.expiryYear, 10)
          : null,
        isDefault: false,
      };
    });
  }

  async detachPaymentMethod(
    paymentMethodId: string,
  ): Promise<PaymentMethodResult> {
    return this.executeWithResilience("detachPaymentMethod", async () => {
      // FIXME: Adyen requires shopperReference to delete a stored PM, but the
      // PaymentGateway interface only provides paymentMethodId. Empty string
      // will fail at the Adyen API level. Needs interface extension or lookup.
      await this.checkoutApi.RecurringApi.deleteTokenForStoredPaymentDetails(
        paymentMethodId,
        "",
        this.merchantAccount,
      );

      return {
        id: paymentMethodId,
        customerId: "",
        type: "",
        last4: null,
        brand: null,
        bankName: null,
        expiryMonth: null,
        expiryYear: null,
        isDefault: false,
      };
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setDefaultPaymentMethod(
    customerId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    paymentMethodId: string,
  ): Promise<CustomerResult> {
    // Adyen has no gateway-level default PM concept — managed by billing service
    return {
      id: customerId,
      email: "",
      name: null,
      metadata: {},
      createdAt: new Date(),
      defaultPaymentMethodId: null,
    };
  }

  async listPaymentMethods(customerId: string): Promise<PaymentMethodResult[]> {
    return this.executeWithResilience("listPaymentMethods", async () => {
      const response =
        await this.checkoutApi.RecurringApi.getTokensForStoredPaymentDetails(
          customerId,
          this.merchantAccount,
        );

      const listResponse =
        response as unknown as Types.checkout.ListStoredPaymentMethodsResponse;

      return (listResponse.storedPaymentMethods ?? []).map(
        (pm: Types.checkout.StoredPaymentMethodResource) => ({
          id: pm.id ?? "",
          customerId,
          type: normalizeAdyenPmType(pm.type ?? ""),
          last4: pm.lastFour ?? null,
          brand: pm.brand ?? null,
          bankName: null,
          expiryMonth: pm.expiryMonth ? parseInt(pm.expiryMonth, 10) : null,
          expiryYear: pm.expiryYear ? parseInt(pm.expiryYear, 10) : null,
          isDefault: false,
        }),
      );
    });
  }

  async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
    return this.executeWithResilience("createCharge", async () => {
      const request = {
        merchantAccount: this.merchantAccount,
        amount: { currency: input.currency.toUpperCase(), value: input.amount },
        reference: input.idempotencyKey ?? input.description ?? "",
        paymentMethod: {
          type: "scheme",
          storedPaymentMethodId: input.paymentMethodId,
        },
        shopperReference: input.customerId,
        shopperInteraction: "ContAuth",
        recurringProcessingModel: "Subscription",
      } as unknown as Types.checkout.PaymentRequest;

      const requestOptions = input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined;

      const response = await this.checkoutApi.PaymentsApi.payments(
        request,
        requestOptions,
      );

      const resultCode = String(response.resultCode ?? "");
      const status = mapAdyenResultCode(resultCode);

      if (resultCode === "Refused" || resultCode === "Error") {
        throw new PaymentFailedException(
          `Adyen payment ${resultCode.toLowerCase()}: ${response.refusalReason ?? "unknown reason"}`,
          {
            operation: "createCharge",
            resultCode,
            refusalReason: response.refusalReason,
            pspReference: response.pspReference,
          },
        );
      }

      return {
        id: response.pspReference ?? "",
        amount: input.amount,
        currency: input.currency.toLowerCase(),
        status,
        customerId: input.customerId,
        paymentMethodId: input.paymentMethodId,
        failureCode: null,
        failureMessage: null,
        metadata: input.metadata ?? {},
        createdAt: new Date(),
      };
    });
  }

  async createRefund(input: CreateRefundInput): Promise<RefundResult> {
    return this.executeWithResilience("createRefund", async () => {
      // FIXME: currency is hardcoded to USD — CreateRefundInput lacks a currency
      // field. Adyen requires explicit currency unlike Stripe which infers from
      // the original charge. Add currency to CreateRefundInput in a future story.
      const request: Types.checkout.PaymentRefundRequest = {
        merchantAccount: this.merchantAccount,
        amount: {
          currency: "USD",
          value: input.amount ?? 0,
        },
        reference: input.idempotencyKey ?? "",
      };

      const response =
        await this.checkoutApi.ModificationsApi.refundCapturedPayment(
          input.chargeId,
          request,
        );

      return {
        id: response.pspReference ?? "",
        chargeId: response.paymentPspReference ?? input.chargeId,
        amount: input.amount ?? 0,
        currency: "usd",
        status: "pending" as const,
        reason: input.reason ?? null,
        createdAt: new Date(),
      };
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getBalanceTransactions(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    input?: GetBalanceTransactionsInput,
  ): Promise<BalanceTransactionResult[]> {
    // Adyen settlement reporting uses a different mechanism (Reports API)
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async verifyAndParseWebhook(
    rawPayload: string | Buffer,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    headers: Record<string, string>,
  ): Promise<NormalizedWebhookEvent | null> {
    let payload: {
      notificationItems?: Array<{
        NotificationRequestItem: AdyenNotificationItem;
      }>;
    };
    try {
      payload = JSON.parse(
        typeof rawPayload === "string"
          ? rawPayload
          : rawPayload.toString("utf8"),
      ) as typeof payload;
    } catch {
      throw new WebhookVerificationException(
        "Invalid Adyen webhook payload: malformed JSON",
      );
    }

    const notificationItems = payload.notificationItems;
    if (
      !notificationItems ||
      !Array.isArray(notificationItems) ||
      notificationItems.length === 0
    ) {
      throw new WebhookVerificationException(
        "Invalid Adyen webhook payload: missing notificationItems",
      );
    }

    const notification = notificationItems[0].NotificationRequestItem;

    // HMAC verification
    const validator = new HmacValidator();
    const isValid = validator.validateHMAC(
      notification as unknown as Types.notification.NotificationRequestItem,
      this.hmacKey,
    );
    if (!isValid) {
      throw new WebhookVerificationException(
        "Adyen webhook HMAC verification failed",
      );
    }

    const eventCode = notification.eventCode;
    const normalizedType = ADYEN_EVENT_MAP[eventCode];
    if (!normalizedType) {
      return null;
    }

    // AUTHORISATION with success: "false" means payment failed
    const eventType =
      eventCode === "AUTHORISATION" && notification.success === "false"
        ? WEBHOOK_PAYMENT_FAILED
        : normalizedType;

    // For REFUND/CHARGEBACK, the original charge is in originalReference
    const gatewayChargeId =
      eventCode === "AUTHORISATION"
        ? notification.pspReference
        : (notification.originalReference ?? notification.pspReference);

    return {
      eventType,
      gatewayProvider: GatewayProvider.Adyen,
      gatewayEventId: notification.pspReference,
      gatewayChargeId,
      amount: notification.amount.value,
      currency: notification.amount.currency.toLowerCase(),
      status: notification.success === "true" ? "succeeded" : "failed",
      metadata: (notification.additionalData as Record<string, unknown>) ?? {},
      receivedAt: new Date(),
    };
  }

  private async executeWithResilience<T>(
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.circuitBreaker.fire(action);
    } catch (error) {
      if (error instanceof BillingException) {
        throw error;
      }
      throw this.wrapError(operation, error);
    }
  }

  private wrapError(operation: string, error: unknown): Error {
    const originalError =
      error instanceof Error ? error.message : String(error);
    const originalStack = error instanceof Error ? error.stack : undefined;

    // Circuit breaker open errors
    if (error instanceof Error && error.message.includes("Breaker is open")) {
      return new GatewayUnavailableException(
        `Payment gateway unavailable: circuit breaker is open`,
        { operation, originalError },
      );
    }

    // Timeout errors from circuit breaker
    if (error instanceof Error && error.message.includes("Timed out")) {
      return new GatewayUnavailableException(
        `Payment gateway timeout for operation: ${operation}`,
        { operation, originalError },
      );
    }

    // Network/5xx errors
    if (
      error instanceof Error &&
      (error.message.includes("ETIMEDOUT") ||
        error.message.includes("ECONNREFUSED") ||
        /\b5\d{2}\b/.test(error.message))
    ) {
      return new GatewayUnavailableException(
        `Payment gateway error: ${originalError}`,
        { operation, originalStack },
      );
    }

    // Default: payment failed
    return new PaymentFailedException(
      `Payment operation failed: ${originalError}`,
      { operation, originalStack },
    );
  }
}
