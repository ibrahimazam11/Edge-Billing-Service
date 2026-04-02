import { SchedulerEventsConsumer } from "./scheduler-events.consumer";
import { IdempotencyService } from "../idempotency.service";
import { Logger } from "@nestjs/common";
import type { Message as SqsMessage } from "@aws-sdk/client-sqs";
import type { SqsEnvelope } from "../../../common/interfaces/envelope.interface";

describe("SchedulerEventsConsumer", () => {
  let consumer: SchedulerEventsConsumer;
  let mockIdempotencyService: {
    isProcessed: jest.Mock;
    markProcessed: jest.Mock;
  };
  let warnSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockIdempotencyService = {
      isProcessed: jest.fn().mockResolvedValue(false),
      markProcessed: jest.fn().mockResolvedValue(undefined),
    };

    consumer = new SchedulerEventsConsumer(
      mockIdempotencyService as unknown as IdempotencyService,
    );

    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
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
    messageId = "sched-msg-1",
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
      correlationId: "corr-sched",
      payload,
    };
  }

  it("should parse scheduler event and route by type", async () => {
    const envelope = createEnvelope("billing.schedule.generate-invoices", {
      scheduledDate: "2026-02-01",
    });
    const message = createSqsMessage(envelope);

    await consumer.handleMessage(message);

    expect(mockIdempotencyService.isProcessed).toHaveBeenCalledWith(
      "sched-msg-1",
      "billing.schedule.generate-invoices",
    );
    expect(mockIdempotencyService.markProcessed).toHaveBeenCalledWith(
      "sched-msg-1",
      "billing.schedule.generate-invoices",
    );
  });

  it("should skip duplicate scheduler event", async () => {
    mockIdempotencyService.isProcessed.mockResolvedValue(true);

    const envelope = createEnvelope("billing.schedule.process-dunning", {
      scheduledDate: "2026-02-01",
    });
    const message = createSqsMessage(envelope);

    await consumer.handleMessage(message);

    expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Skipping duplicate scheduler event",
      }),
    );
  });

  it("should log unknown scheduler event type at warn level and NOT mark as processed", async () => {
    const envelope = createEnvelope("billing.schedule.unknown-task");
    const message = createSqsMessage(envelope);

    await consumer.handleMessage(message);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Unknown scheduler event type",
        eventType: "billing.schedule.unknown-task",
      }),
    );
    expect(mockIdempotencyService.markProcessed).not.toHaveBeenCalled();
  });

  it("should route billing.schedule.process-dunning events", async () => {
    const envelope = createEnvelope("billing.schedule.process-dunning", {
      scheduledDate: "2026-02-01",
    });
    const message = createSqsMessage(envelope);

    await consumer.handleMessage(message);

    expect(mockIdempotencyService.markProcessed).toHaveBeenCalled();
  });

  it("should route billing.schedule.daily-reconciliation events", async () => {
    const envelope = createEnvelope("billing.schedule.daily-reconciliation", {
      scheduledDate: "2026-02-01",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    });
    const message = createSqsMessage(envelope);

    await consumer.handleMessage(message);

    expect(mockIdempotencyService.markProcessed).toHaveBeenCalled();
  });

  it("should log processing_error events", () => {
    const error = new Error("Handler failed");
    const message: SqsMessage = { MessageId: "sched-err" };

    consumer.onProcessingError(error, message);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Error processing scheduler event",
        error: "Handler failed",
        messageId: "sched-err",
      }),
    );
  });

  it("should log SQS-level errors", () => {
    const error = new Error("Connection lost");

    consumer.onError(error);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "SQS error on scheduler-inbound queue",
        error: "Connection lost",
      }),
    );
  });

  it("should reject messages with unsupported envelope version", async () => {
    const envelope = {
      version: "2.0",
      type: "billing.schedule.generate-invoices",
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
      MessageId: "sched-bad-json",
      Body: "{{invalid json}}",
    };

    await consumer.handleMessage(message);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Failed to parse SQS message body",
        messageId: "sched-bad-json",
      }),
    );
    expect(mockIdempotencyService.isProcessed).not.toHaveBeenCalled();
  });

  describe("handleProcessDunning with DunningService", () => {
    let mockDunningService: {
      getScheduledDunningAttempts: jest.Mock;
      executeDunningAttempt: jest.Mock;
    };
    let consumerWithDunning: SchedulerEventsConsumer;

    beforeEach(() => {
      mockDunningService = {
        getScheduledDunningAttempts: jest.fn().mockResolvedValue([]),
        executeDunningAttempt: jest
          .fn()
          .mockResolvedValue({ status: "succeeded" }),
      };

      consumerWithDunning = new SchedulerEventsConsumer(
        mockIdempotencyService as unknown as IdempotencyService,
        undefined,
        mockDunningService as never,
      );
    });

    it("should call getScheduledDunningAttempts when processing dunning event", async () => {
      const envelope = createEnvelope("billing.schedule.process-dunning", {
        scheduledDate: "2026-02-01",
      });
      const message = createSqsMessage(envelope);

      await consumerWithDunning.handleMessage(message);

      expect(mockDunningService.getScheduledDunningAttempts).toHaveBeenCalled();
    });

    it("should log debug message when zero attempts are due", async () => {
      mockDunningService.getScheduledDunningAttempts.mockResolvedValue([]);

      const envelope = createEnvelope("billing.schedule.process-dunning", {
        scheduledDate: "2026-02-01",
      });
      const message = createSqsMessage(envelope);

      await consumerWithDunning.handleMessage(message);

      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "No dunning attempts due for processing",
        }),
      );
    });

    it("should call executeDunningAttempt for each due attempt", async () => {
      const dueAttempts = [
        {
          id: "da-1",
          invoiceId: "inv-1",
          attemptNumber: 1,
          scheduledDate: new Date("2026-02-01"),
        },
        {
          id: "da-2",
          invoiceId: "inv-2",
          attemptNumber: 1,
          scheduledDate: new Date("2026-02-01"),
        },
      ];
      mockDunningService.getScheduledDunningAttempts.mockResolvedValue(
        dueAttempts,
      );

      const envelope = createEnvelope("billing.schedule.process-dunning", {
        scheduledDate: "2026-02-01",
      });
      const message = createSqsMessage(envelope);

      await consumerWithDunning.handleMessage(message);

      expect(mockDunningService.executeDunningAttempt).toHaveBeenCalledTimes(2);
      expect(mockDunningService.executeDunningAttempt).toHaveBeenCalledWith(
        "da-1",
        "corr-sched",
      );
      expect(mockDunningService.executeDunningAttempt).toHaveBeenCalledWith(
        "da-2",
        "corr-sched",
      );
    });

    it("should continue processing remaining attempts when one fails", async () => {
      const dueAttempts = [
        {
          id: "da-1",
          invoiceId: "inv-1",
          attemptNumber: 1,
          scheduledDate: new Date("2026-02-01"),
        },
        {
          id: "da-2",
          invoiceId: "inv-2",
          attemptNumber: 1,
          scheduledDate: new Date("2026-02-01"),
        },
      ];
      mockDunningService.getScheduledDunningAttempts.mockResolvedValue(
        dueAttempts,
      );

      // First attempt throws, second succeeds
      mockDunningService.executeDunningAttempt
        .mockRejectedValueOnce(new Error("Unexpected error"))
        .mockResolvedValueOnce({ status: "succeeded" });

      const envelope = createEnvelope("billing.schedule.process-dunning", {
        scheduledDate: "2026-02-01",
      });
      const message = createSqsMessage(envelope);

      await consumerWithDunning.handleMessage(message);

      // Both should have been called
      expect(mockDunningService.executeDunningAttempt).toHaveBeenCalledTimes(2);
      // Error should have been logged
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Dunning attempt execution error",
          dunningAttemptId: "da-1",
        }),
      );
    });

    it("should log completion summary with counts", async () => {
      const dueAttempts = [
        {
          id: "da-1",
          invoiceId: "inv-1",
          attemptNumber: 1,
          scheduledDate: new Date(),
        },
        {
          id: "da-2",
          invoiceId: "inv-2",
          attemptNumber: 1,
          scheduledDate: new Date(),
        },
        {
          id: "da-3",
          invoiceId: "inv-3",
          attemptNumber: 1,
          scheduledDate: new Date(),
        },
      ];
      mockDunningService.getScheduledDunningAttempts.mockResolvedValue(
        dueAttempts,
      );

      mockDunningService.executeDunningAttempt
        .mockResolvedValueOnce({ status: "succeeded" })
        .mockResolvedValueOnce({ status: "failed" })
        .mockResolvedValueOnce({ status: "skipped" });

      const logSpy = jest
        .spyOn(Logger.prototype, "log")
        .mockImplementation(() => {});

      const envelope = createEnvelope("billing.schedule.process-dunning", {
        scheduledDate: "2026-02-01",
      });
      const message = createSqsMessage(envelope);

      await consumerWithDunning.handleMessage(message);

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Dunning processing completed",
          total: 3,
          succeeded: 1,
          failed: 1,
          skipped: 1,
        }),
      );
    });

    it("should warn and return when dunningService is not available", async () => {
      // Consumer without dunning service (the default consumer from outer beforeEach)
      const envelope = createEnvelope("billing.schedule.process-dunning", {
        scheduledDate: "2026-02-01",
      });
      const message = createSqsMessage(envelope);

      await consumer.handleMessage(message);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "DunningService not available",
        }),
      );
    });
  });

  describe("handleDailyReconciliation with ReconciliationService", () => {
    let mockReconciliationService: {
      runDailyReconciliation: jest.Mock;
    };
    let consumerWithReconciliation: SchedulerEventsConsumer;

    beforeEach(() => {
      mockReconciliationService = {
        runDailyReconciliation: jest.fn().mockResolvedValue({
          id: "run-1",
          status: "balanced",
          recordsCompared: 5,
          discrepancies: [],
        }),
      };

      consumerWithReconciliation = new SchedulerEventsConsumer(
        mockIdempotencyService as unknown as IdempotencyService,
        undefined,
        undefined,
        mockReconciliationService as never,
      );
    });

    it("should call reconciliation service with custom period from payload", async () => {
      const envelope = createEnvelope("billing.schedule.daily-reconciliation", {
        scheduledDate: "2026-02-10",
        periodStart: "2026-02-01T00:00:00.000Z",
        periodEnd: "2026-02-02T00:00:00.000Z",
      });
      const message = createSqsMessage(envelope);

      await consumerWithReconciliation.handleMessage(message);

      expect(
        mockReconciliationService.runDailyReconciliation,
      ).toHaveBeenCalledWith(
        new Date("2026-02-01T00:00:00.000Z"),
        new Date("2026-02-02T00:00:00.000Z"),
        "corr-sched",
      );
    });

    it("should default to previous day when no custom period provided", async () => {
      const envelope = createEnvelope("billing.schedule.daily-reconciliation", {
        scheduledDate: "2026-02-10",
      });
      const message = createSqsMessage(envelope);

      await consumerWithReconciliation.handleMessage(message);

      expect(
        mockReconciliationService.runDailyReconciliation,
      ).toHaveBeenCalledWith(
        new Date("2026-02-09T00:00:00.000Z"),
        new Date("2026-02-10T00:00:00.000Z"),
        "corr-sched",
      );
    });

    it("should warn and return when reconciliationService is not available", async () => {
      const envelope = createEnvelope("billing.schedule.daily-reconciliation", {
        scheduledDate: "2026-02-10",
      });
      const message = createSqsMessage(envelope);

      // Use the default consumer (no reconciliation service)
      await consumer.handleMessage(message);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "ReconciliationService not available",
        }),
      );
    });
  });
});
