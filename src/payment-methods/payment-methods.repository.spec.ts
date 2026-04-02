import { Test } from "@nestjs/testing";
import { PaymentMethodsRepository } from "./payment-methods.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

const makeRow = (overrides = {}) => ({
  id: "pm-uuid-1",
  customerId: "cust-uuid-1",
  stripePaymentMethodId: "pm_stripe_1",
  type: "card",
  isDefault: false,
  lastFour: "4242",
  brand: "visa",
  bankName: null,
  expiryMonth: 12,
  expiryYear: 2027,
  metadata: null,
  fallbackOrder: null,
  gatewayProvider: "stripe",
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

describe("PaymentMethodsRepository", () => {
  let repository: PaymentMethodsRepository;
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
    };

    insertChain = {
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([makeRow()]),
    };

    updateChain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([makeRow()]),
    };

    mockDb = {
      select: jest.fn(() => selectChain),
      insert: jest.fn(() => insertChain),
      update: jest.fn(() => updateChain),
    };

    const module = await Test.createTestingModule({
      providers: [
        PaymentMethodsRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<PaymentMethodsRepository>(PaymentMethodsRepository);
  });

  describe("findById", () => {
    it("should return PM when found", async () => {
      selectChain.limit.mockResolvedValueOnce([makeRow()]);

      const result = await repository.findById("pm-uuid-1");

      expect(result).toEqual(makeRow());
      expect(mockDb.select).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });

    it("should return null when not found", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findById("non-existent");

      expect(result).toBeNull();
    });

    it("should use tx when provided", async () => {
      const txMock = {
        select: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([makeRow()]),
      };

      const result = await repository.findById("pm-uuid-1", txMock as never);

      expect(result).toEqual(makeRow());
      expect(txMock.select).toHaveBeenCalled();
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe("findByIdAndCustomer", () => {
    it("should return PM when found by id+customer+active", async () => {
      selectChain.limit.mockResolvedValueOnce([makeRow()]);

      const result = await repository.findByIdAndCustomer(
        "pm-uuid-1",
        "cust-uuid-1",
      );

      expect(result).toEqual(makeRow());
      expect(selectChain.where).toHaveBeenCalled();
    });

    it("should return null when not found", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findByIdAndCustomer(
        "non-existent",
        "cust-uuid-1",
      );

      expect(result).toBeNull();
    });
  });

  describe("findActiveByCustomer", () => {
    it("should return oldest active PM for customer ordered by createdAt", async () => {
      selectChain.limit.mockResolvedValueOnce([makeRow()]);

      const result = await repository.findActiveByCustomer("cust-uuid-1");

      expect(result).toEqual(makeRow());
      expect(selectChain.orderBy).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });

    it("should return null when no active PMs", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findActiveByCustomer("cust-uuid-1");

      expect(result).toBeNull();
    });
  });

  describe("findAllByCustomer", () => {
    it("should return PMs with pagination", async () => {
      selectChain.limit.mockResolvedValueOnce([makeRow()]);

      const result = await repository.findAllByCustomer("cust-uuid-1", {}, 20);

      expect(result).toEqual([makeRow()]);
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should apply cursor filter", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.findAllByCustomer("cust-uuid-1", { cursor: "id-1" }, 20);

      expect(selectChain.where).toHaveBeenCalled();
    });
  });

  describe("findAllByCustomerUnfiltered", () => {
    it("should return all PMs for customer regardless of status", async () => {
      const rows = [makeRow(), makeRow({ id: "pm-2", status: "detached" })];
      selectChain.where.mockResolvedValueOnce(rows);

      const result =
        await repository.findAllByCustomerUnfiltered("cust-uuid-1");

      expect(result).toEqual(rows);
      expect(mockDb.select).toHaveBeenCalled();
      expect(selectChain.from).toHaveBeenCalled();
      expect(selectChain.where).toHaveBeenCalled();
    });

    it("should return empty array when customer has no PMs", async () => {
      selectChain.where.mockResolvedValueOnce([]);

      const result =
        await repository.findAllByCustomerUnfiltered("cust-uuid-1");

      expect(result).toEqual([]);
    });
  });

  describe("getDefaultPaymentMethod", () => {
    it("should return default active PM", async () => {
      selectChain.limit.mockResolvedValueOnce([makeRow({ isDefault: true })]);

      const result = await repository.getDefaultPaymentMethod("cust-uuid-1");

      expect(result).toEqual(makeRow({ isDefault: true }));
    });

    it("should return null when no default", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.getDefaultPaymentMethod("cust-uuid-1");

      expect(result).toBeNull();
    });
  });

  describe("getOrderedByCustomer", () => {
    it("should return PMs ordered by isDefault DESC, fallbackOrder ASC", async () => {
      const rows = [makeRow({ isDefault: true }), makeRow({ id: "pm-2" })];
      selectChain.orderBy.mockReturnValueOnce({
        then: (resolve: (v: unknown) => void) => resolve(rows),
      });

      const result = await repository.getOrderedByCustomer("cust-uuid-1");

      expect(result).toHaveLength(2);
      expect(selectChain.orderBy).toHaveBeenCalled();
    });
  });

  describe("findNextDefault", () => {
    it("should return oldest active PM excluding given id", async () => {
      selectChain.limit.mockResolvedValueOnce([makeRow({ id: "pm-uuid-2" })]);

      const result = await repository.findNextDefault(
        "cust-uuid-1",
        "pm-uuid-1",
      );

      expect(result).toEqual(makeRow({ id: "pm-uuid-2" }));
      expect(selectChain.orderBy).toHaveBeenCalled();
    });

    it("should return null when no other active PMs", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findNextDefault(
        "cust-uuid-1",
        "pm-uuid-1",
      );

      expect(result).toBeNull();
    });
  });

  describe("create", () => {
    it("should insert and return PM", async () => {
      insertChain.returning.mockResolvedValueOnce([makeRow()]);

      const result = await repository.create({
        id: "pm-uuid-1",
        customerId: "cust-uuid-1",
        stripePaymentMethodId: "pm_stripe_1",
        type: "card",
        isDefault: false,
        status: "active",
        gatewayProvider: "stripe",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(result).toEqual(makeRow());
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe("updateDefault", () => {
    it("should update isDefault and return PM", async () => {
      updateChain.returning.mockResolvedValueOnce([
        makeRow({ isDefault: true }),
      ]);

      const result = await repository.updateDefault("pm-uuid-1", true);

      expect(result.isDefault).toBe(true);
      expect(updateChain.set).toHaveBeenCalledWith({
        isDefault: true,
        updatedAt: expect.any(Date),
      });
    });

    it("should use provided updatedAt when given", async () => {
      const customDate = new Date("2025-06-15T00:00:00Z");
      updateChain.returning.mockResolvedValueOnce([
        makeRow({ isDefault: true, updatedAt: customDate }),
      ]);

      const result = await repository.updateDefault(
        "pm-uuid-1",
        true,
        customDate,
      );

      expect(result.updatedAt).toEqual(customDate);
      expect(updateChain.set).toHaveBeenCalledWith({
        isDefault: true,
        updatedAt: customDate,
      });
    });
  });

  describe("updateStatus", () => {
    it("should update status", async () => {
      await repository.updateStatus("pm-uuid-1", "detached", {
        isDefault: false,
      });

      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "detached", isDefault: false }),
      );
    });

    it("should use provided updatedAt when given", async () => {
      const customDate = new Date("2025-06-15T00:00:00Z");

      await repository.updateStatus(
        "pm-uuid-1",
        "detached",
        { isDefault: false },
        customDate,
      );

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "detached",
          isDefault: false,
          updatedAt: customDate,
        }),
      );
    });
  });

  describe("updateFallbackOrder", () => {
    it("should update fallbackOrder and return PM", async () => {
      updateChain.returning.mockResolvedValueOnce([
        makeRow({ fallbackOrder: 2 }),
      ]);

      const result = await repository.updateFallbackOrder("pm-uuid-1", 2);

      expect(result.fallbackOrder).toBe(2);
      expect(updateChain.set).toHaveBeenCalledWith({
        fallbackOrder: 2,
        updatedAt: expect.any(Date),
      });
    });

    it("should use provided updatedAt when given", async () => {
      const customDate = new Date("2025-06-15T00:00:00Z");
      updateChain.returning.mockResolvedValueOnce([
        makeRow({ fallbackOrder: 3, updatedAt: customDate }),
      ]);

      const result = await repository.updateFallbackOrder(
        "pm-uuid-1",
        3,
        customDate,
      );

      expect(result.fallbackOrder).toBe(3);
      expect(updateChain.set).toHaveBeenCalledWith({
        fallbackOrder: 3,
        updatedAt: customDate,
      });
    });
  });

  describe("clearDefaults", () => {
    it("should set all default PMs to non-default for customer", async () => {
      await repository.clearDefaults("cust-uuid-1");

      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith({
        isDefault: false,
        updatedAt: expect.any(Date),
      });
      expect(updateChain.where).toHaveBeenCalled();
    });

    it("should use provided updatedAt when given", async () => {
      const customDate = new Date("2025-06-15T00:00:00Z");

      await repository.clearDefaults("cust-uuid-1", customDate);

      expect(updateChain.set).toHaveBeenCalledWith({
        isDefault: false,
        updatedAt: customDate,
      });
    });
  });
});
