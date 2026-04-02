import { Test } from "@nestjs/testing";
import { SubscriptionsRepository } from "./subscriptions.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

const now = new Date("2026-02-01T00:00:00Z");

const mockSubscription = {
  id: "sub-uuid-1",
  customerId: "cust-uuid-1",
  planName: "pro",
  status: "active",
  amountCents: 5000,
  currency: "usd",
  billingInterval: "monthly",
  billingPeriodStart: now,
  billingPeriodEnd: new Date("2026-03-01T00:00:00Z"),
  nextBillingDate: new Date("2026-03-01T00:00:00Z"),
  stripeSubscriptionId: null,
  metadata: null,
  createdAt: now,
  updatedAt: now,
};

describe("SubscriptionsRepository", () => {
  let repository: SubscriptionsRepository;
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
      returning: jest.fn().mockResolvedValue([mockSubscription]),
    };

    updateChain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([]),
      then: jest.fn((resolve: (value: unknown) => void) => resolve(undefined)),
    };

    mockDb = {
      select: jest.fn(() => selectChain),
      insert: jest.fn(() => insertChain),
      update: jest.fn(() => updateChain),
      delete: jest.fn().mockReturnThis(),
      execute: jest
        .fn()
        .mockResolvedValue({ rows: [{ activeCount: 5, mrr: 25000 }] }),
    };

    const module = await Test.createTestingModule({
      providers: [
        SubscriptionsRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<SubscriptionsRepository>(SubscriptionsRepository);
  });

  describe("findByCustomer", () => {
    it("should return subscriptions for a customer with pagination", async () => {
      selectChain.limit.mockResolvedValueOnce([mockSubscription]);

      const result = await repository.findByCustomer("cust-uuid-1", {}, 20);

      expect(result).toEqual([mockSubscription]);
      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should filter by status", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.findByCustomer("cust-uuid-1", { status: "active" }, 20);

      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should apply cursor", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.findByCustomer("cust-uuid-1", { cursor: "sub-id" }, 20);

      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe("findDueForBilling", () => {
    it("should return subscriptions due for billing", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([mockSubscription]),
      );

      const result = await repository.findDueForBilling(now);

      expect(result).toEqual([mockSubscription]);
      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should return empty array when none due", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([]),
      );

      const result = await repository.findDueForBilling(now);

      expect(result).toEqual([]);
    });
  });

  describe("updateStateWithConcurrencyCheck", () => {
    it("should update and return subscription when status matches", async () => {
      const updated = { ...mockSubscription, status: "paused" };
      updateChain.returning.mockResolvedValueOnce([updated]);

      const result = await repository.updateStateWithConcurrencyCheck(
        "sub-uuid-1",
        { status: "paused", updatedAt: now },
        "active",
      );

      expect(result).toEqual(updated);
      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith({
        status: "paused",
        updatedAt: now,
      });
    });

    it("should return null when status does not match (concurrent modification)", async () => {
      updateChain.returning.mockResolvedValueOnce([]);

      const result = await repository.updateStateWithConcurrencyCheck(
        "sub-uuid-1",
        { status: "paused" },
        "active",
      );

      expect(result).toBeNull();
    });

    it("should use tx when provided", async () => {
      const txUpdateChain = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([mockSubscription]),
      };
      const txMock = { update: jest.fn(() => txUpdateChain) };

      const result = await repository.updateStateWithConcurrencyCheck(
        "sub-uuid-1",
        { status: "paused" },
        "active",
        txMock as never,
      );

      expect(result).toEqual(mockSubscription);
      expect(txMock.update).toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("getActiveMetrics", () => {
    it("should return active count and MRR", async () => {
      const result = await repository.getActiveMetrics();

      expect(result).toEqual({ activeCount: 5, mrr: 25000 });
      expect(mockDb.execute).toHaveBeenCalled();
    });

    it("should return zeros when no results", async () => {
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

      const result = await repository.getActiveMetrics();

      expect(result).toEqual({ activeCount: 0, mrr: 0 });
    });
  });

  describe("findAllWithCustomer", () => {
    it("should return joined rows with customer name and email", async () => {
      const joinedRow = {
        subscription: mockSubscription,
        customerName: "Test Customer",
        customerEmail: "test@example.com",
      };
      selectChain.limit.mockResolvedValueOnce([joinedRow]);

      const result = await repository.findAllWithCustomer(
        { customerId: "cust-uuid-1", status: "active" },
        20,
      );

      expect(result).toEqual([joinedRow]);
      expect(selectChain.leftJoin).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should work with no filters", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findAllWithCustomer({}, 10);

      expect(result).toEqual([]);
      expect(selectChain.limit).toHaveBeenCalledWith(11);
    });

    it("should apply cursor filter", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.findAllWithCustomer({ cursor: "sub-id" }, 20);

      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should apply date range filters", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.findAllWithCustomer(
        { startDate: "2026-01-01", endDate: "2026-02-01" },
        20,
      );

      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe("findAllWithFilters", () => {
    it("should apply all filters", async () => {
      selectChain.limit.mockResolvedValueOnce([mockSubscription]);

      const result = await repository.findAllWithFilters(
        {
          customerId: "cust-1",
          status: "active",
          startDate: "2026-01-01",
          endDate: "2026-02-01",
          cursor: "sub-id",
        },
        20,
      );

      expect(result).toEqual([mockSubscription]);
      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should work with no filters", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findAllWithFilters({}, 10);

      expect(result).toEqual([]);
      expect(selectChain.limit).toHaveBeenCalledWith(11);
    });
  });
});
