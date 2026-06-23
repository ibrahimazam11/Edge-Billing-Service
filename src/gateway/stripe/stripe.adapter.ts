import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Stripe from "stripe";
import type { PaymentGateway, SetupIntentGateway } from "../gateway.interface";
import type {
  CustomerResult,
  PaymentMethodResult,
  ChargeResult,
  RefundResult,
  BalanceTransactionResult,
  SetupIntentResult,
  CreateCustomerInput,
  UpdateCustomerInput,
  CreateChargeInput,
  CreateRefundInput,
  GetBalanceTransactionsInput,
  CreateBankAccountSetupInput,
  CreateFinancialConnectionsSetupInput,
  CreateCardSetupInput,
  ConfirmSetupInput,
  VerifyMicrodepositsInput,
} from "../gateway.types";
import {
  mapStripeCustomer,
  mapStripePaymentMethod,
  mapStripeSource,
  mapStripePaymentIntent,
  mapStripeRefund,
  mapStripeBalanceTransaction,
} from "./stripe.types";
import { CircuitBreakerService } from "../circuit-breaker/circuit-breaker.service";
import { BillingException } from "../../common/exceptions/billing.exception";
import { PaymentFailedException } from "../../common/exceptions/payment-failed.exception";
import { GatewayUnavailableException } from "../../common/exceptions/gateway-unavailable.exception";
import { WebhookVerificationException } from "../../common/exceptions/webhook-verification.exception";
import { GatewayProvider } from "../../common/enums/gateway-provider.enum";
import type {
  NormalizedWebhookEvent,
  NormalizedWebhookEventType,
} from "../../common/interfaces/normalized-webhook-event.interface";
import {
  WEBHOOK_PAYMENT_SUCCEEDED,
  WEBHOOK_PAYMENT_FAILED,
  WEBHOOK_REFUND_COMPLETED,
  WEBHOOK_MANDATE_UPDATED,
} from "../../common/constants/webhook-event-types";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

const STRIPE_EVENT_MAP: Record<string, NormalizedWebhookEventType> = {
  "payment_intent.succeeded": WEBHOOK_PAYMENT_SUCCEEDED,
  "payment_intent.payment_failed": WEBHOOK_PAYMENT_FAILED,
  "charge.refunded": WEBHOOK_REFUND_COMPLETED,
  "mandate.updated": WEBHOOK_MANDATE_UPDATED,
};

export class StripeAdapter implements PaymentGateway, SetupIntentGateway {
  private readonly logger = new Logger(StripeAdapter.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    const secretKey = this.configService.get<string>("stripe.secretKey")!;
    const apiVersion = this.configService.get<string>("stripe.apiVersion")!;
    const apiBaseUrl = this.configService.get<string>("stripe.apiBaseUrl");

    const options: Stripe.StripeConfig = {
      apiVersion: apiVersion as Stripe.LatestApiVersion,
    };

    if (apiBaseUrl) {
      options.host = new URL(apiBaseUrl).hostname;
      options.port = parseInt(new URL(apiBaseUrl).port, 10);
      options.protocol = new URL(apiBaseUrl).protocol.replace(":", "") as
        | "http"
        | "https";
    }

    this.stripe = new Stripe(secretKey, options);
    this.webhookSecret = this.configService.get<string>(
      "stripe.webhookSecret",
    )!;
  }

  async createCustomer(input: CreateCustomerInput): Promise<CustomerResult> {
    return this.executeWithResilience("createCustomer", () =>
      this.stripe.customers.create({
        email: input.email,
        name: input.name,
        metadata: input.metadata,
      }),
    ).then(mapStripeCustomer);
  }

  async updateCustomer(
    customerId: string,
    input: UpdateCustomerInput,
  ): Promise<CustomerResult> {
    return this.executeWithResilience("updateCustomer", () =>
      this.stripe.customers.update(customerId, {
        email: input.email,
        name: input.name,
        metadata: input.metadata,
      }),
    ).then(mapStripeCustomer);
  }

  async getCustomer(stripeCustomerId: string): Promise<CustomerResult> {
    return this.executeWithResilience("getCustomer", async () => {
      const customer = await this.stripe.customers.retrieve(stripeCustomerId);
      if (customer.deleted) {
        throw new PaymentFailedException(
          `Stripe customer not found: ${stripeCustomerId}`,
          { operation: "getCustomer", reason: "stripe_customer_not_found" },
        );
      }
      return mapStripeCustomer(customer as Stripe.Customer);
    });
  }

  // Note: isDefault is always false from attach/detach — Stripe's attach/detach
  // responses don't include the customer's default payment method setting.
  // Use setDefaultPaymentMethod to explicitly set a default.
  async attachPaymentMethod(
    paymentMethodId: string,
    customerId: string,
  ): Promise<PaymentMethodResult> {
    return this.executeWithResilience("attachPaymentMethod", () =>
      this.stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      }),
    ).then((pm) => mapStripePaymentMethod(pm, false));
  }

  async detachPaymentMethod(
    paymentMethodId: string,
  ): Promise<PaymentMethodResult> {
    return this.executeWithResilience("detachPaymentMethod", () =>
      this.stripe.paymentMethods.detach(paymentMethodId),
    ).then((pm) => mapStripePaymentMethod(pm, false));
  }

  async setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<CustomerResult> {
    return this.executeWithResilience("setDefaultPaymentMethod", () =>
      this.stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      }),
    ).then(mapStripeCustomer);
  }

  async listPaymentMethods(customerId: string): Promise<PaymentMethodResult[]> {
    return this.executeWithResilience("listPaymentMethods", async () => {
      // Modern API: returns pm_* objects.
      // Legacy API: returns ba_* (BankAccount) and src_* (Source) — required for existing
      // customers migrated from the monolith. paymentMethods.list does NOT include legacy
      // ids; without the listSources merge, ~813 existing customers appear to have no PM.
      //
      // Both API endpoints are paginated to follow has_more — a single 100-item page would
      // silently truncate fat-tail customers (and could miss their actual default PM if it
      // lives past position 100).
      const pmObjects: Stripe.PaymentMethod[] = [];
      let pmStartingAfter: string | undefined;
      while (true) {
        const page = await this.stripe.paymentMethods.list({
          customer: customerId,
          limit: 100,
          ...(pmStartingAfter ? { starting_after: pmStartingAfter } : {}),
        });
        pmObjects.push(...page.data);
        if (!page.has_more || page.data.length === 0) break;
        pmStartingAfter = page.data[page.data.length - 1].id;
      }

      const sourceObjects: Array<
        Stripe.BankAccount | Stripe.Card | Stripe.Source
      > = [];
      let srcStartingAfter: string | undefined;
      while (true) {
        const page = await this.stripe.customers.listSources(customerId, {
          limit: 100,
          ...(srcStartingAfter ? { starting_after: srcStartingAfter } : {}),
        });
        sourceObjects.push(
          ...(page.data as Array<
            Stripe.BankAccount | Stripe.Card | Stripe.Source
          >),
        );
        if (!page.has_more || page.data.length === 0) break;
        srcStartingAfter = page.data[page.data.length - 1].id;
      }

      const mapped: PaymentMethodResult[] = [
        ...pmObjects.map((pm) => mapStripePaymentMethod(pm, false)),
        ...sourceObjects.map((s) => mapStripeSource(s, false)),
      ];
      // De-dupe by id (defensive — Stripe shouldn't return the same id from both endpoints,
      // but Sources API and PaymentMethods API have historically overlapped during deprecation
      // windows).
      const seen = new Set<string>();
      return mapped.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
    });
  }

  async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
    return this.executeWithResilience("createCharge", () =>
      this.stripe.paymentIntents.create(
        {
          amount: input.amount,
          currency: input.currency,
          customer: input.customerId,
          payment_method: input.paymentMethodId,
          confirm: true,
          automatic_payment_methods: {
            enabled: true,
            allow_redirects: "never",
          },
          description: input.description,
          metadata: input.metadata,
          // ACH (us_bank_account) requires the mandate from the SetupIntent that produced this
          // payment method, plus off_session:true since these are merchant-initiated debits
          // (automated invoice/salary billing, customer not present). Both omitted for cards —
          // Stripe rejects mandate on non-mandate PM types, and off_session would force 3DS
          // hard-failures on cards that currently succeed synchronously.
          ...(input.mandateId
            ? { mandate: input.mandateId, off_session: true }
            : {}),
        },
        input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : undefined,
      ),
    ).then(mapStripePaymentIntent);
  }

  async createRefund(input: CreateRefundInput): Promise<RefundResult> {
    return this.executeWithResilience("createRefund", () =>
      this.stripe.refunds.create(
        {
          payment_intent: input.chargeId,
          amount: input.amount,
          reason: input.reason as Stripe.RefundCreateParams.Reason,
        },
        input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : undefined,
      ),
    ).then(mapStripeRefund);
  }

  async getBalanceTransactions(
    input?: GetBalanceTransactionsInput,
  ): Promise<BalanceTransactionResult[]> {
    const allTransactions: BalanceTransactionResult[] = [];
    let startingAfter = input?.startingAfter;
    const limit = input?.limit ?? 100;

    const createdFilter =
      input?.createdGte || input?.createdLte || input?.createdLt
        ? {
            ...(input.createdGte ? { gte: input.createdGte } : {}),
            ...(input.createdLte ? { lte: input.createdLte } : {}),
            ...(input.createdLt ? { lt: input.createdLt } : {}),
          }
        : undefined;

    while (true) {
      const params: Stripe.BalanceTransactionListParams = {
        limit,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
        ...(createdFilter ? { created: createdFilter } : {}),
      };

      const result = await this.executeWithResilience(
        "getBalanceTransactions",
        () => this.stripe.balanceTransactions.list(params),
      );

      allTransactions.push(...result.data.map(mapStripeBalanceTransaction));

      if (!result.has_more || result.data.length === 0) {
        break;
      }

      startingAfter = result.data[result.data.length - 1].id;
    }

    return allTransactions;
  }

  // --- Setup Intent lifecycle ---

  async createBankAccountSetup(
    input: CreateBankAccountSetupInput,
  ): Promise<SetupIntentResult> {
    return this.executeWithResilience("createBankAccountSetup", async () => {
      const si = await this.stripe.setupIntents.create({
        customer: input.customerId,
        payment_method_types: ["us_bank_account"],
        payment_method_data: {
          type: "us_bank_account",
          us_bank_account: {
            routing_number: input.routingNumber,
            account_number: input.accountNumber,
            account_holder_type: input.accountHolderType,
            account_type: input.accountType,
          },
          billing_details: {
            name: input.accountHolderName ?? undefined,
            email: input.billingEmail ?? undefined,
          },
        },
        payment_method_options: {
          us_bank_account: {
            verification_method:
              "skip" as Stripe.SetupIntentCreateParams.PaymentMethodOptions.UsBankAccount.VerificationMethod,
          },
        },
        mandate_data: {
          customer_acceptance: {
            type: "offline",
            accepted_at: Math.floor(Date.now() / 1000),
          },
        },
        confirm: true,
      });
      return this.mapSetupIntent(si);
    });
  }

  async createFinancialConnectionsSetup(
    input: CreateFinancialConnectionsSetupInput,
  ): Promise<SetupIntentResult> {
    return this.executeWithResilience(
      "createFinancialConnectionsSetup",
      async () => {
        const si = await this.stripe.setupIntents.create({
          customer: input.customerId,
          payment_method_types: ["us_bank_account"],
          payment_method_options: {
            us_bank_account: {
              financial_connections: { permissions: ["payment_method"] },
              verification_method:
                "instant_or_skip" as Stripe.SetupIntentCreateParams.PaymentMethodOptions.UsBankAccount.VerificationMethod,
            },
          },
        });
        return this.mapSetupIntent(si);
      },
    );
  }

  async createCardSetup(
    input: CreateCardSetupInput,
  ): Promise<SetupIntentResult> {
    return this.executeWithResilience("createCardSetup", async () => {
      const si = await this.stripe.setupIntents.create({
        customer: input.customerId,
        payment_method_types: ["card"],
        usage: "off_session",
      });
      return this.mapSetupIntent(si);
    });
  }

  async retrieveSetupIntent(
    input: ConfirmSetupInput,
  ): Promise<SetupIntentResult> {
    return this.executeWithResilience("retrieveSetupIntent", async () => {
      const si = await this.stripe.setupIntents.retrieve(input.setupIntentId);
      return this.mapSetupIntent(si);
    });
  }

  async confirmSetup(input: ConfirmSetupInput): Promise<SetupIntentResult> {
    return this.executeWithResilience("confirmSetup", async () => {
      const si = await this.stripe.setupIntents.confirm(input.setupIntentId, {
        mandate_data: { customer_acceptance: { type: "offline" } },
      });
      return this.mapSetupIntent(si);
    });
  }

  async verifyMicrodeposits(
    input: VerifyMicrodepositsInput,
  ): Promise<SetupIntentResult> {
    return this.executeWithResilience("verifyMicrodeposits", async () => {
      const si = await this.stripe.setupIntents.verifyMicrodeposits(
        input.setupIntentId,
        { amounts: input.amounts },
      );
      return this.mapSetupIntent(si);
    });
  }

  private mapSetupIntent(si: Stripe.SetupIntent): SetupIntentResult {
    return {
      id: si.id,
      clientSecret: si.client_secret ?? "",
      status: si.status,
      paymentMethodId:
        typeof si.payment_method === "string"
          ? si.payment_method
          : (si.payment_method?.id ?? null),
      mandateId:
        typeof si.mandate === "string" ? si.mandate : (si.mandate?.id ?? null),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async verifyAndParseWebhook(
    rawPayload: string | Buffer,
    headers: Record<string, string>,
  ): Promise<NormalizedWebhookEvent | null> {
    const signature = headers["stripe-signature"];
    if (!signature) {
      throw new WebhookVerificationException("Missing stripe-signature header");
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawPayload,
        signature,
        this.webhookSecret,
      );
    } catch (error) {
      throw new WebhookVerificationException(
        `Stripe webhook signature verification failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    const normalizedType = STRIPE_EVENT_MAP[event.type];
    if (!normalizedType) {
      return null;
    }

    const dataObject = event.data.object as unknown as Record<string, unknown>;

    const result: NormalizedWebhookEvent = {
      eventType: normalizedType,
      gatewayProvider: GatewayProvider.Stripe,
      gatewayEventId: event.id,
      gatewayChargeId: dataObject.id as string,
      amount: dataObject.amount as number,
      currency: ((dataObject.currency as string | undefined) ?? "").toLowerCase(),
      status: dataObject.status as string,
      metadata: {
        ...((dataObject.metadata as Record<string, unknown>) ?? {}),
        ...(typeof dataObject.payment_method === "string"
          ? { paymentMethodId: dataObject.payment_method }
          : {}),
      },
      receivedAt: new Date(),
    };

    // For payment failures, capture error details in metadata
    if (normalizedType === WEBHOOK_PAYMENT_FAILED) {
      const lastPaymentError = dataObject.last_payment_error as
        | Record<string, unknown>
        | null
        | undefined;
      if (lastPaymentError) {
        result.metadata = {
          ...result.metadata,
          failureCode: lastPaymentError.code as string | undefined,
          failureMessage: lastPaymentError.message as string | undefined,
        };
      }
    }

    return result;
  }

  private async executeWithResilience<T>(
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const retryableAction = () => this.withRetry(operation, action);
    try {
      return await this.circuitBreaker.fire(retryableAction);
    } catch (error) {
      // Don't re-wrap domain exceptions thrown explicitly in the action
      if (error instanceof BillingException) {
        throw error;
      }
      throw this.wrapError(operation, error);
    }
  }

  private async withRetry<T>(
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await action();
      } catch (error) {
        lastError = error;

        if (!this.isRetryable(error)) {
          throw error;
        }

        if (attempt < MAX_RETRIES) {
          const delay = this.calculateDelay(attempt);
          this.logger.debug({
            action: "stripe.retry",
            operation,
            attempt,
            maxRetries: MAX_RETRIES,
            delayMs: delay,
            error: error instanceof Error ? error.message : String(error),
          });
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof Stripe.errors.StripeError) {
      const statusCode = error.statusCode;
      // Retry on 5xx, 429 (rate limit), and connection errors
      if (statusCode && statusCode >= 500) return true;
      if (statusCode === 429) return true;
      if (error.type === "StripeConnectionError") return true;
      // Do not retry other 4xx errors
      return false;
    }
    // Retry on network-level errors (e.g., timeouts)
    if (error instanceof Error && error.message.includes("ETIMEDOUT")) {
      return true;
    }
    return false;
  }

  private calculateDelay(attempt: number): number {
    const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = Math.random() * exponentialDelay;
    return Math.floor(exponentialDelay + jitter);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

    // Stripe errors
    if (error instanceof Stripe.errors.StripeError) {
      const statusCode = error.statusCode;
      if (statusCode && statusCode >= 500) {
        return new GatewayUnavailableException(
          `Payment gateway error: ${error.message}`,
          { operation, stripeCode: error.code, statusCode, originalStack },
        );
      }
      return new PaymentFailedException(
        `Payment operation failed: ${error.message}`,
        { operation, stripeCode: error.code, statusCode, originalStack },
      );
    }

    // Timeout errors from circuit breaker
    if (error instanceof Error && error.message.includes("Timed out")) {
      return new GatewayUnavailableException(
        `Payment gateway timeout for operation: ${operation}`,
        { operation, originalError },
      );
    }

    // Unknown errors
    if (error instanceof Error) {
      return new PaymentFailedException(
        `Payment operation failed: ${error.message}`,
        { operation, originalStack },
      );
    }

    return new PaymentFailedException(
      `Payment operation failed: unknown error`,
      { operation, originalError },
    );
  }
}
