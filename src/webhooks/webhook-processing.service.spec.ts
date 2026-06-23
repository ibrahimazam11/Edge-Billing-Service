import { Logger } from "@nestjs/common";
import { WebhookProcessingService } from "./webhook-processing.service";
import type { DrizzleDatabase } from "../database/types";
import type { GatewayRegistry } from "../gateway/gateway.registry";
import type { LedgerService } from "../ledger/ledger.service";
import type { SqsProducerService } from "../integration/sqs/sqs-producer.service";
import type { IdempotencyService } from "../integration/sqs/idempotency.service";
import type { ChargesRepository } from "../charges/charges.repository";
import type { InvoicesRepository } from "../invoices/invoices.repository";
import type { StripeWebhookReceivedPayload } from "../integration/sqs/contracts/inbound-events";
import type { NormalizedWebhookEvent } from "../common/interfaces/normalized-webhook-event.interface";
import { GatewayProvider } from "../common/enums/gateway-provider.enum";

describe("WebhookProcessingService", () => {
  let service: WebhookProcessingService;
  let mockIdempotencyService: {
    isProcessed: jest.Mock;
    markProcessed: jest.Mock;
  };
  let mockAdapter: {
    verifyAndParseWebhook: jest.Mock;
  };
  let mockGatewayRegistry: {
    getAdapter: jest.Mock;
  };
  let mockLedgerService: {
    recordPaymentSucceeded: jest.Mock;
  };
  let mockSqsProducerService: {
    publish: jest.Mock;
  };
  let mockSubscriptionsService: {
    advanceBillingPeriod: jest.Mock;
  };

  let mockChargesRepo: {
    findByStripePaymentIntentId: jest.Mock;
    updateStatus: jest.Mock;
  };
  let mockInvoicesRepo: {
    findById: jest.Mock;
    update: jest.Mock;
  };

  let mockWebhookEventsRepo: {
    logEvent: jest.Mock;
    updateStatus: jest.Mock;
    findByStripeEventId: jest.Mock;
  };

  // Transaction mock — service still orchestrates tx boundaries
  const txMock = { id: "tx-mock" };
  let mockDb: {
    transaction: jest.Mock;
  };

  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  const correlationId = "corr-test-123";

  beforeEach(() => {
    mockChargesRepo = {
      findByStripePaymentIntentId: jest.fn().mockResolvedValue(null),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };

    mockInvoicesRepo = {
      findById: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
    };

    mockDb = {
      transaction: jest.fn((cb: (tx: unknown) => Promise<void>) => cb(txMock)),
    };

    mockIdempotencyService = {
      isProcessed: jest.fn().mockResolvedValue(false),
      markProcessed: jest.fn().mockResolvedValue(undefined),
    };

    mockAdapter = {
      verifyAndParseWebhook: jest.fn().mockResolvedValue(null),
    };

    mockGatewayRegistry = {
      getAdapter: jest.fn().mockReturnValue(mockAdapter),
    };

    mockLedgerService = {
      recordPaymentSucceeded: jest.fn().mockResolvedValue("ledger-entry-id"),
    };

    mockSqsProducerService = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    mockSubscriptionsService = {
      advanceBillingPeriod: jest.fn().mockResolvedValue(undefined),
    };

    mockWebhookEventsRepo = {
      logEvent: jest.fn().mockResolvedValue({ id: "wh-evt-mock-id" }),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      findByStripeEventId: jest.fn().mockResolvedValue([]),
    };

    const mockCustomersRepo = {
      findById: jest
        .fn()
        .mockResolvedValue({ monolithCustomerId: "mono-cust-1" }),
    };

    const mockPaymentMethodsRepo = {
      findByStripePaymentMethodId: jest.fn().mockResolvedValue(null),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };

    service = new WebhookProcessingService(
      mockDb as unknown as DrizzleDatabase,
      mockGatewayRegistry as unknown as GatewayRegistry,
      mockLedgerService as unknown as LedgerService,
      mockSqsProducerService as unknown as SqsProducerService,
      mockIdempotencyService as unknown as IdempotencyService,
      mockChargesRepo as unknown as ChargesRepository,
      mockInvoicesRepo as unknown as InvoicesRepository,
      mockCustomersRepo as any,
      mockWebhookEventsRepo as any,
      mockPaymentMethodsRepo as any,
      mockSubscriptionsService,
    );

    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    debugSpy = jest
      .spyOn(Logger.prototype, "debug")
      .mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createWebhookPayload(
    type: string,
    data: Record<string, unknown> = {},
    stripeEventId = "evt_test_123",
  ): StripeWebhookReceivedPayload {
    return {
      stripeEventId,
      type,
      data,
      signature: "sig_test_abc",
    };
  }

  function makeSucceededEvent(
    overrides: Partial<NormalizedWebhookEvent> = {},
  ): NormalizedWebhookEvent {
    return {
      eventType: "payment.succeeded",
      gatewayProvider: GatewayProvider.Stripe,
      gatewayEventId: "evt_test_123",
      gatewayChargeId: "pi_test_123",
      amount: 10000,
      currency: "usd",
      status: "succeeded",
      metadata: {},
      receivedAt: new Date(),
      ...overrides,
    };
  }

  function makeFailedEvent(
    overrides: Partial<NormalizedWebhookEvent> = {},
  ): NormalizedWebhookEvent {
    return {
      eventType: "payment.failed",
      gatewayProvider: GatewayProvider.Stripe,
      gatewayEventId: "evt_test_123",
      gatewayChargeId: "pi_test_123",
      amount: 10000,
      currency: "usd",
      status: "requires_payment_method",
      metadata: {
        failureCode: "card_declined",
        failureMessage: "Your card was declined.",
      },
      receivedAt: new Date(),
      ...overrides,
    };
  }

  const mockCharge = {
    id: "charge-1",
    invoiceId: "invoice-1",
    customerId: "customer-1",
    paymentMethodId: "pm-1",
    amountCents: 10000,
    currency: "usd",
    status: "pending",
    stripePaymentIntentId: "pi_test_123",
    idempotencyKey: "inv_invoice-1_att_1",
    failureReason: null,
    attemptNumber: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockInvoice = {
    id: "invoice-1",
    customerId: "customer-1",
    subscriptionId: "sub-1",
    status: "finalized",
    totalAmountCents: 10000,
    currency: "usd",
    billingPeriodStart: new Date(),
    billingPeriodEnd: new Date(),
    dueDate: new Date(),
    paidAt: null,
    voidedAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe("processWebhookEvent", () => {
    it("should skip already-processed Stripe event (idempotency)", async () => {
      mockIdempotencyService.isProcessed.mockResolvedValue(true);
      const payload = createWebhookPayload("payment_intent.succeeded");

      await service.processWebhookEvent(payload, correlationId);

      expect(mockIdempotencyService.isProcessed).toHaveBeenCalledWith(
        "evt_test_123",
        "stripe.webhook",
      );
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Skipping duplicate stripe event",
        }),
      );
      expect(
        mockChargesRepo.findByStripePaymentIntentId,
      ).not.toHaveBeenCalled();
      expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
      expect(mockAdapter.verifyAndParseWebhook).not.toHaveBeenCalled();
    });

    it("should continue processing when adapter verification fails (defense-in-depth)", async () => {
      mockAdapter.verifyAndParseWebhook.mockRejectedValue(
        new Error("Signature verification failed"),
      );
      const payload = createWebhookPayload("payment_intent.succeeded", {
        id: "pi_test_123",
        amount: 10000,
        currency: "usd",
        status: "succeeded",
        metadata: {},
      });
      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);

      await service.processWebhookEvent(payload, correlationId);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "stripe webhook signature re-verification failed (monolith already verified, continuing)",
        }),
      );
      // Should still proceed with processing (repo was called via fallback event)
      expect(mockChargesRepo.findByStripePaymentIntentId).toHaveBeenCalled();
    });

    it("should log warning for unsupported event types and acknowledge", async () => {
      // Adapter returns null for unmapped type
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(null);
      const payload = createWebhookPayload("charge.dispute.created");

      await service.processWebhookEvent(payload, correlationId);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Unsupported webhook event type",
          type: "charge.dispute.created",
        }),
      );
      expect(mockIdempotencyService.markProcessed).toHaveBeenCalledWith(
        "evt_test_123",
        "stripe.webhook",
      );
    });

    it("should mark Stripe event ID as processed after successful handling", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(makeSucceededEvent());

      const payload = createWebhookPayload("payment_intent.succeeded", {
        id: "pi_test_123",
      });

      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);
      mockInvoicesRepo.findById.mockResolvedValue(mockInvoice);

      await service.processWebhookEvent(payload, correlationId);

      expect(mockIdempotencyService.markProcessed).toHaveBeenCalledWith(
        "evt_test_123",
        "stripe.webhook",
      );
    });

    it("should resolve adapter from GatewayRegistry with correct provider", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(null);
      const payload = createWebhookPayload("customer.updated");

      await service.processWebhookEvent(payload, correlationId);

      expect(mockGatewayRegistry.getAdapter).toHaveBeenCalledWith(
        GatewayProvider.Stripe,
      );
    });

    it("should pass correct rawPayload and headers to adapter.verifyAndParseWebhook", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(null);
      const data = { id: "pi_123", amount: 5000 };
      const payload = createWebhookPayload("payment_intent.succeeded", data);

      await service.processWebhookEvent(payload, correlationId);

      expect(mockAdapter.verifyAndParseWebhook).toHaveBeenCalledWith(
        JSON.stringify(data),
        { "stripe-signature": "sig_test_abc" },
      );
    });

    it("should skip processing via fallback when verification fails for unmapped event type", async () => {
      mockAdapter.verifyAndParseWebhook.mockRejectedValue(
        new Error("Signature verification failed"),
      );
      // Unmapped type — fallback also returns null
      const payload = createWebhookPayload("customer.updated", {});

      await service.processWebhookEvent(payload, correlationId);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "stripe webhook signature re-verification failed (monolith already verified, continuing)",
        }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Unsupported webhook event type",
          type: "customer.updated",
        }),
      );
      expect(
        mockChargesRepo.findByStripePaymentIntentId,
      ).not.toHaveBeenCalled();
    });

    it("should NOT call StripeWebhookService.verifyWebhookSignature (migration complete)", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(makeSucceededEvent());
      const payload = createWebhookPayload("payment_intent.succeeded", {
        id: "pi_test_123",
      });
      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);

      await service.processWebhookEvent(payload, correlationId);

      // Verify adapter was used, not StripeWebhookService
      expect(mockAdapter.verifyAndParseWebhook).toHaveBeenCalled();
      // No StripeWebhookService mock exists — if it were called, it would throw
    });
  });

  describe("payment.succeeded (normalized)", () => {
    it("should handle no matching charge — log warn and return", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(makeSucceededEvent());
      const payload = createWebhookPayload("payment_intent.succeeded", {
        id: "pi_test_123",
      });
      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(null);

      await service.processWebhookEvent(payload, correlationId);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "No matching charge found for payment_intent.succeeded webhook",
          paymentIntentId: "pi_test_123",
        }),
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockIdempotencyService.markProcessed).toHaveBeenCalled();
    });

    it("should handle invoice already paid — no-op", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(makeSucceededEvent());
      const payload = createWebhookPayload("payment_intent.succeeded", {
        id: "pi_test_123",
      });

      const paidInvoice = { ...mockInvoice, status: "paid" };
      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);
      mockInvoicesRepo.findById.mockResolvedValue(paidInvoice);

      await service.processWebhookEvent(payload, correlationId);

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Invoice already paid via webhook (no-op)",
        }),
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockSqsProducerService.publish).not.toHaveBeenCalled();
    });

    it("should be a no-op when charge already succeeded (direct path completed first)", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(makeSucceededEvent());
      const payload = createWebhookPayload("payment_intent.succeeded", {
        id: "pi_test_123",
      });

      const succeededCharge = { ...mockCharge, status: "succeeded" };
      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(
        succeededCharge,
      );
      mockInvoicesRepo.findById.mockResolvedValue(mockInvoice);

      await service.processWebhookEvent(payload, correlationId);

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Charge already succeeded via direct path (webhook no-op)",
        }),
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockSqsProducerService.publish).not.toHaveBeenCalled();
    });

    it("should log warning when invoice is in unexpected status (e.g., void)", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(makeSucceededEvent());
      const payload = createWebhookPayload("payment_intent.succeeded", {
        id: "pi_test_123",
      });

      const voidInvoice = { ...mockInvoice, status: "void" };
      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);
      mockInvoicesRepo.findById.mockResolvedValue(voidInvoice);

      await service.processWebhookEvent(payload, correlationId);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "Invoice in unexpected status for payment_intent.succeeded webhook",
          invoiceStatus: "void",
        }),
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should process finalized invoice — transaction, advance billing period, publish events", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(makeSucceededEvent());
      const payload = createWebhookPayload("payment_intent.succeeded", {
        id: "pi_test_123",
      });

      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);
      mockInvoicesRepo.findById.mockResolvedValue(mockInvoice);

      await service.processWebhookEvent(payload, correlationId);

      // Verify transaction was called
      expect(mockDb.transaction).toHaveBeenCalled();

      // Verify charge updated inside transaction with tx passed
      expect(mockChargesRepo.updateStatus).toHaveBeenCalledWith(
        "charge-1",
        expect.objectContaining({
          status: "succeeded",
        }),
        txMock,
      );

      // Verify invoice updated inside transaction with tx passed
      expect(mockInvoicesRepo.update).toHaveBeenCalledWith(
        "invoice-1",
        expect.objectContaining({
          status: "paid",
        }),
        txMock,
      );

      // Verify ledger entry inside transaction
      expect(mockLedgerService.recordPaymentSucceeded).toHaveBeenCalledWith(
        "charge-1",
        10000,
        "usd",
        correlationId,
        txMock,
      );

      // Verify billing period is NOT advanced by webhook — advance moved to finalization path
      expect(
        mockSubscriptionsService.advanceBillingPeriod,
      ).not.toHaveBeenCalled();

      // Verify SQS events published
      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "payment.succeeded",
        expect.objectContaining({
          invoiceId: "invoice-1",
          customerId: "customer-1",
          amountCents: 10000,
          stripePaymentIntentId: "pi_test_123",
        }),
        correlationId,
      );

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "invoice.paid",
        expect.objectContaining({
          invoiceId: "invoice-1",
          customerId: "customer-1",
          totalAmountCents: 10000,
        }),
        correlationId,
      );
    });

    it("should NOT advance billing period (advance moved to invoice finalization path)", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(makeSucceededEvent());
      const payload = createWebhookPayload("payment_intent.succeeded", {
        id: "pi_test_123",
      });

      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);
      mockInvoicesRepo.findById.mockResolvedValue(mockInvoice);

      await service.processWebhookEvent(payload, correlationId);

      expect(
        mockSubscriptionsService.advanceBillingPeriod,
      ).not.toHaveBeenCalled();

      // Events should still be published
      expect(mockSqsProducerService.publish).toHaveBeenCalledTimes(2);
    });

    it("should handle invoice not found — log warn and return", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(makeSucceededEvent());
      const payload = createWebhookPayload("payment_intent.succeeded", {
        id: "pi_test_123",
      });

      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);
      mockInvoicesRepo.findById.mockResolvedValue(null);

      await service.processWebhookEvent(payload, correlationId);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Invoice not found for charge",
        }),
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  describe("payment.failed (normalized)", () => {
    it("should handle no matching charge — log warn and return", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(makeFailedEvent());
      const payload = createWebhookPayload("payment_intent.payment_failed", {
        id: "pi_test_123",
        last_payment_error: {
          code: "card_declined",
          message: "Your card was declined.",
        },
      });
      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(null);

      await service.processWebhookEvent(payload, correlationId);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "No matching charge found for payment_intent.payment_failed webhook",
          paymentIntentId: "pi_test_123",
        }),
      );
      expect(mockChargesRepo.updateStatus).not.toHaveBeenCalled();
      expect(mockIdempotencyService.markProcessed).toHaveBeenCalled();
    });

    it("should update charge to failed and publish payment.failed event", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(makeFailedEvent());
      const payload = createWebhookPayload("payment_intent.payment_failed", {
        id: "pi_test_123",
        last_payment_error: {
          code: "card_declined",
          message: "Your card was declined.",
        },
      });

      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);
      mockInvoicesRepo.findById.mockResolvedValue(mockInvoice);

      await service.processWebhookEvent(payload, correlationId);

      // Verify charge updated (outside transaction — single statement)
      expect(mockChargesRepo.updateStatus).toHaveBeenCalledWith(
        "charge-1",
        expect.objectContaining({
          status: "failed",
          failureReason: "Your card was declined.",
        }),
      );

      // Verify payment.failed event published
      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "payment.failed",
        expect.objectContaining({
          invoiceId: "invoice-1",
          customerId: "customer-1",
          failureReason: "Your card was declined.",
          attemptNumber: 1,
        }),
        correlationId,
      );
    });

    it("should handle missing failureMessage in metadata gracefully", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(
        makeFailedEvent({ metadata: {} }),
      );
      const payload = createWebhookPayload("payment_intent.payment_failed", {
        id: "pi_test_123",
        last_payment_error: null,
      });

      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);
      mockInvoicesRepo.findById.mockResolvedValue(mockInvoice);

      await service.processWebhookEvent(payload, correlationId);

      expect(mockChargesRepo.updateStatus).toHaveBeenCalledWith(
        "charge-1",
        expect.objectContaining({
          status: "failed",
          failureReason: "Payment failed (no error details)",
        }),
      );
    });

    it("should log structured data for payment failure", async () => {
      mockAdapter.verifyAndParseWebhook.mockResolvedValue(makeFailedEvent());
      const payload = createWebhookPayload("payment_intent.payment_failed", {
        id: "pi_test_123",
        last_payment_error: {
          code: "card_declined",
          message: "Your card was declined.",
        },
      });

      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);
      mockInvoicesRepo.findById.mockResolvedValue(mockInvoice);

      await service.processWebhookEvent(payload, correlationId);

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Payment failed via webhook",
          chargeId: "charge-1",
          paymentIntentId: "pi_test_123",
          failureReason: "Your card was declined.",
        }),
      );
    });
  });

  describe("defense-in-depth fallback", () => {
    it("should construct fallback event and process when verification fails for payment_intent.succeeded", async () => {
      mockAdapter.verifyAndParseWebhook.mockRejectedValue(
        new Error("Signature failed"),
      );
      const payload = createWebhookPayload("payment_intent.succeeded", {
        id: "pi_test_123",
        amount: 10000,
        currency: "usd",
        status: "succeeded",
        metadata: {},
      });

      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);
      mockInvoicesRepo.findById.mockResolvedValue(mockInvoice);

      await service.processWebhookEvent(payload, correlationId);

      // Verification failed but processing continued via fallback
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "stripe webhook signature re-verification failed (monolith already verified, continuing)",
        }),
      );
      // Transaction should still happen (finalized invoice)
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "payment.succeeded",
        expect.objectContaining({
          stripePaymentIntentId: "pi_test_123",
        }),
        correlationId,
      );
    });

    it("should construct fallback event with failure metadata for payment_intent.payment_failed", async () => {
      mockAdapter.verifyAndParseWebhook.mockRejectedValue(
        new Error("Signature failed"),
      );
      const payload = createWebhookPayload("payment_intent.payment_failed", {
        id: "pi_test_123",
        amount: 10000,
        currency: "usd",
        status: "requires_payment_method",
        metadata: {},
        last_payment_error: {
          code: "card_declined",
          message: "Your card was declined.",
        },
      });

      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);
      mockInvoicesRepo.findById.mockResolvedValue(mockInvoice);

      await service.processWebhookEvent(payload, correlationId);

      // Should extract failureMessage from fallback metadata
      expect(mockChargesRepo.updateStatus).toHaveBeenCalledWith(
        "charge-1",
        expect.objectContaining({
          status: "failed",
          failureReason: "Your card was declined.",
        }),
      );
    });
  });

  describe("handleMandateUpdated", () => {
    let mandateService: WebhookProcessingService;
    let mockPmRepo: {
      findByStripePaymentMethodId: jest.Mock;
      updateStatus: jest.Mock;
    };
    let mockCustomersRepoMandate: { findById: jest.Mock };
    let mockAdapterMandate: {
      verifyAndParseWebhook: jest.Mock;
      detachPaymentMethod: jest.Mock;
    };
    let mockGatewayRegistryMandate: { getAdapter: jest.Mock };

    const mockBsPm = {
      id: "bs-pm-uuid",
      customerId: "bs-cust-uuid",
      stripePaymentMethodId: "pm_bank_abc",
      type: "bank_account",
      status: "active",
      isDefault: true,
      metadata: { mandate_id: "mandate_abc" },
      lastFour: "1234",
      bankName: "Test Bank",
      brand: null,
      fingerprint: null,
      expiryMonth: null,
      expiryYear: null,
      fallbackOrder: null,
      gatewayProvider: "stripe",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockBsCustomer = {
      id: "bs-cust-uuid",
      monolithCustomerId: "mono-cust-abc",
    };

    function makeMandateEvent(
      overrides: Partial<NormalizedWebhookEvent> = {},
    ): NormalizedWebhookEvent {
      return {
        eventType: "mandate.updated",
        gatewayProvider: GatewayProvider.Stripe,
        gatewayEventId: "evt_mandate_123",
        gatewayChargeId: "mandate_abc",
        amount: 0,
        currency: "",
        status: "inactive",
        metadata: { paymentMethodId: "pm_bank_abc" },
        receivedAt: new Date(),
        ...overrides,
      };
    }

    function createMandatePayload(
      status = "inactive",
      stripeEventId = "evt_mandate_123",
    ): StripeWebhookReceivedPayload {
      return {
        stripeEventId,
        type: "mandate.updated",
        data: { id: "mandate_abc", status, payment_method: "pm_bank_abc" },
        signature: "sig_test_abc",
      };
    }

    beforeEach(() => {
      mockPmRepo = {
        findByStripePaymentMethodId: jest.fn().mockResolvedValue(mockBsPm),
        updateStatus: jest.fn().mockResolvedValue(undefined),
      };

      mockCustomersRepoMandate = {
        findById: jest.fn().mockResolvedValue(mockBsCustomer),
      };

      mockAdapterMandate = {
        verifyAndParseWebhook: jest.fn().mockResolvedValue(null),
        detachPaymentMethod: jest.fn().mockResolvedValue({ id: "pm_bank_abc" }),
      };

      mockGatewayRegistryMandate = {
        getAdapter: jest.fn().mockReturnValue(mockAdapterMandate),
      };

      mandateService = new WebhookProcessingService(
        mockDb as unknown as DrizzleDatabase,
        mockGatewayRegistryMandate as unknown as GatewayRegistry,
        mockLedgerService as unknown as LedgerService,
        mockSqsProducerService as unknown as SqsProducerService,
        mockIdempotencyService as unknown as IdempotencyService,
        mockChargesRepo as unknown as ChargesRepository,
        mockInvoicesRepo as unknown as InvoicesRepository,
        mockCustomersRepoMandate as any,
        mockWebhookEventsRepo as any,
        mockPmRepo as any,
      );
    });

    it("should skip when mandate status is not inactive", async () => {
      mockAdapterMandate.verifyAndParseWebhook.mockResolvedValue(
        makeMandateEvent({ status: "active" }),
      );

      await mandateService.processWebhookEvent(
        createMandatePayload("active"),
        correlationId,
      );

      expect(mockPmRepo.findByStripePaymentMethodId).not.toHaveBeenCalled();
      expect(mockPmRepo.updateStatus).not.toHaveBeenCalled();
      expect(mockSqsProducerService.publish).not.toHaveBeenCalled();
    });

    it("should warn and skip when paymentMethodId is missing from event metadata", async () => {
      mockAdapterMandate.verifyAndParseWebhook.mockResolvedValue(
        makeMandateEvent({ metadata: {} }),
      );

      await mandateService.processWebhookEvent(
        createMandatePayload(),
        correlationId,
      );

      expect(mockPmRepo.findByStripePaymentMethodId).not.toHaveBeenCalled();
      expect(mockPmRepo.updateStatus).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("no payment_method"),
        }),
      );
    });

    it("should skip when PM not found in BS (non-BS customer)", async () => {
      mockAdapterMandate.verifyAndParseWebhook.mockResolvedValue(
        makeMandateEvent(),
      );
      mockPmRepo.findByStripePaymentMethodId.mockResolvedValue(null);

      await mandateService.processWebhookEvent(
        createMandatePayload(),
        correlationId,
      );

      expect(mockAdapterMandate.detachPaymentMethod).not.toHaveBeenCalled();
      expect(mockPmRepo.updateStatus).not.toHaveBeenCalled();
      expect(mockSqsProducerService.publish).not.toHaveBeenCalled();
    });

    it("should skip when PM type is not bank_account", async () => {
      mockAdapterMandate.verifyAndParseWebhook.mockResolvedValue(
        makeMandateEvent(),
      );
      mockPmRepo.findByStripePaymentMethodId.mockResolvedValue({
        ...mockBsPm,
        type: "card",
      });

      await mandateService.processWebhookEvent(
        createMandatePayload(),
        correlationId,
      );

      expect(mockAdapterMandate.detachPaymentMethod).not.toHaveBeenCalled();
      expect(mockPmRepo.updateStatus).not.toHaveBeenCalled();
    });

    it("should skip when PM is already detached (idempotent)", async () => {
      mockAdapterMandate.verifyAndParseWebhook.mockResolvedValue(
        makeMandateEvent(),
      );
      mockPmRepo.findByStripePaymentMethodId.mockResolvedValue({
        ...mockBsPm,
        status: "detached",
      });

      await mandateService.processWebhookEvent(
        createMandatePayload(),
        correlationId,
      );

      expect(mockAdapterMandate.detachPaymentMethod).not.toHaveBeenCalled();
      expect(mockPmRepo.updateStatus).not.toHaveBeenCalled();
      expect(mockSqsProducerService.publish).not.toHaveBeenCalled();
    });

    it("should detach PM, mark detached, and publish mandate.deactivated on happy path", async () => {
      mockAdapterMandate.verifyAndParseWebhook.mockResolvedValue(
        makeMandateEvent(),
      );

      await mandateService.processWebhookEvent(
        createMandatePayload(),
        correlationId,
      );

      expect(mockAdapterMandate.detachPaymentMethod).toHaveBeenCalledWith(
        "pm_bank_abc",
      );
      expect(mockPmRepo.updateStatus).toHaveBeenCalledWith(
        "bs-pm-uuid",
        "detached",
        expect.objectContaining({
          metadata: expect.objectContaining({ mandate_id: null }),
        }),
      );
      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "mandate.deactivated",
        {
          customerId: "bs-cust-uuid",
          monolithCustomerId: "mono-cust-abc",
          paymentMethodId: "bs-pm-uuid",
          stripePaymentMethodId: "pm_bank_abc",
          mandateId: "mandate_abc",
        },
        correlationId,
      );
    });

    it("should still mark detached and publish when Stripe detach fails (best-effort)", async () => {
      mockAdapterMandate.verifyAndParseWebhook.mockResolvedValue(
        makeMandateEvent(),
      );
      mockAdapterMandate.detachPaymentMethod.mockRejectedValue(
        new Error("Stripe unavailable"),
      );

      await mandateService.processWebhookEvent(
        createMandatePayload(),
        correlationId,
      );

      expect(mockPmRepo.updateStatus).toHaveBeenCalledWith(
        "bs-pm-uuid",
        "detached",
        expect.objectContaining({
          metadata: expect.objectContaining({ mandate_id: null }),
        }),
      );
      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "mandate.deactivated",
        expect.objectContaining({ paymentMethodId: "bs-pm-uuid" }),
        correlationId,
      );
    });

    it("should detach PM in DB but not publish when customer not found in BS", async () => {
      mockAdapterMandate.verifyAndParseWebhook.mockResolvedValue(
        makeMandateEvent(),
      );
      mockCustomersRepoMandate.findById.mockResolvedValue(null);

      await mandateService.processWebhookEvent(
        createMandatePayload(),
        correlationId,
      );

      expect(mockPmRepo.updateStatus).toHaveBeenCalledWith(
        "bs-pm-uuid",
        "detached",
        expect.anything(),
      );
      expect(mockSqsProducerService.publish).not.toHaveBeenCalled();
    });

    it("should preserve existing metadata fields when clearing mandate_id", async () => {
      mockAdapterMandate.verifyAndParseWebhook.mockResolvedValue(
        makeMandateEvent(),
      );
      mockPmRepo.findByStripePaymentMethodId.mockResolvedValue({
        ...mockBsPm,
        metadata: { mandate_id: "mandate_abc", account_type: "checking" },
      });

      await mandateService.processWebhookEvent(
        createMandatePayload(),
        correlationId,
      );

      expect(mockPmRepo.updateStatus).toHaveBeenCalledWith(
        "bs-pm-uuid",
        "detached",
        expect.objectContaining({
          metadata: { mandate_id: null, account_type: "checking" },
        }),
      );
    });

    it("should be idempotent across duplicate webhook events", async () => {
      mockAdapterMandate.verifyAndParseWebhook.mockResolvedValue(
        makeMandateEvent(),
      );
      mockIdempotencyService.isProcessed
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await mandateService.processWebhookEvent(
        createMandatePayload(),
        correlationId,
      );
      await mandateService.processWebhookEvent(
        createMandatePayload(),
        correlationId,
      );

      expect(mockAdapterMandate.detachPaymentMethod).toHaveBeenCalledTimes(1);
      expect(mockPmRepo.updateStatus).toHaveBeenCalledTimes(1);
      expect(mockSqsProducerService.publish).toHaveBeenCalledTimes(1);
    });
  });

  describe("service without SubscriptionsService", () => {
    it("should process webhook normally when SubscriptionsService not injected (optional dep)", async () => {
      const mockCustomersRepoNoSubs = {
        findById: jest
          .fn()
          .mockResolvedValue({ monolithCustomerId: "mono-cust-1" }),
      };
      const serviceNoSubs = new WebhookProcessingService(
        mockDb as unknown as DrizzleDatabase,
        mockGatewayRegistry as unknown as GatewayRegistry,
        mockLedgerService as unknown as LedgerService,
        mockSqsProducerService as unknown as SqsProducerService,
        mockIdempotencyService as unknown as IdempotencyService,
        mockChargesRepo as unknown as ChargesRepository,
        mockInvoicesRepo as unknown as InvoicesRepository,
        mockCustomersRepoNoSubs as any,
        mockWebhookEventsRepo as any,
        { findByStripePaymentMethodId: jest.fn().mockResolvedValue(null), updateStatus: jest.fn() } as any,
      );

      mockAdapter.verifyAndParseWebhook.mockResolvedValue(makeSucceededEvent());
      const payload = createWebhookPayload("payment_intent.succeeded", {
        id: "pi_test_123",
      });

      mockChargesRepo.findByStripePaymentIntentId.mockResolvedValue(mockCharge);
      mockInvoicesRepo.findById.mockResolvedValue(mockInvoice);

      await serviceNoSubs.processWebhookEvent(payload, correlationId);

      // Transaction should still happen
      expect(mockDb.transaction).toHaveBeenCalled();
      // But no billing period advance attempted
      expect(
        mockSubscriptionsService.advanceBillingPeriod,
      ).not.toHaveBeenCalled();
    });
  });
});
