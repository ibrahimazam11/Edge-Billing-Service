import { Test } from "@nestjs/testing";
import { RefundsRepository } from "./refunds.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

const now = new Date("2026-02-10T00:00:00.000Z");

const mockRefundRow = {
  id: "r0000000-0000-4000-a000-000000000001",
  chargeId: "c0000000-0000-4000-a000-000000000001",
  invoiceId: "i0000000-0000-4000-a000-000000000001",
  customerId: "u0000000-0000-4000-a000-000000000001",
  amountCents: 5000,
  currency: "usd",
  status: "succeeded",
  reason: "customer_request",
  idempotencyKey: "refund_key_1",
  gatewayRefundId: "re_test_123",
  failureReason: null,
  createdAt: now,
  updatedAt: now,
};

describe("RefundsRepository", () => {
  let repository: RefundsRepository;
  let selectChain: Record<string, jest.Mock>;
  let insertChain: Record<string, jest.Mock>;
  let updateChain: Record<string, jest.Mock>;
  let mockDb: Record<string, jest.Mock>;

  beforeEach(async () => {
    selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      orderBy: jest.fn().mockReturnThis(),
      then: jest.fn((resolve: (value: unknown[]) => void) => resolve([])),
    };

    insertChain = {
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([]),
    };

    updateChain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    };

    mockDb = {
      select: jest.fn(() => selectChain),
      insert: jest.fn(() => insertChain),
      update: jest.fn(() => updateChain),
    };

    const module = await Test.createTestingModule({
      providers: [
        RefundsRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<RefundsRepository>(RefundsRepository);
  });

  describe("create (override guard)", () => {
    it("should throw directing callers to createWithIdempotency", async () => {
      await expect(repository.create({} as never)).rejects.toThrow(
        "use createWithIdempotency()",
      );
    });
  });

  describe("findByIdempotencyKey", () => {
    it("should return refund when found by idempotency key", async () => {
      selectChain.limit.mockResolvedValueOnce([mockRefundRow]);

      const result = await repository.findByIdempotencyKey("refund_key_1");

      expect(result).toEqual(mockRefundRow);
      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });

    it("should return null when not found", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findByIdempotencyKey("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("findSucceededByChargeId", () => {
    it("should return succeeded refunds for a charge", async () => {
      selectChain.then = jest.fn((resolve: (v: unknown) => void) =>
        resolve([mockRefundRow]),
      );

      const result = await repository.findSucceededByChargeId(
        "c0000000-0000-4000-a000-000000000001",
      );

      expect(result).toEqual([mockRefundRow]);
      expect(selectChain.where).toHaveBeenCalled();
    });

    it("should return empty array when no succeeded refunds exist", async () => {
      selectChain.then = jest.fn((resolve: (v: unknown) => void) =>
        resolve([]),
      );

      const result = await repository.findSucceededByChargeId("non-existent");

      expect(result).toEqual([]);
    });
  });

  describe("findForBillingHistory", () => {
    it("should return refunds for billing history", async () => {
      selectChain.limit.mockResolvedValueOnce([mockRefundRow]);

      const result = await repository.findForBillingHistory(
        "u0000000-0000-4000-a000-000000000001",
        { startDate: "2026-01-01" },
        20,
      );

      expect(result).toEqual([mockRefundRow]);
      expect(selectChain.orderBy).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should apply all filters", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.findForBillingHistory(
        "u0000000-0000-4000-a000-000000000001",
        {
          startDate: "2026-01-01",
          endDate: "2026-02-01",
          cursor: new Date("2026-01-15"),
        },
        20,
      );

      expect(selectChain.where).toHaveBeenCalled();
    });

    it("should apply only cursor filter when no dates provided", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.findForBillingHistory(
        "u0000000-0000-4000-a000-000000000001",
        { cursor: new Date("2026-01-15") },
        10,
      );

      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(11);
    });
  });

  describe("createWithIdempotency", () => {
    it("should insert and return refund with isDuplicate false", async () => {
      const newRefund = {
        id: "r0000000-0000-4000-a000-000000000002",
        chargeId: "c0000000-0000-4000-a000-000000000001",
        invoiceId: "i0000000-0000-4000-a000-000000000001",
        customerId: "u0000000-0000-4000-a000-000000000001",
        amountCents: 3000,
        currency: "usd",
        status: "pending",
        reason: "customer_request",
        idempotencyKey: "refund_key_2",
        createdAt: now,
        updatedAt: now,
      };

      insertChain.returning.mockResolvedValueOnce([newRefund]);

      const result = await repository.createWithIdempotency(newRefund);

      expect(result.isDuplicate).toBe(false);
      expect(result.refund).toEqual(newRefund);
      expect(mockDb.insert).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(newRefund);
      expect(insertChain.returning).toHaveBeenCalled();
    });

    it("should handle duplicate key error (error.code) and return existing refund", async () => {
      insertChain.returning.mockRejectedValueOnce(
        Object.assign(new Error("unique_violation"), { code: "23505" }),
      );
      selectChain.limit.mockResolvedValueOnce([mockRefundRow]);

      const result = await repository.createWithIdempotency({
        id: "r0000000-0000-4000-a000-000000000002",
        chargeId: "c0000000-0000-4000-a000-000000000001",
        invoiceId: "i0000000-0000-4000-a000-000000000001",
        customerId: "u0000000-0000-4000-a000-000000000001",
        amountCents: 5000,
        currency: "usd",
        status: "pending",
        reason: "customer_request",
        idempotencyKey: "refund_key_1",
        createdAt: now,
        updatedAt: now,
      });

      expect(result.isDuplicate).toBe(true);
      expect(result.refund).toEqual(mockRefundRow);
    });

    it("should handle duplicate key error via drizzle-orm wrapped error (error.cause.code)", async () => {
      const wrappedError = new Error("Failed query: INSERT INTO refunds...");
      Object.defineProperty(wrappedError, "cause", {
        value: { code: "23505" },
      });
      insertChain.returning.mockRejectedValueOnce(wrappedError);
      selectChain.limit.mockResolvedValueOnce([mockRefundRow]);

      const result = await repository.createWithIdempotency({
        id: "r0000000-0000-4000-a000-000000000002",
        chargeId: "c0000000-0000-4000-a000-000000000001",
        invoiceId: "i0000000-0000-4000-a000-000000000001",
        customerId: "u0000000-0000-4000-a000-000000000001",
        amountCents: 5000,
        currency: "usd",
        status: "pending",
        reason: "customer_request",
        idempotencyKey: "refund_key_1",
        createdAt: now,
        updatedAt: now,
      });

      expect(result.isDuplicate).toBe(true);
      expect(result.refund).toEqual(mockRefundRow);
    });

    it("should re-throw when 23505 but idempotency lookup returns nothing", async () => {
      insertChain.returning.mockRejectedValueOnce(
        Object.assign(new Error("unique_violation"), { code: "23505" }),
      );
      selectChain.limit.mockResolvedValueOnce([]);

      await expect(
        repository.createWithIdempotency({
          id: "r0000000-0000-4000-a000-000000000002",
          chargeId: "c0000000-0000-4000-a000-000000000001",
          invoiceId: "i0000000-0000-4000-a000-000000000001",
          customerId: "u0000000-0000-4000-a000-000000000001",
          amountCents: 5000,
          currency: "usd",
          status: "pending",
          reason: "customer_request",
          idempotencyKey: "refund_key_race",
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow("unique_violation");
    });

    it("should rethrow non-duplicate errors", async () => {
      insertChain.returning.mockRejectedValueOnce(new Error("Connection lost"));

      await expect(
        repository.createWithIdempotency({
          id: "r0000000-0000-4000-a000-000000000002",
          chargeId: "c0000000-0000-4000-a000-000000000001",
          invoiceId: "i0000000-0000-4000-a000-000000000001",
          customerId: "u0000000-0000-4000-a000-000000000001",
          amountCents: 5000,
          currency: "usd",
          status: "pending",
          reason: "customer_request",
          idempotencyKey: "refund_key_err",
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow("Connection lost");
    });
  });

  describe("updateStatus", () => {
    it("should update refund status", async () => {
      await repository.updateStatus("r0000000-0000-4000-a000-000000000001", {
        status: "processing",
        updatedAt: now,
      });

      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith({
        status: "processing",
        updatedAt: now,
      });
      expect(updateChain.where).toHaveBeenCalled();
    });

    it("should use tx when provided", async () => {
      const txMock = {
        update: jest.fn(() => ({
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockResolvedValue(undefined),
        })),
      };

      await repository.updateStatus(
        "r0000000-0000-4000-a000-000000000001",
        { status: "failed", failureReason: "Card declined", updatedAt: now },
        txMock as never,
      );

      expect(txMock.update).toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("updateToSucceeded", () => {
    it("should update refund to succeeded with gateway ref", async () => {
      await repository.updateToSucceeded(
        "r0000000-0000-4000-a000-000000000001",
        "re_gateway_123",
      );

      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "succeeded",
          gatewayRefundId: "re_gateway_123",
        }),
      );
      expect(updateChain.where).toHaveBeenCalled();
    });

    it("should use tx when provided", async () => {
      const txMock = {
        update: jest.fn(() => ({
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockResolvedValue(undefined),
        })),
      };

      await repository.updateToSucceeded(
        "r0000000-0000-4000-a000-000000000001",
        "re_gateway_456",
        txMock as never,
      );

      expect(txMock.update).toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });
});
