import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DunningService } from "./dunning.service";
import { DunningAttemptsRepository } from "./dunning.repository";
import { InvoicesRepository } from "../invoices/invoices.repository";
import type { DrizzleDatabase } from "../database/types";
import { InvoiceAlreadyPaidException } from "../charges/invoice-already-paid.exception";

jest.mock("../common/utils/uuid.util", () => ({
  generateId: jest.fn(() => "mock-dunning-id"),
}));

describe("DunningService", () => {
  let service: DunningService;
  let mockConfigService: ConfigService;
  let dunningRepo: jest.Mocked<DunningAttemptsRepository>;
  let invoicesRepo: jest.Mocked<InvoicesRepository>;
  let mockChargesService: {
    executePaymentForInvoice: jest.Mock;
  };
  let mockSubscriptionsService: {
    updateState: jest.Mock;
  };
  let mockSqsProducerService: {
    publish: jest.Mock;
  };
  let mockPaymentMethodsService: {
    getOrderedPaymentMethods: jest.Mock;
  };

  const mockDb = {
    transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) =>
      cb("tx-mock"),
    ),
  } as unknown as DrizzleDatabase;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === "dunning.retryScheduleDays") return [1, 3, 5, 7];
        if (key === "dunning.maxRetryAttempts") return 4;
        return undefined;
      }),
    } as unknown as ConfigService;

    dunningRepo = {
      findById: jest.fn().mockResolvedValue(null),
      findByInvoiceId: jest.fn().mockResolvedValue([]),
      findScheduled: jest.fn().mockResolvedValue([]),
      findExistingNonSkipped: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockResolvedValue(undefined),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      markRemainingAsSkipped: jest.fn().mockResolvedValue(undefined),
      findWithInvoiceAndPaymentMethod: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<DunningAttemptsRepository>;

    invoicesRepo = {
      findById: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<InvoicesRepository>;

    mockChargesService = {
      executePaymentForInvoice: jest.fn(),
    };

    mockSubscriptionsService = {
      updateState: jest.fn().mockResolvedValue({}),
    };

    mockSqsProducerService = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    mockPaymentMethodsService = {
      getOrderedPaymentMethods: jest.fn().mockResolvedValue([
        {
          id: "pm-default",
          stripePaymentMethodId: "pm_stripe_default",
          isDefault: true,
          fallbackOrder: null,
        },
      ]),
    };

    service = new DunningService(
      mockDb,
      mockConfigService,
      dunningRepo,
      invoicesRepo,
      mockChargesService as never,
      mockSubscriptionsService as never,
      mockSqsProducerService as never,
      undefined, // dualWriteService
      mockPaymentMethodsService as never,
    );

    // Suppress logs in tests
    jest.spyOn(Logger.prototype, "log").mockImplementation();
    jest.spyOn(Logger.prototype, "debug").mockImplementation();
    jest.spyOn(Logger.prototype, "warn").mockImplementation();
    jest.spyOn(Logger.prototype, "error").mockImplementation();
  });

  describe("scheduleDunningAttempt", () => {
    it("should create record with correct fields (status=scheduled, attempt_number=1, scheduled_date)", async () => {
      dunningRepo.findExistingNonSkipped.mockResolvedValue([]);

      await service.scheduleDunningAttempt("invoice-1", "corr-1");

      expect(dunningRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "mock-dunning-id",
          invoiceId: "invoice-1",
          attemptNumber: 1,
          status: "scheduled",
        }),
      );
    });

    it("should calculate scheduled_date using config schedule day 1", async () => {
      dunningRepo.findExistingNonSkipped.mockResolvedValue([]);
      const now = new Date();

      await service.scheduleDunningAttempt("invoice-1", "corr-1");

      const calledValues = dunningRepo.insert.mock.calls[0][0] as {
        scheduledDate: Date;
      };
      const expectedDate = new Date(now);
      expectedDate.setDate(expectedDate.getDate() + 1); // retryScheduleDays[0] = 1

      // Allow 5 second tolerance for test timing
      expect(
        Math.abs(calledValues.scheduledDate.getTime() - expectedDate.getTime()),
      ).toBeLessThan(5000);
    });

    it("should skip scheduling when dunning already exists for invoice (scheduled)", async () => {
      dunningRepo.findExistingNonSkipped.mockResolvedValue([
        { id: "existing-attempt", status: "scheduled" } as never,
      ]);

      await service.scheduleDunningAttempt("invoice-1", "corr-1");

      expect(dunningRepo.insert).not.toHaveBeenCalled();
      expect(Logger.prototype.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Dunning already exists for invoice, skipping",
          invoiceId: "invoice-1",
        }),
      );
    });

    it("should skip scheduling when a failed dunning attempt exists for invoice", async () => {
      dunningRepo.findExistingNonSkipped.mockResolvedValue([
        { id: "existing-attempt", status: "failed" } as never,
      ]);

      await service.scheduleDunningAttempt("invoice-1", "corr-1");

      expect(dunningRepo.insert).not.toHaveBeenCalled();
      expect(Logger.prototype.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Dunning already exists for invoice, skipping",
          invoiceId: "invoice-1",
        }),
      );
    });

    it("should log structured message on successful scheduling", async () => {
      dunningRepo.findExistingNonSkipped.mockResolvedValue([]);

      await service.scheduleDunningAttempt("invoice-1", "corr-1");

      expect(Logger.prototype.log).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Dunning attempt scheduled",
          dunningAttemptId: "mock-dunning-id",
          invoiceId: "invoice-1",
          attemptNumber: 1,
          correlationId: "corr-1",
        }),
      );
    });
  });

  describe("getScheduledDunningAttempts", () => {
    it("should return only scheduled attempts with scheduled_date <= now", async () => {
      const pastDate = new Date("2025-01-01T00:00:00Z");
      dunningRepo.findScheduled.mockResolvedValue([
        {
          id: "attempt-1",
          invoiceId: "inv-1",
          chargeId: null,
          paymentMethodId: null,
          attemptNumber: 1,
          scheduledDate: pastDate,
          executedAt: null,
          status: "scheduled",
          failureReason: null,
          createdAt: pastDate,
        },
      ]);

      const results = await service.getScheduledDunningAttempts();

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("attempt-1");
      expect(results[0].status).toBe("scheduled");
    });

    it("should return empty array when no attempts are due", async () => {
      dunningRepo.findScheduled.mockResolvedValue([]);

      const results = await service.getScheduledDunningAttempts();

      expect(results).toHaveLength(0);
    });

    it("should log debug message with due count", async () => {
      dunningRepo.findScheduled.mockResolvedValue([]);

      await service.getScheduledDunningAttempts();

      expect(Logger.prototype.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Queried scheduled dunning attempts",
          dueCount: 0,
        }),
      );
    });

    it("should call dunningRepo.findScheduled", async () => {
      dunningRepo.findScheduled.mockResolvedValue([]);

      await service.getScheduledDunningAttempts();

      expect(dunningRepo.findScheduled).toHaveBeenCalled();
    });
  });

  describe("getDunningAttemptsForInvoice", () => {
    it("should return all attempts for given invoice", async () => {
      dunningRepo.findByInvoiceId.mockResolvedValue([
        {
          id: "attempt-1",
          invoiceId: "inv-1",
          chargeId: null,
          paymentMethodId: null,
          attemptNumber: 1,
          scheduledDate: new Date(),
          executedAt: null,
          status: "scheduled",
          failureReason: null,
          createdAt: new Date(),
        },
        {
          id: "attempt-2",
          invoiceId: "inv-1",
          chargeId: "charge-1",
          paymentMethodId: null,
          attemptNumber: 2,
          scheduledDate: new Date(),
          executedAt: new Date(),
          status: "failed",
          failureReason: "Card declined",
          createdAt: new Date(),
        },
      ]);

      const results = await service.getDunningAttemptsForInvoice("inv-1");

      expect(results).toHaveLength(2);
      expect(results[0].attemptNumber).toBe(1);
      expect(results[1].attemptNumber).toBe(2);
      expect(results[1].failureReason).toBe("Card declined");
    });

    it("should return empty array when no attempts exist for invoice", async () => {
      dunningRepo.findByInvoiceId.mockResolvedValue([]);

      const results =
        await service.getDunningAttemptsForInvoice("inv-nonexistent");

      expect(results).toHaveLength(0);
    });
  });

  describe("executeDunningAttempt", () => {
    const mockScheduledAttempt = {
      id: "attempt-1",
      invoiceId: "inv-1",
      chargeId: null,
      paymentMethodId: null,
      attemptNumber: 2,
      scheduledDate: new Date(),
      executedAt: null,
      status: "scheduled",
      failureReason: null,
      createdAt: new Date(),
    };

    const mockFinalizedInvoice = {
      id: "inv-1",
      customerId: "cust-1",
      subscriptionId: "sub-1",
      type: "recurring",
      status: "finalized",
      totalAmountCents: 5000,
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

    it("should call ChargesService.executePaymentForInvoice on success path", async () => {
      dunningRepo.findById.mockResolvedValue(mockScheduledAttempt);
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "charge-1",
        status: "succeeded",
        stripePaymentIntentId: "pi_123",
      });

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(mockChargesService.executePaymentForInvoice).toHaveBeenCalledWith(
        "inv-1",
        "corr-1",
        2, // attemptNumber
        "pm-default", // selected PM
      );
      expect(result.status).toBe("succeeded");
      expect(result.chargeId).toBe("charge-1");
    });

    it("should update attempt to succeeded and mark remaining as skipped on success", async () => {
      dunningRepo.findById.mockResolvedValue(mockScheduledAttempt);
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "charge-1",
        status: "succeeded",
        stripePaymentIntentId: "pi_123",
      });

      await service.executeDunningAttempt("attempt-1", "corr-1");

      // Should use transaction
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      // Should update status to succeeded with tx
      expect(dunningRepo.updateStatus).toHaveBeenCalledWith(
        "attempt-1",
        expect.objectContaining({
          executedAt: expect.any(Date) as Date,
          chargeId: "charge-1",
          status: "succeeded",
        }),
        "tx-mock",
      );
      // Should mark remaining as skipped with tx
      expect(dunningRepo.markRemainingAsSkipped).toHaveBeenCalledWith(
        "inv-1",
        "tx-mock",
      );
    });

    it("should update attempt to failed and schedule next attempt on failure with remaining retries", async () => {
      dunningRepo.findById.mockResolvedValue(mockScheduledAttempt); // attemptNumber=2
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "charge-2",
        status: "failed",
        stripePaymentIntentId: null,
        failureReason: "Card declined",
      });

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("Card declined");

      // Should use transaction for: update failed + schedule next attempt
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(dunningRepo.updateStatus).toHaveBeenCalledWith(
        "attempt-1",
        expect.objectContaining({
          executedAt: expect.any(Date) as Date,
          chargeId: "charge-2",
          status: "failed",
          failureReason: "Card declined",
        }),
        "tx-mock",
      );

      // Should schedule next attempt (attemptNumber 3) within transaction
      expect(dunningRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: "inv-1",
          attemptNumber: 3,
          status: "scheduled",
        }),
        "tx-mock",
      );
    });

    it("should update attempt to failed and escalate when all retries exhausted", async () => {
      const exhaustedAttempt = {
        ...mockScheduledAttempt,
        attemptNumber: 4, // maxRetryAttempts = 4
      };

      dunningRepo.findById.mockResolvedValue(exhaustedAttempt);
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);

      // For escalation history
      dunningRepo.findByInvoiceId.mockResolvedValue([
        {
          ...exhaustedAttempt,
          status: "failed",
          executedAt: new Date(),
          failureReason: "Gateway timeout",
        },
      ]);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "charge-4",
        status: "failed",
        stripePaymentIntentId: null,
        failureReason: "Gateway timeout",
      });

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("failed");

      // Should NOT schedule another attempt
      expect(dunningRepo.insert).not.toHaveBeenCalled();

      // Should call subscriptionsService.updateState
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledWith(
        "sub-1",
        expect.objectContaining({ status: "past_due" }),
        "corr-1",
      );

      // Should publish dunning.escalated event
      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "dunning.escalated",
        expect.objectContaining({
          invoiceId: "inv-1",
          customerId: "cust-1",
          amountCents: 5000,
          currency: "usd",
        }),
        "corr-1",
        undefined,
      );
    });

    it("should skip when invoice is already paid", async () => {
      const paidInvoice = { ...mockFinalizedInvoice, status: "paid" };

      dunningRepo.findById.mockResolvedValue(mockScheduledAttempt);
      invoicesRepo.findById.mockResolvedValue(paidInvoice);

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("skipped");
      expect(
        mockChargesService.executePaymentForInvoice,
      ).not.toHaveBeenCalled();

      // Should use transaction for: update current skipped + mark remaining skipped
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(dunningRepo.updateStatus).toHaveBeenCalledWith(
        "attempt-1",
        { status: "skipped" },
        "tx-mock",
      );
      expect(dunningRepo.markRemainingAsSkipped).toHaveBeenCalledWith(
        "inv-1",
        "tx-mock",
      );
    });

    it("should skip when invoice is void", async () => {
      const voidInvoice = { ...mockFinalizedInvoice, status: "void" };

      dunningRepo.findById.mockResolvedValue(mockScheduledAttempt);
      invoicesRepo.findById.mockResolvedValue(voidInvoice);

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("skipped");
      expect(
        mockChargesService.executePaymentForInvoice,
      ).not.toHaveBeenCalled();

      // Should use transaction for: update current skipped + mark remaining skipped
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(dunningRepo.updateStatus).toHaveBeenCalled();
      expect(dunningRepo.markRemainingAsSkipped).toHaveBeenCalled();
    });

    it("should return skipped when attempt is not in scheduled status", async () => {
      const executedAttempt = { ...mockScheduledAttempt, status: "failed" };

      dunningRepo.findById.mockResolvedValue(executedAttempt);

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("skipped");
      expect(
        mockChargesService.executePaymentForInvoice,
      ).not.toHaveBeenCalled();
    });

    it("should throw when attempt is not found", async () => {
      dunningRepo.findById.mockResolvedValue(null);

      await expect(
        service.executeDunningAttempt("nonexistent", "corr-1"),
      ).rejects.toThrow("Dunning attempt not found: nonexistent");
    });

    it("should set executed_at and charge_id after execution", async () => {
      dunningRepo.findById.mockResolvedValue(mockScheduledAttempt);
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "charge-abc",
        status: "succeeded",
        stripePaymentIntentId: "pi_test",
      });

      await service.executeDunningAttempt("attempt-1", "corr-1");

      // Transaction update includes executedAt, chargeId, and status in one call
      expect(dunningRepo.updateStatus).toHaveBeenCalledWith(
        "attempt-1",
        expect.objectContaining({
          executedAt: expect.any(Date) as Date,
          chargeId: "charge-abc",
          status: "succeeded",
        }),
        "tx-mock",
      );
    });

    it("should pass correct attemptNumber for idempotency key generation", async () => {
      const attempt3 = { ...mockScheduledAttempt, attemptNumber: 3 };

      dunningRepo.findById.mockResolvedValue(attempt3);
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "charge-3",
        status: "succeeded",
        stripePaymentIntentId: "pi_3",
      });

      await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(mockChargesService.executePaymentForInvoice).toHaveBeenCalledWith(
        "inv-1",
        "corr-1",
        3, // attemptNumber passed for idempotency key
        "pm-default", // selected PM
      );
    });

    it("should handle InvoiceAlreadyPaidException from ChargesService as skip", async () => {
      dunningRepo.findById.mockResolvedValue(mockScheduledAttempt);
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);

      mockChargesService.executePaymentForInvoice.mockRejectedValue(
        new InvoiceAlreadyPaidException("inv-1"),
      );

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("skipped");
      // Should use transaction for: update current skipped + mark remaining skipped
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(dunningRepo.updateStatus).toHaveBeenCalledWith(
        "attempt-1",
        { status: "skipped" },
        "tx-mock",
      );
      expect(dunningRepo.markRemainingAsSkipped).toHaveBeenCalledWith(
        "inv-1",
        "tx-mock",
      );
    });

    it("should throw when ChargesService is not available", async () => {
      const serviceWithoutCharges = new DunningService(
        mockDb,
        mockConfigService,
        dunningRepo,
        invoicesRepo,
      );

      await expect(
        serviceWithoutCharges.executeDunningAttempt("attempt-1", "corr-1"),
      ).rejects.toThrow("ChargesService is not available");
    });
  });

  describe("escalateDunning (via executeDunningAttempt exhausted path)", () => {
    const mockExhaustedAttempt = {
      id: "attempt-1",
      invoiceId: "inv-1",
      chargeId: null,
      paymentMethodId: null,
      attemptNumber: 4,
      scheduledDate: new Date(),
      executedAt: null,
      status: "scheduled",
      failureReason: null,
      createdAt: new Date(),
    };

    const mockInvoice = {
      id: "inv-1",
      customerId: "cust-1",
      subscriptionId: "sub-1",
      type: "recurring",
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

    it("should transition subscription to past_due via SubscriptionsService", async () => {
      dunningRepo.findById.mockResolvedValue(mockExhaustedAttempt);
      invoicesRepo.findById.mockResolvedValue(mockInvoice);
      dunningRepo.findByInvoiceId.mockResolvedValue([
        {
          id: "att-1",
          invoiceId: "inv-1",
          chargeId: null,
          paymentMethodId: null,
          attemptNumber: 1,
          scheduledDate: new Date(),
          executedAt: new Date(),
          status: "failed",
          failureReason: "Card declined",
          createdAt: new Date(),
        },
      ]);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "ch-4",
        status: "failed",
        stripePaymentIntentId: null,
        failureReason: "Card declined",
      });

      await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(mockSubscriptionsService.updateState).toHaveBeenCalledWith(
        "sub-1",
        expect.objectContaining({ status: "past_due" }),
        "corr-1",
      );
    });

    it("should publish dunning.escalated event with correct payload shape", async () => {
      const failedAt = new Date("2026-02-08T12:00:00Z");
      dunningRepo.findById.mockResolvedValue(mockExhaustedAttempt);
      invoicesRepo.findById.mockResolvedValue(mockInvoice);
      dunningRepo.findByInvoiceId.mockResolvedValue([
        {
          id: "att-1",
          invoiceId: "inv-1",
          chargeId: "ch-1",
          paymentMethodId: null,
          attemptNumber: 1,
          scheduledDate: new Date(),
          executedAt: failedAt,
          status: "failed",
          failureReason: "Card declined",
          createdAt: new Date(),
        },
        {
          id: "att-2",
          invoiceId: "inv-1",
          chargeId: "ch-2",
          paymentMethodId: null,
          attemptNumber: 2,
          scheduledDate: new Date(),
          executedAt: failedAt,
          status: "failed",
          failureReason: "Insufficient funds",
          createdAt: new Date(),
        },
      ]);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "ch-4",
        status: "failed",
        stripePaymentIntentId: null,
        failureReason: "Insufficient funds",
      });

      await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "dunning.escalated",
        {
          invoiceId: "inv-1",
          customerId: "cust-1",
          monolithCustomerId: "",
          totalAttempts: 2,
          failureHistory: [
            {
              attemptNumber: 1,
              failedAt: failedAt.toISOString(),
              reason: "Card declined",
            },
            {
              attemptNumber: 2,
              failedAt: failedAt.toISOString(),
              reason: "Insufficient funds",
            },
          ],
          amountCents: 10000,
          currency: "usd",
        },
        "corr-1",
        undefined,
      );
    });

    it("should log escalation with correct fields", async () => {
      dunningRepo.findById.mockResolvedValue(mockExhaustedAttempt);
      invoicesRepo.findById.mockResolvedValue(mockInvoice);
      dunningRepo.findByInvoiceId.mockResolvedValue([
        {
          id: "att-1",
          invoiceId: "inv-1",
          chargeId: "ch-1",
          paymentMethodId: null,
          attemptNumber: 1,
          scheduledDate: new Date(),
          executedAt: new Date(),
          status: "failed",
          failureReason: "Declined",
          createdAt: new Date(),
        },
      ]);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "ch-4",
        status: "failed",
        stripePaymentIntentId: null,
        failureReason: "Declined",
      });

      await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(Logger.prototype.log).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: "inv-1",
          customerId: "cust-1",
          totalAttempts: 1,
          action: "dunning.escalated",
        }),
      );
    });

    it("should skip subscription transition when invoice has no subscriptionId", async () => {
      const invoiceNoSub = { ...mockInvoice, subscriptionId: null };

      dunningRepo.findById.mockResolvedValue(mockExhaustedAttempt);
      invoicesRepo.findById.mockResolvedValue(invoiceNoSub);
      dunningRepo.findByInvoiceId.mockResolvedValue([]);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "ch-4",
        status: "failed",
        stripePaymentIntentId: null,
        failureReason: "Declined",
      });

      await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(mockSubscriptionsService.updateState).not.toHaveBeenCalled();
      // Should still publish escalation event
      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "dunning.escalated",
        expect.objectContaining({ invoiceId: "inv-1" }),
        "corr-1",
        undefined,
      );
    });

    it("should still publish event when SubscriptionsService is not available", async () => {
      const serviceNoSubs = new DunningService(
        mockDb,
        mockConfigService,
        dunningRepo,
        invoicesRepo,
        mockChargesService as never,
        undefined,
        mockSqsProducerService as never,
        undefined, // dualWriteService
        mockPaymentMethodsService as never,
      );

      dunningRepo.findById.mockResolvedValue(mockExhaustedAttempt);
      invoicesRepo.findById.mockResolvedValue(mockInvoice);
      dunningRepo.findByInvoiceId.mockResolvedValue([]);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "ch-4",
        status: "failed",
        stripePaymentIntentId: null,
        failureReason: "Declined",
      });

      await serviceNoSubs.executeDunningAttempt("attempt-1", "corr-1");

      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "dunning.escalated",
        expect.objectContaining({ invoiceId: "inv-1" }),
        "corr-1",
        undefined,
      );
    });

    it("should handle SubscriptionsService.updateState failure gracefully", async () => {
      dunningRepo.findById.mockResolvedValue(mockExhaustedAttempt);
      invoicesRepo.findById.mockResolvedValue(mockInvoice);
      dunningRepo.findByInvoiceId.mockResolvedValue([]);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "ch-4",
        status: "failed",
        stripePaymentIntentId: null,
        failureReason: "Declined",
      });

      mockSubscriptionsService.updateState.mockRejectedValue(
        new Error("Subscription not found"),
      );

      // Should NOT throw
      await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "Failed to transition subscription to past_due during dunning escalation",
        }),
      );

      // Should still publish the escalation event
      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "dunning.escalated",
        expect.objectContaining({ invoiceId: "inv-1" }),
        "corr-1",
        undefined,
      );
    });
  });

  describe("scheduleNextDunningAttempt (via failure path)", () => {
    const mockFinalizedInvoice = {
      id: "inv-1",
      customerId: "cust-1",
      subscriptionId: "sub-1",
      type: "recurring",
      status: "finalized",
      totalAmountCents: 5000,
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

    it("should schedule next attempt with correct attempt_number and scheduled_date", async () => {
      const attempt2 = {
        id: "attempt-1",
        invoiceId: "inv-1",
        chargeId: null,
        paymentMethodId: null,
        attemptNumber: 2,
        scheduledDate: new Date(),
        executedAt: null,
        status: "scheduled",
        failureReason: null,
        createdAt: new Date(),
      };

      dunningRepo.findById.mockResolvedValue(attempt2);
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "ch-2",
        status: "failed",
        stripePaymentIntentId: null,
      });

      await service.executeDunningAttempt("attempt-1", "corr-1");

      // Should schedule attempt 3 within transaction
      expect(dunningRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptNumber: 3,
          status: "scheduled",
        }),
        "tx-mock",
      );

      const calledValues = dunningRepo.insert.mock.calls[0][0] as {
        attemptNumber: number;
        scheduledDate: Date;
      };
      expect(calledValues.attemptNumber).toBe(3);

      // retryScheduleDays[2] = 5 (index for attempt 3)
      const expectedDate = new Date();
      expectedDate.setDate(expectedDate.getDate() + 5);
      expect(
        Math.abs(calledValues.scheduledDate.getTime() - expectedDate.getTime()),
      ).toBeLessThan(5000);
    });

    it("should return false (not schedule) when max retries exceeded", async () => {
      const attempt4 = {
        id: "attempt-1",
        invoiceId: "inv-1",
        chargeId: null,
        paymentMethodId: null,
        attemptNumber: 4, // maxRetryAttempts = 4
        scheduledDate: new Date(),
        executedAt: null,
        status: "scheduled",
        failureReason: null,
        createdAt: new Date(),
      };

      dunningRepo.findById.mockResolvedValue(attempt4);
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);
      dunningRepo.findByInvoiceId.mockResolvedValue([]);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "ch-4",
        status: "failed",
        stripePaymentIntentId: null,
        failureReason: "Declined",
      });

      await service.executeDunningAttempt("attempt-1", "corr-1");

      // Should NOT schedule another attempt
      expect(dunningRepo.insert).not.toHaveBeenCalled();

      // Should escalate
      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "dunning.escalated",
        expect.anything(),
        "corr-1",
        undefined,
      );
    });
  });

  describe("markRemainingAsSkipped (via success/skip paths)", () => {
    it("should update all scheduled attempts for invoice to skipped", async () => {
      const paidInvoice = {
        id: "inv-1",
        customerId: "cust-1",
        subscriptionId: "sub-1",
        type: "recurring",
        status: "paid",
        totalAmountCents: 5000,
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

      dunningRepo.findById.mockResolvedValue({
        id: "attempt-1",
        invoiceId: "inv-1",
        chargeId: null,
        paymentMethodId: null,
        attemptNumber: 2,
        scheduledDate: new Date(),
        executedAt: null,
        status: "scheduled",
        failureReason: null,
        createdAt: new Date(),
      });
      invoicesRepo.findById.mockResolvedValue(paidInvoice);

      await service.executeDunningAttempt("attempt-1", "corr-1");

      // markRemainingAsSkipped should have been called within transaction
      expect(dunningRepo.markRemainingAsSkipped).toHaveBeenCalledWith(
        "inv-1",
        "tx-mock",
      );
    });
  });

  describe("PM cascading logic in executeDunningAttempt", () => {
    const mockScheduledAttempt = {
      id: "attempt-1",
      invoiceId: "inv-1",
      chargeId: null,
      paymentMethodId: null,
      attemptNumber: 2,
      scheduledDate: new Date(),
      executedAt: null,
      status: "scheduled",
      failureReason: null,
      createdAt: new Date(),
    };

    const mockFinalizedInvoice = {
      id: "inv-1",
      customerId: "cust-1",
      subscriptionId: "sub-1",
      type: "recurring",
      status: "finalized",
      totalAmountCents: 5000,
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

    it("should select PM-A (default) on first attempt for multi-PM customer and record paymentMethodId", async () => {
      mockPaymentMethodsService.getOrderedPaymentMethods.mockResolvedValue([
        {
          id: "pm-a",
          stripePaymentMethodId: "spm_a",
          isDefault: true,
          fallbackOrder: null,
        },
        {
          id: "pm-b",
          stripePaymentMethodId: "spm_b",
          isDefault: false,
          fallbackOrder: 1,
        },
        {
          id: "pm-c",
          stripePaymentMethodId: "spm_c",
          isDefault: false,
          fallbackOrder: 2,
        },
      ]);

      const attempt1 = { ...mockScheduledAttempt, attemptNumber: 1 };

      dunningRepo.findById.mockResolvedValue(attempt1);
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);
      // attempt history — no previous attempts
      dunningRepo.findByInvoiceId.mockResolvedValue([]);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "charge-1",
        status: "succeeded",
        stripePaymentIntentId: "pi_1",
      });

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("succeeded");
      expect(result.chargeId).toBe("charge-1");

      // Verify PM-A was selected (not PM-B or PM-C)
      expect(mockChargesService.executePaymentForInvoice).toHaveBeenCalledWith(
        "inv-1",
        "corr-1",
        1,
        "pm-a",
      );

      // Verify paymentMethodId recorded on attempt
      expect(dunningRepo.updateStatus).toHaveBeenCalledWith(
        "attempt-1",
        expect.objectContaining({
          paymentMethodId: "pm-a",
          status: "succeeded",
        }),
        "tx-mock",
      );
    });

    it("should select PM-B when PM-A already failed in attempt history", async () => {
      mockPaymentMethodsService.getOrderedPaymentMethods.mockResolvedValue([
        {
          id: "pm-a",
          stripePaymentMethodId: "spm_a",
          isDefault: true,
          fallbackOrder: null,
        },
        {
          id: "pm-b",
          stripePaymentMethodId: "spm_b",
          isDefault: false,
          fallbackOrder: 1,
        },
        {
          id: "pm-c",
          stripePaymentMethodId: "spm_c",
          isDefault: false,
          fallbackOrder: 2,
        },
      ]);

      dunningRepo.findById.mockResolvedValue(mockScheduledAttempt); // attemptNumber=2
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);
      // attempt history — PM-A tried and failed
      dunningRepo.findByInvoiceId.mockResolvedValue([
        {
          id: "att-1",
          invoiceId: "inv-1",
          paymentMethodId: "pm-a",
          status: "failed",
          attemptNumber: 1,
          chargeId: "ch-1",
          scheduledDate: new Date(),
          executedAt: new Date(),
          failureReason: "Card declined",
          createdAt: new Date(),
        },
      ]);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "charge-2",
        status: "succeeded",
        stripePaymentIntentId: "pi_2",
      });

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("succeeded");
      expect(mockChargesService.executePaymentForInvoice).toHaveBeenCalledWith(
        "inv-1",
        "corr-1",
        2,
        "pm-b",
      );
      expect(dunningRepo.updateStatus).toHaveBeenCalledWith(
        "attempt-1",
        expect.objectContaining({
          paymentMethodId: "pm-b",
          status: "succeeded",
        }),
        "tx-mock",
      );
    });

    it("should select PM-C when PM-A and PM-B already failed", async () => {
      mockPaymentMethodsService.getOrderedPaymentMethods.mockResolvedValue([
        {
          id: "pm-a",
          stripePaymentMethodId: "spm_a",
          isDefault: true,
          fallbackOrder: null,
        },
        {
          id: "pm-b",
          stripePaymentMethodId: "spm_b",
          isDefault: false,
          fallbackOrder: 1,
        },
        {
          id: "pm-c",
          stripePaymentMethodId: "spm_c",
          isDefault: false,
          fallbackOrder: 2,
        },
      ]);

      const attempt3 = { ...mockScheduledAttempt, attemptNumber: 3 };

      dunningRepo.findById.mockResolvedValue(attempt3);
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);
      // attempt history — PM-A and PM-B tried and failed
      dunningRepo.findByInvoiceId.mockResolvedValue([
        {
          id: "att-1",
          invoiceId: "inv-1",
          paymentMethodId: "pm-a",
          status: "failed",
          attemptNumber: 1,
          chargeId: "ch-1",
          scheduledDate: new Date(),
          executedAt: new Date(),
          failureReason: "Card declined",
          createdAt: new Date(),
        },
        {
          id: "att-2",
          invoiceId: "inv-1",
          paymentMethodId: "pm-b",
          status: "failed",
          attemptNumber: 2,
          chargeId: "ch-2",
          scheduledDate: new Date(),
          executedAt: new Date(),
          failureReason: "Insufficient funds",
          createdAt: new Date(),
        },
      ]);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "charge-3",
        status: "failed",
        stripePaymentIntentId: null,
        failureReason: "Card expired",
      });

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("failed");
      expect(mockChargesService.executePaymentForInvoice).toHaveBeenCalledWith(
        "inv-1",
        "corr-1",
        3,
        "pm-c",
      );
      expect(dunningRepo.updateStatus).toHaveBeenCalledWith(
        "attempt-1",
        expect.objectContaining({ paymentMethodId: "pm-c", status: "failed" }),
        "tx-mock",
      );
    });

    it("should mark failed with 'all_payment_methods_exhausted' and escalate when all PMs tried", async () => {
      mockPaymentMethodsService.getOrderedPaymentMethods.mockResolvedValue([
        {
          id: "pm-a",
          stripePaymentMethodId: "spm_a",
          isDefault: true,
          fallbackOrder: null,
        },
        {
          id: "pm-b",
          stripePaymentMethodId: "spm_b",
          isDefault: false,
          fallbackOrder: 1,
        },
      ]);

      const attempt3 = { ...mockScheduledAttempt, attemptNumber: 3 };

      dunningRepo.findById.mockResolvedValue(attempt3);
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);
      // attempt history — both PMs tried and failed
      // First call from selectPaymentMethodForAttempt (cascading check)
      // Second call from escalateDunning (history)
      dunningRepo.findByInvoiceId
        .mockResolvedValueOnce([
          {
            id: "att-1",
            invoiceId: "inv-1",
            paymentMethodId: "pm-a",
            status: "failed",
            attemptNumber: 1,
            chargeId: "ch-1",
            scheduledDate: new Date(),
            executedAt: new Date(),
            failureReason: "Declined",
            createdAt: new Date(),
          },
          {
            id: "att-2",
            invoiceId: "inv-1",
            paymentMethodId: "pm-b",
            status: "failed",
            attemptNumber: 2,
            chargeId: "ch-2",
            scheduledDate: new Date(),
            executedAt: new Date(),
            failureReason: "Declined",
            createdAt: new Date(),
          },
        ])
        .mockResolvedValueOnce([
          // escalation history
          {
            id: "att-1",
            invoiceId: "inv-1",
            chargeId: "ch-1",
            paymentMethodId: "pm-a",
            attemptNumber: 1,
            scheduledDate: new Date(),
            executedAt: new Date(),
            status: "failed",
            failureReason: "Declined",
            createdAt: new Date(),
          },
        ]);

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("all_payment_methods_exhausted");

      // ChargesService should NOT be called — no PM to try
      expect(
        mockChargesService.executePaymentForInvoice,
      ).not.toHaveBeenCalled();

      // Attempt should be marked failed with exhausted reason
      expect(dunningRepo.updateStatus).toHaveBeenCalledWith(
        "attempt-1",
        expect.objectContaining({
          status: "failed",
          failureReason: "all_payment_methods_exhausted",
        }),
      );

      // Remaining scheduled attempts should be skipped
      expect(dunningRepo.markRemainingAsSkipped).toHaveBeenCalledWith("inv-1");

      // Should escalate
      expect(mockSubscriptionsService.updateState).toHaveBeenCalledWith(
        "sub-1",
        expect.objectContaining({ status: "past_due" }),
        "corr-1",
      );
      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "dunning.escalated",
        expect.objectContaining({ invoiceId: "inv-1", customerId: "cust-1" }),
        "corr-1",
        undefined,
      );
    });

    it("should use same PM on every retry for single-PM customer (backward compatible)", async () => {
      mockPaymentMethodsService.getOrderedPaymentMethods.mockResolvedValue([
        {
          id: "pm-only",
          stripePaymentMethodId: "spm_only",
          isDefault: true,
          fallbackOrder: null,
        },
      ]);

      dunningRepo.findById.mockResolvedValue(mockScheduledAttempt); // attemptNumber=2
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "charge-2",
        status: "failed",
        stripePaymentIntentId: null,
        failureReason: "Declined",
      });

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("failed");
      // Single PM — always used (no history check)
      expect(mockChargesService.executePaymentForInvoice).toHaveBeenCalledWith(
        "inv-1",
        "corr-1",
        2,
        "pm-only",
      );
      expect(dunningRepo.updateStatus).toHaveBeenCalledWith(
        "attempt-1",
        expect.objectContaining({
          paymentMethodId: "pm-only",
          status: "failed",
        }),
        "tx-mock",
      );
      // getDunningAttemptsForInvoice should NOT be called for single-PM
      // (the getOrderedPaymentMethods call already establishes there's only 1 PM)
    });

    it("should mark failed with 'no_active_payment_methods' and escalate when no PMs exist", async () => {
      mockPaymentMethodsService.getOrderedPaymentMethods.mockResolvedValue([]);

      dunningRepo.findById.mockResolvedValue(mockScheduledAttempt);
      invoicesRepo.findById
        .mockResolvedValueOnce(mockFinalizedInvoice) // load invoice for status check
        .mockResolvedValueOnce(mockFinalizedInvoice); // load invoice for escalation

      // attempts for escalation history
      dunningRepo.findByInvoiceId.mockResolvedValue([
        {
          id: "att-1",
          invoiceId: "inv-1",
          chargeId: null,
          paymentMethodId: null,
          attemptNumber: 2,
          scheduledDate: new Date(),
          executedAt: new Date(),
          status: "failed",
          failureReason: "no_active_payment_methods",
          createdAt: new Date(),
        },
      ]);

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("all_payment_methods_exhausted");

      // ChargesService should NOT be called
      expect(
        mockChargesService.executePaymentForInvoice,
      ).not.toHaveBeenCalled();

      // Attempt should be marked failed
      expect(dunningRepo.updateStatus).toHaveBeenCalledWith(
        "attempt-1",
        expect.objectContaining({
          status: "failed",
          failureReason: "no_active_payment_methods",
        }),
      );

      // Remaining scheduled attempts should be skipped
      expect(dunningRepo.markRemainingAsSkipped).toHaveBeenCalledWith("inv-1");

      // Should escalate
      expect(mockSqsProducerService.publish).toHaveBeenCalledWith(
        "dunning.escalated",
        expect.objectContaining({ invoiceId: "inv-1" }),
        "corr-1",
        undefined,
      );
    });

    it("should record paymentMethodId on success and skip remaining attempts", async () => {
      mockPaymentMethodsService.getOrderedPaymentMethods.mockResolvedValue([
        {
          id: "pm-a",
          stripePaymentMethodId: "spm_a",
          isDefault: true,
          fallbackOrder: null,
        },
        {
          id: "pm-b",
          stripePaymentMethodId: "spm_b",
          isDefault: false,
          fallbackOrder: 1,
        },
      ]);

      dunningRepo.findById.mockResolvedValue(mockScheduledAttempt); // attemptNumber=2
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);
      // attempt history — PM-A failed
      dunningRepo.findByInvoiceId.mockResolvedValue([
        {
          id: "att-1",
          invoiceId: "inv-1",
          paymentMethodId: "pm-a",
          status: "failed",
          attemptNumber: 1,
          chargeId: "ch-1",
          scheduledDate: new Date(),
          executedAt: new Date(),
          failureReason: "Declined",
          createdAt: new Date(),
        },
      ]);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "charge-2",
        status: "succeeded",
        stripePaymentIntentId: "pi_2",
      });

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("succeeded");
      expect(result.chargeId).toBe("charge-2");

      // Verify transaction updates
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(dunningRepo.updateStatus).toHaveBeenCalledWith(
        "attempt-1",
        expect.objectContaining({
          status: "succeeded",
          paymentMethodId: "pm-b",
          chargeId: "charge-2",
        }),
        "tx-mock",
      );
      // Verify remaining attempts skipped
      expect(dunningRepo.markRemainingAsSkipped).toHaveBeenCalledWith(
        "inv-1",
        "tx-mock",
      );
    });

    it("should retry single PM 3 times without early escalation (backward compat)", async () => {
      mockPaymentMethodsService.getOrderedPaymentMethods.mockResolvedValue([
        {
          id: "pm-only",
          stripePaymentMethodId: "spm_only",
          isDefault: true,
          fallbackOrder: null,
        },
      ]);

      // First retry (attempt 2)
      dunningRepo.findById.mockResolvedValue({
        ...mockScheduledAttempt,
        attemptNumber: 2,
      });
      invoicesRepo.findById.mockResolvedValue(mockFinalizedInvoice);

      mockChargesService.executePaymentForInvoice.mockResolvedValue({
        chargeId: "ch-2",
        status: "failed",
        stripePaymentIntentId: null,
        failureReason: "Declined",
      });

      const result = await service.executeDunningAttempt("attempt-1", "corr-1");

      expect(result.status).toBe("failed");
      // Should schedule next attempt (not escalate) — still has retries
      expect(dunningRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: "inv-1",
          attemptNumber: 3,
          status: "scheduled",
        }),
        "tx-mock",
      );
      // Escalation should NOT happen
      expect(mockSubscriptionsService.updateState).not.toHaveBeenCalled();
      expect(mockSqsProducerService.publish).not.toHaveBeenCalled();
    });
  });
});
