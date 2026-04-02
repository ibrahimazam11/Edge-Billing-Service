import { Test } from "@nestjs/testing";
import { GatewayAssignmentsRepository } from "./gateway-assignments.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

const makeRow = (overrides = {}) => ({
  id: "ga-uuid-1",
  customerId: "cust-uuid-1",
  gatewayProvider: "adyen",
  gatewayCustomerId: "ADYEN_SHOPPER_123",
  metadata: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

describe("GatewayAssignmentsRepository", () => {
  let repository: GatewayAssignmentsRepository;
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
        GatewayAssignmentsRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<GatewayAssignmentsRepository>(
      GatewayAssignmentsRepository,
    );
  });

  describe("findByCustomer", () => {
    it("should return all gateway assignments for a customer ordered by createdAt DESC", async () => {
      const rows = [makeRow(), makeRow({ id: "ga-uuid-2" })];
      // findByCustomer ends with orderBy (no limit), so orderBy resolves the promise
      selectChain.orderBy.mockReturnValueOnce({
        then: (resolve: (v: unknown) => void) => resolve(rows),
      });

      const result = await repository.findByCustomer("cust-uuid-1");

      expect(result).toHaveLength(2);
      expect(result).toEqual(rows);
      expect(mockDb.select).toHaveBeenCalled();
      expect(selectChain.from).toHaveBeenCalled();
      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.orderBy).toHaveBeenCalled();
    });

    it("should return empty array when no assignments exist", async () => {
      selectChain.orderBy.mockReturnValueOnce({
        then: (resolve: (v: unknown) => void) => resolve([]),
      });

      const result = await repository.findByCustomer("cust-no-assignments");

      expect(result).toHaveLength(0);
      expect(result).toEqual([]);
    });
  });

  describe("findByCustomerAndProvider", () => {
    it("should return assignment when found by customer and provider", async () => {
      selectChain.limit.mockResolvedValueOnce([makeRow()]);

      const result = await repository.findByCustomerAndProvider(
        "cust-uuid-1",
        "adyen",
      );

      expect(result).toEqual(makeRow());
      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });

    it("should return null when no assignment found", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findByCustomerAndProvider(
        "cust-uuid-1",
        "adyen",
      );

      expect(result).toBeNull();
    });
  });

  describe("updateGatewayCustomerId", () => {
    it("should update gateway customer ID for given assignment", async () => {
      await repository.updateGatewayCustomerId("ga-uuid-1", "NEW_SHOPPER_456");

      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith({
        gatewayCustomerId: "NEW_SHOPPER_456",
        updatedAt: expect.any(Date),
      });
      expect(updateChain.where).toHaveBeenCalled();
    });
  });

  describe("findById (inherited)", () => {
    it("should return assignment when found by ID", async () => {
      selectChain.limit.mockResolvedValueOnce([makeRow()]);

      const result = await repository.findById("ga-uuid-1");

      expect(result).toEqual(makeRow());
      expect(mockDb.select).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });

    it("should return null when not found", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findById("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("create (inherited)", () => {
    it("should insert and return gateway assignment", async () => {
      insertChain.returning.mockResolvedValueOnce([makeRow()]);

      const result = await repository.create({
        id: "ga-uuid-1",
        customerId: "cust-uuid-1",
        gatewayProvider: "adyen",
        gatewayCustomerId: "ADYEN_SHOPPER_123",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(result).toEqual(makeRow());
      expect(mockDb.insert).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalled();
    });
  });
});
