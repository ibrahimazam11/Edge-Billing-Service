import { MonolithEventsConsumer } from "./monolith-events.consumer";
import { IdempotencyService } from "../idempotency.service";
import { Logger } from "@nestjs/common";
import type { Message as SqsMessage } from "@aws-sdk/client-sqs";
import type { SqsEnvelope } from "../../../common/interfaces/envelope.interface";
import type { CustomersService } from "../../../customers/customers.service";
import type { SubscriptionsService } from "../../../subscriptions/subscriptions.service";
import type { WebhookProcessingService } from "../../../webhooks/webhook-processing.service";

describe("MonolithEventsConsumer", () => {
  let consumer: MonolithEventsConsumer;
  let mockIdempotencyService: {
    isProcessed: jest.Mock;
    markProcessed: jest.Mock;
  };
  let mockCustomersService: {
    createFromEvent: jest.Mock;
    updateFromEvent: jest.Mock;
    findByMonolithId: jest.Mock;
  };
  let mockSubscriptionsService: {
    updatePricing: jest.Mock;
    applyPayrollUpdate: jest.Mock;
  };
  let mockWebhookProcessingService: {
    processWebhookEvent: jest.Mock;
  };
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockIdempotencyService = {
      isProcessed: jest.fn().mockResolvedValue(false),
      markProcessed: jest.fn().mockResolvedValue(undefined),
    };

    mockCustomersService = {
      createFromEvent: jest.fn().mockResolvedValue({ id: "cust-1" }),
      updateFromEvent: jest.fn().mockResolvedValue({ id: "cust-1" }),
      findByMonolithId: jest.fn().mockResolvedValue(null),
    };

    mockSubscriptionsService = {
      updatePricing: jest.fn().mockResolvedValue(0),
      applyPayrollUpdate: jest.fn().mockResolvedValue(0),
    };

    mockWebhookProcessingService = {
      processWebhookEvent: jest.fn().mockResolvedValue(undefined),
    };

    consumer = new MonolithEventsConsumer(
      mockIdempotencyService as unknown as IdempotencyService,
      mockCustomersService as unknown as CustomersService,
      mockSubscriptionsService as unknown as SubscriptionsService,
      mockWebhookProcessingService as unknown as WebhookProcessingService,
    );

    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    debugSpy = jest
      .spyOn(Logger.prototype, "debug")
      .mockImplementation(() => {});
    errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createSqsMessage(
    envelope: SqsEnvelope,
    messageId = "msg-123",
  ): SqsMessage {
    return {
      MessageId: messageId,
      Body: JSON.stringify(envelope),
    };
  }

  function createEnvelope(type: string, payload: unknown = {}): SqsEnvelope {
    return {
      version: "1.0",
      type,
      timestamp: new Date().toISOString(),
      correlationId: "corr-test",
      payload,
    };
  }

  it("should parse valid envelope and route by event type", async () => {
    const envelope = createEnvelope("customer.created", {
      monolithCustomerId: "cust-1",
      name: "Test",
      email: "test@test.com",
    });
    const message = createSqsMessage(envelope);

    await consumer.handleMessage(message);

    expect(mockIdempotencyService.isProcessed).toHaveBeenCalledWith(
      "msg-123",
      "customer.created",
    );
    expect(mockIdempotencyService.markProcessed).toHaveBeenCalledWith(
      "msg-123",
      "customer.created",
    );
  });

  it("should skip duplicate event (already processed) without error", async () => {
    mockIdempotencyService.isProcessed.mockResolvedValue(true);

    const envelope = createEnvelope("customer.created");
    const message = createSqsMessage(envelope);

    await consumer.handleMessage(message);

    expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Skipping duplicate event" }),
    );
  });

  it("should log unknown event type at warn level and NOT mark as processed", async () => {
    const envelope = createEnvelope("unknown.event.type");
    const message = createSqsMessage(envelope);

    await consumer.handleMessage(message);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Unknown monolith event type",
        eventType: "unknown.event.type",
      }),
    );
    expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
  });

  it("should include correlationId from envelope in logging", async () => {
    const envelope = createEnvelope("customer.updated");
    envelope.correlationId = "specific-correlation-id";
    const message = createSqsMessage(envelope);

    await consumer.handleMessage(message);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "specific-correlation-id" }),
    );
  });

  it("should route customer.updated events", async () => {
    const envelope = createEnvelope("customer.updated", {
      monolithCustomerId: "cust-2",
    });
    const message = createSqsMessage(envelope);

    await consumer.handleMessage(message);

    expect(mockIdempotencyService.markProcessed).toHaveBeenCalled();
  });

  it("should route payroll.calculated events", async () => {
    const envelope = createEnvelope("payroll.calculated", {
      monolithCustomerId: "cust-1",
      totalAmountCents: 50000,
      currency: "USD",

      employees: [],
    });
    const message = createSqsMessage(envelope);

    await consumer.handleMessage(message);

    expect(mockIdempotencyService.markProcessed).toHaveBeenCalled();
  });

  it("should route stripe.webhook.received events to WebhookProcessingService", async () => {
    const payload = {
      stripeEventId: "evt_123",
      type: "payment_intent.succeeded",
      data: { id: "pi_123" },
      signature: "sig_abc",
    };
    const envelope = createEnvelope("stripe.webhook.received", payload);
    const message = createSqsMessage(envelope);

    await consumer.handleMessage(message);

    expect(
      mockWebhookProcessingService.processWebhookEvent,
    ).toHaveBeenCalledWith(payload, "corr-test");
    expect(mockIdempotencyService.markProcessed).toHaveBeenCalled();
  });

  it("should log processing_error events", () => {
    const error = new Error("Processing failed");
    const message: SqsMessage = { MessageId: "msg-err" };

    consumer.onProcessingError(error, message);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Error processing monolith event",
        error: "Processing failed",
        messageId: "msg-err",
      }),
    );
  });

  it("should log SQS-level errors", () => {
    const error = new Error("Network timeout");

    consumer.onError(error);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "SQS error on monolith-inbound queue",
        error: "Network timeout",
      }),
    );
  });

  it("should reject messages with unsupported envelope version", async () => {
    const envelope = {
      version: "2.0",
      type: "customer.created",
      timestamp: new Date().toISOString(),
      correlationId: "corr-v2",
      payload: {},
    } as unknown as SqsEnvelope;
    const message = createSqsMessage(envelope);

    await consumer.handleMessage(message);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Unsupported envelope version",
        version: "2.0",
      }),
    );
    expect(mockIdempotencyService.isProcessed).not.toHaveBeenCalled();
    expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
  });

  it("should handle malformed JSON message body gracefully", async () => {
    const message: SqsMessage = {
      MessageId: "msg-bad-json",
      Body: "not-valid-json{{{",
    };

    await consumer.handleMessage(message);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Failed to parse SQS message body",
        messageId: "msg-bad-json",
      }),
    );
    expect(mockIdempotencyService.isProcessed).not.toHaveBeenCalled();
  });

  describe("customer event handling with CustomersService", () => {
    it("should call CustomersService.createFromEvent for customer.created events", async () => {
      const payload = {
        monolithCustomerId: "cust-1",
        name: "Test",
        email: "test@test.com",
      };
      const envelope = createEnvelope("customer.created", payload);
      const message = createSqsMessage(envelope);

      await consumer.handleMessage(message);

      expect(mockCustomersService.createFromEvent).toHaveBeenCalledWith(
        payload,
        "corr-test",
      );
      expect(mockIdempotencyService.markProcessed).toHaveBeenCalled();
    });

    it("should call CustomersService.updateFromEvent for customer.updated events", async () => {
      const payload = {
        monolithCustomerId: "cust-1",
        name: "Updated Name",
      };
      const envelope = createEnvelope("customer.updated", payload);
      const message = createSqsMessage(envelope);

      await consumer.handleMessage(message);

      expect(mockCustomersService.updateFromEvent).toHaveBeenCalledWith(
        payload,
        "corr-test",
      );
      expect(mockIdempotencyService.markProcessed).toHaveBeenCalled();
    });

    it("should NOT mark event as processed when CustomersService.createFromEvent throws", async () => {
      mockCustomersService.createFromEvent.mockRejectedValueOnce(
        new Error("Stripe error"),
      );
      const envelope = createEnvelope("customer.created", {
        monolithCustomerId: "cust-1",
        name: "Test",
        email: "test@test.com",
      });
      const message = createSqsMessage(envelope);

      await expect(consumer.handleMessage(message)).rejects.toThrow(
        "Stripe error",
      );
      expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
    });

    it("should NOT mark event as processed when CustomersService.updateFromEvent throws", async () => {
      mockCustomersService.updateFromEvent.mockRejectedValueOnce(
        new Error("Customer not found"),
      );
      const envelope = createEnvelope("customer.updated", {
        monolithCustomerId: "cust-missing",
      });
      const message = createSqsMessage(envelope);

      await expect(consumer.handleMessage(message)).rejects.toThrow(
        "Customer not found",
      );
      expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
    });
  });

  describe("consumer without CustomersService", () => {
    it("should throw and NOT mark as processed when CustomersService is not available", async () => {
      const consumerWithoutService = new MonolithEventsConsumer(
        mockIdempotencyService as unknown as IdempotencyService,
      );
      const envelope = createEnvelope("customer.created", {
        monolithCustomerId: "cust-1",
        name: "Test",
        email: "test@test.com",
      });
      const message = createSqsMessage(envelope);

      await expect(
        consumerWithoutService.handleMessage(message),
      ).rejects.toThrow(
        "CustomersService not available — cannot process customer.created",
      );
      expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
    });
  });

  describe("consumer without SubscriptionsService", () => {
    it("should throw and NOT mark as processed when SubscriptionsService is not available for payroll event", async () => {
      const consumerWithoutSubService = new MonolithEventsConsumer(
        mockIdempotencyService as unknown as IdempotencyService,
        mockCustomersService as unknown as CustomersService,
        undefined,
      );
      mockCustomersService.findByMonolithId.mockResolvedValue({
        id: "cust-resolved",
        monolithCustomerId: "mono-cust-1",
      });

      const envelope = createEnvelope("payroll.calculated", {
        monolithCustomerId: "mono-cust-1",
        totalAmountCents: 75000,
        currency: "usd",

        employees: [],
      });
      const message = createSqsMessage(envelope);

      await expect(
        consumerWithoutSubService.handleMessage(message),
      ).rejects.toThrow(
        "SubscriptionsService not available — cannot process payroll.calculated",
      );
      expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
    });
  });

  describe("payroll.calculated event handling", () => {
    const payrollPayload = {
      monolithCustomerId: "mono-cust-1",
      currency: "usd",
      employees: [],
    };

    it("should process payroll event and delegate to applyPayrollUpdate", async () => {
      mockCustomersService.findByMonolithId.mockResolvedValue({
        id: "cust-resolved",
        monolithCustomerId: "mono-cust-1",
      });
      mockSubscriptionsService.applyPayrollUpdate.mockResolvedValue(75000);

      const envelope = createEnvelope("payroll.calculated", payrollPayload);
      const message = createSqsMessage(envelope);

      await consumer.handleMessage(message);

      expect(mockCustomersService.findByMonolithId).toHaveBeenCalledWith(
        "mono-cust-1",
      );
      expect(mockSubscriptionsService.applyPayrollUpdate).toHaveBeenCalledWith(
        "cust-resolved",
        [],
        "corr-test",
      );
      expect(mockIdempotencyService.markProcessed).toHaveBeenCalledWith(
        "msg-123",
        "payroll.calculated",
      );
    });

    it("should handle customer not found — logs warning, no error thrown", async () => {
      mockCustomersService.findByMonolithId.mockResolvedValue(null);

      const envelope = createEnvelope("payroll.calculated", payrollPayload);
      const message = createSqsMessage(envelope);

      await consumer.handleMessage(message);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Customer not found for payroll event",
          monolithCustomerId: "mono-cust-1",
        }),
      );
      expect(
        mockSubscriptionsService.applyPayrollUpdate,
      ).not.toHaveBeenCalled();
      expect(mockIdempotencyService.markProcessed).toHaveBeenCalled();
    });

    it("should handle no active subscriptions — logs success, no error thrown", async () => {
      mockCustomersService.findByMonolithId.mockResolvedValue({
        id: "cust-resolved",
      });
      mockSubscriptionsService.applyPayrollUpdate.mockResolvedValue(0);

      const envelope = createEnvelope("payroll.calculated", payrollPayload);
      const message = createSqsMessage(envelope);

      await consumer.handleMessage(message);

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Payroll pricing and invoice line items updated",
          customerId: "cust-resolved",
        }),
      );
      expect(mockIdempotencyService.markProcessed).toHaveBeenCalled();
    });

    it("should skip duplicate event via processed_events check", async () => {
      mockIdempotencyService.isProcessed.mockResolvedValue(true);

      const envelope = createEnvelope("payroll.calculated", payrollPayload);
      const message = createSqsMessage(envelope);

      await consumer.handleMessage(message);

      expect(mockCustomersService.findByMonolithId).not.toHaveBeenCalled();
      expect(
        mockSubscriptionsService.applyPayrollUpdate,
      ).not.toHaveBeenCalled();
      expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
    });

    it("should NOT mark as processed when applyPayrollUpdate throws", async () => {
      mockCustomersService.findByMonolithId.mockResolvedValue({
        id: "cust-resolved",
      });
      mockSubscriptionsService.applyPayrollUpdate.mockRejectedValue(
        new Error("DB connection error"),
      );

      const envelope = createEnvelope("payroll.calculated", payrollPayload);
      const message = createSqsMessage(envelope);

      await expect(consumer.handleMessage(message)).rejects.toThrow(
        "DB connection error",
      );
      expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
    });
  });

  describe("stripe.webhook.received event handling", () => {
    it("should await WebhookProcessingService.processWebhookEvent (not fire-and-forget)", async () => {
      const payload = {
        stripeEventId: "evt_async",
        type: "payment_intent.succeeded",
        data: { id: "pi_async" },
        signature: "sig_async",
      };
      const envelope = createEnvelope("stripe.webhook.received", payload);
      const message = createSqsMessage(envelope);

      // processWebhookEvent rejects — should propagate
      mockWebhookProcessingService.processWebhookEvent.mockRejectedValue(
        new Error("Webhook processing failed"),
      );

      await expect(consumer.handleMessage(message)).rejects.toThrow(
        "Webhook processing failed",
      );
      expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
    });

    it("should throw when WebhookProcessingService is not available", async () => {
      const consumerWithoutWebhookService = new MonolithEventsConsumer(
        mockIdempotencyService as unknown as IdempotencyService,
        mockCustomersService as unknown as CustomersService,
        mockSubscriptionsService as unknown as SubscriptionsService,
        undefined,
      );

      const payload = {
        stripeEventId: "evt_123",
        type: "payment_intent.succeeded",
        data: { id: "pi_123" },
        signature: "sig_abc",
      };
      const envelope = createEnvelope("stripe.webhook.received", payload);
      const message = createSqsMessage(envelope);

      await expect(
        consumerWithoutWebhookService.handleMessage(message),
      ).rejects.toThrow(
        "WebhookProcessingService not available — cannot process stripe.webhook.received",
      );
      expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
    });

    it("should forward correct payload to WebhookProcessingService", async () => {
      const payload = {
        stripeEventId: "evt_forward",
        type: "payment_intent.payment_failed",
        data: {
          id: "pi_forward",
          last_payment_error: { message: "Card declined" },
        },
        signature: "sig_forward",
      };
      const envelope = createEnvelope("stripe.webhook.received", payload);
      envelope.correlationId = "corr-forward-test";
      const message = createSqsMessage(envelope);

      await consumer.handleMessage(message);

      expect(
        mockWebhookProcessingService.processWebhookEvent,
      ).toHaveBeenCalledWith(payload, "corr-forward-test");
    });
  });
});
