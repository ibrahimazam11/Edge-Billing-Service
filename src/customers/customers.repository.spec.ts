import { Test } from "@nestjs/testing";
import { CustomersRepository } from "./customers.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

const mockCustomerRow = {
  id: "01234567-89ab-7def-0123-456789abcdef",
  monolithCustomerId: "mono-123",
  stripeCustomerId: "cus_stripe_123",
  name: "Test Customer",
  email: "test@example.com",
  status: "active",
  metadata: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("CustomersRepository", () => {
  let repository: CustomersRepository;
  let mockDb: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      orderBy: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([mockCustomerRow]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        CustomersRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<CustomersRepository>(CustomersRepository);
  });

  describe("findByMonolithId", () => {
    it("should return customer when found", async () => {
      mockDb.limit.mockResolvedValueOnce([mockCustomerRow]);

      const result = await repository.findByMonolithId("mono-123");

      expect(result).toEqual(mockCustomerRow);
      expect(mockDb.where).toHaveBeenCalled();
    });

    it("should return null when not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repository.findByMonolithId("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("findAll", () => {
    it("should return customers with pagination", async () => {
      mockDb.limit.mockResolvedValueOnce([mockCustomerRow]);

      const result = await repository.findAll({}, 20);

      expect(result).toEqual([mockCustomerRow]);
      expect(mockDb.limit).toHaveBeenCalledWith(21);
      expect(mockDb.orderBy).toHaveBeenCalled();
    });

    it("should filter by status", async () => {
      mockDb.limit.mockResolvedValueOnce([mockCustomerRow]);

      await repository.findAll({ status: "active" }, 20);

      expect(mockDb.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should filter by cursor", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await repository.findAll({ cursor: "some-id" }, 20);

      expect(mockDb.where).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe("search", () => {
    it("should search by name with ilike", async () => {
      mockDb.limit.mockResolvedValueOnce([mockCustomerRow]);

      const result = await repository.search({ name: "Test" }, 20);

      expect(result).toEqual([mockCustomerRow]);
      expect(mockDb.where).toHaveBeenCalledWith(expect.anything());
      expect(mockDb.limit).toHaveBeenCalledWith(21);
    });

    it("should search by email with ilike", async () => {
      mockDb.limit.mockResolvedValueOnce([mockCustomerRow]);

      await repository.search({ email: "test@" }, 20);

      expect(mockDb.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should filter by externalId", async () => {
      mockDb.limit.mockResolvedValueOnce([mockCustomerRow]);

      await repository.search({ externalId: "mono-123" }, 20);

      expect(mockDb.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should combine multiple filters", async () => {
      mockDb.limit.mockResolvedValueOnce([mockCustomerRow]);

      await repository.search(
        { name: "Test", status: "active", cursor: "id-1" },
        20,
      );

      expect(mockDb.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should return empty array when no results", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repository.search({ name: "Nobody" }, 20);

      expect(result).toEqual([]);
    });

    it("should escape ILIKE special characters in name and email filters", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await repository.search(
        { name: "100%_match\\test", email: "user%_@test.com" },
        20,
      );

      expect(mockDb.where).toHaveBeenCalledWith(expect.anything());

      // Verify the private escapeIlike helper produces correct output
      const escape = (
        repository as unknown as { escapeIlike: (v: string) => string }
      ).escapeIlike;
      expect(escape("100%_match\\test")).toBe("100\\%\\_match\\\\test");
      expect(escape("user%_@test.com")).toBe("user\\%\\_@test.com");
      expect(escape("normal")).toBe("normal");
    });
  });

  describe("countMonolithCustomers", () => {
    it("should return count of customers with monolith_customer_id", async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ count: 42 }],
      });

      const result = await repository.countMonolithCustomers();

      expect(result).toBe(42);
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("should return 0 when no rows returned", async () => {
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

      const result = await repository.countMonolithCustomers();

      expect(result).toBe(0);
    });

    it("should return 0 when row has count 0", async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ count: 0 }],
      });

      const result = await repository.countMonolithCustomers();

      expect(result).toBe(0);
    });
  });
});
