import { Test } from "@nestjs/testing";
import { ChargesRepository } from "./charges.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

const executeMock = jest.fn();

const now = new Date("2026-02-10T00:00:00.000Z");

const mockChargeRow = {
  id: "charge-123",
  invoiceId: "inv-123",
  customerId: "cust-123",
  paymentMethodId: "pm-123",
  amountCents: 5000,
  currency: "usd",
  status: "succeeded",
  stripePaymentIntentId: "pi_stripe_123",
  idempotencyKey: "inv_inv-123_att_1",
  failureReason: null,
  attemptNumber: 1,
  createdAt: now,
  updatedAt: now,
};

describe("ChargesRepository", () => {
  let repository: ChargesRepository;
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
      leftJoin: jest.fn().mockReturnThis(),
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
      delete: jest.fn().mockReturnThis(),
      execute: executeMock,
    };

    const module = await Test.createTestingModule({
      providers: [
        ChargesRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<ChargesRepository>(ChargesRepository);
  });

  describe("create (override guard)", () => {
    it("should throw directing callers to createWithIdempotency", async () => {
      await expect(repository.create({} as never)).rejects.toThrow(
        "use createWithIdempotency()",
      );
    });
  });

  describe("findByIdempotencyKey", () => {
    it("should return charge when found by idempotency key", async () => {
      selectChain.limit.mockResolvedValueOnce([mockChargeRow]);

      const result = await repository.findByIdempotencyKey("inv_inv-123_att_1");

      expect(result).toEqual(mockChargeRow);
      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });

    it("should return null when not found", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findByIdempotencyKey("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("findByStripePaymentIntentId", () => {
    it("should return charge when found by payment intent ID", async () => {
      selectChain.limit.mockResolvedValueOnce([mockChargeRow]);

      const result =
        await repository.findByStripePaymentIntentId("pi_stripe_123");

      expect(result).toEqual(mockChargeRow);
      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });

    it("should return null when not found", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result =
        await repository.findByStripePaymentIntentId("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("findByInvoiceId", () => {
    it("should return charges for an invoice", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([mockChargeRow]),
      );

      const result = await repository.findByInvoiceId("inv-123");

      expect(result).toEqual([mockChargeRow]);
      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should return empty array when no charges exist", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([]),
      );

      const result = await repository.findByInvoiceId("inv-123");

      expect(result).toEqual([]);
    });
  });

  describe("findByCustomerWithPaymentMethod", () => {
    const mockJoinResult = {
      id: "charge-123",
      invoiceId: "inv-123",
      amountCents: 5000,
      currency: "usd",
      status: "succeeded",
      stripePaymentIntentId: "pi_stripe_123",
      failureReason: null,
      attemptNumber: 1,
      createdAt: now,
      paymentMethodType: "card",
      gatewayProvider: "stripe",
    };

    it("should return charges with payment method info", async () => {
      selectChain.limit.mockResolvedValueOnce([mockJoinResult]);

      const result = await repository.findByCustomerWithPaymentMethod(
        "cust-123",
        {},
        20,
      );

      expect(result).toEqual([mockJoinResult]);
      expect(selectChain.leftJoin).toHaveBeenCalled();
      expect(selectChain.orderBy).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should apply date filters", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.findByCustomerWithPaymentMethod(
        "cust-123",
        { dateFrom: "2026-01-01", dateTo: "2026-02-01", cursor: "id-1" },
        20,
      );

      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });
  });

  describe("findForBillingHistory", () => {
    it("should return charges for billing history", async () => {
      selectChain.limit.mockResolvedValueOnce([mockChargeRow]);

      const result = await repository.findForBillingHistory(
        "cust-123",
        { startDate: "2026-01-01" },
        20,
      );

      expect(result).toEqual([mockChargeRow]);
      expect(selectChain.orderBy).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should apply all filters", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.findForBillingHistory(
        "cust-123",
        {
          startDate: "2026-01-01",
          endDate: "2026-02-01",
          cursor: new Date("2026-01-15"),
        },
        20,
      );

      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe("createWithIdempotency", () => {
    it("should insert and return charge with isDuplicate false", async () => {
      const newCharge = {
        id: "charge-new",
        invoiceId: "inv-123",
        customerId: "cust-123",
        paymentMethodId: "pm-123",
        amountCents: 5000,
        currency: "usd",
        status: "pending",
        idempotencyKey: "inv_inv-123_att_1",
        attemptNumber: 1,
        createdAt: now,
        updatedAt: now,
      };

      insertChain.returning.mockResolvedValueOnce([newCharge]);

      const result = await repository.createWithIdempotency(newCharge);

      expect(result.isDuplicate).toBe(false);
      expect(result.charge).toEqual(newCharge);
      expect(mockDb.insert).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(newCharge);
      expect(insertChain.returning).toHaveBeenCalled();
    });

    it("should handle duplicate key error (error.code) and return existing charge", async () => {
      insertChain.returning.mockRejectedValueOnce(
        Object.assign(new Error("unique_violation"), { code: "23505" }),
      );
      selectChain.limit.mockResolvedValueOnce([mockChargeRow]);

      const result = await repository.createWithIdempotency({
        id: "charge-new",
        invoiceId: "inv-123",
        customerId: "cust-123",
        paymentMethodId: "pm-123",
        amountCents: 5000,
        currency: "usd",
        status: "pending",
        idempotencyKey: "inv_inv-123_att_1",
        attemptNumber: 1,
        createdAt: now,
        updatedAt: now,
      });

      expect(result.isDuplicate).toBe(true);
      expect(result.charge).toEqual(mockChargeRow);
    });

    it("should handle duplicate key error via drizzle-orm wrapped error (error.cause.code)", async () => {
      const wrappedError = new Error("Failed query: INSERT INTO charges...");
      Object.defineProperty(wrappedError, "cause", {
        value: { code: "23505" },
      });
      insertChain.returning.mockRejectedValueOnce(wrappedError);
      selectChain.limit.mockResolvedValueOnce([mockChargeRow]);

      const result = await repository.createWithIdempotency({
        id: "charge-new",
        invoiceId: "inv-123",
        customerId: "cust-123",
        paymentMethodId: "pm-123",
        amountCents: 5000,
        currency: "usd",
        status: "pending",
        idempotencyKey: "inv_inv-123_att_1",
        attemptNumber: 1,
        createdAt: now,
        updatedAt: now,
      });

      expect(result.isDuplicate).toBe(true);
      expect(result.charge).toEqual(mockChargeRow);
    });

    it("should re-throw when 23505 but idempotency lookup returns null", async () => {
      insertChain.returning.mockRejectedValueOnce(
        Object.assign(new Error("unique_violation"), { code: "23505" }),
      );
      selectChain.limit.mockResolvedValueOnce([]);

      await expect(
        repository.createWithIdempotency({
          id: "charge-new",
          invoiceId: "inv-123",
          customerId: "cust-123",
          paymentMethodId: "pm-123",
          amountCents: 5000,
          currency: "usd",
          status: "pending",
          idempotencyKey: "inv_inv-123_att_race",
          attemptNumber: 1,
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow("unique_violation");
    });

    it("should rethrow non-duplicate errors", async () => {
      insertChain.returning.mockRejectedValueOnce(new Error("Connection lost"));

      await expect(
        repository.createWithIdempotency({
          id: "charge-new",
          invoiceId: "inv-123",
          customerId: "cust-123",
          paymentMethodId: "pm-123",
          amountCents: 5000,
          currency: "usd",
          status: "pending",
          idempotencyKey: "inv_inv-123_att_1",
          attemptNumber: 1,
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow("Connection lost");
    });
  });

  describe("updateStatus", () => {
    it("should update charge status", async () => {
      await repository.updateStatus("charge-123", {
        status: "succeeded",
        stripePaymentIntentId: "pi_stripe_123",
        updatedAt: now,
      });

      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith({
        status: "succeeded",
        stripePaymentIntentId: "pi_stripe_123",
        updatedAt: now,
      });
      expect(updateChain.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should use tx when provided", async () => {
      const txMock = {
        update: jest.fn(() => ({
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockResolvedValue(undefined),
        })),
      };

      await repository.updateStatus(
        "charge-123",
        { status: "failed", failureReason: "Card declined", updatedAt: now },
        txMock as never,
      );

      expect(txMock.update).toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("findByIds", () => {
    it("should return charges for given IDs", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([mockChargeRow]),
      );

      const result = await repository.findByIds(["charge-123"]);

      expect(result).toEqual([mockChargeRow]);
      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should return empty array for empty IDs", async () => {
      const result = await repository.findByIds([]);

      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe("aggregateSuccessRateByDateRange", () => {
    it("should return totalCharges and succeededCharges from raw SQL", async () => {
      executeMock.mockResolvedValueOnce({
        rows: [{ totalCharges: 20, succeededCharges: 18 }],
      });

      const result = await repository.aggregateSuccessRateByDateRange(
        "2026-01-01",
        "2026-02-01",
      );

      expect(result).toEqual({ totalCharges: 20, succeededCharges: 18 });
      expect(executeMock).toHaveBeenCalledTimes(1);
    });

    it("should return zeros when no rows are returned", async () => {
      executeMock.mockResolvedValueOnce({ rows: [] });

      const result = await repository.aggregateSuccessRateByDateRange(
        "2026-01-01",
        "2026-02-01",
      );

      expect(result).toEqual({ totalCharges: 0, succeededCharges: 0 });
    });

    it("should return zeros when row is undefined", async () => {
      executeMock.mockResolvedValueOnce({ rows: [undefined] });

      const result = await repository.aggregateSuccessRateByDateRange(
        "2026-01-01",
        "2026-02-01",
      );

      expect(result).toEqual({ totalCharges: 0, succeededCharges: 0 });
    });
  });
});
