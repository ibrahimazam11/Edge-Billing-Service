import { Test } from "@nestjs/testing";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { BaseRepository } from "./base.repository";
import { DRIZZLE_PROVIDER } from "./database.provider";
import type { DrizzleDatabase } from "./types";
import { customers } from "./schema/customers";

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

class TestRepository extends BaseRepository<typeof customers> {
  protected readonly table = customers;

  constructor(db: DrizzleDatabase) {
    super(db);
  }

  // Expose protected helpers for testing
  public testBuildWhereClause(conditions: SQL[]): SQL | undefined {
    return this.buildWhereClause(conditions);
  }

  public testBuildDateRangeConditions(
    column: PgColumn,
    startDate?: string,
    endDate?: string,
  ): SQL[] {
    return this.buildDateRangeConditions(column, startDate, endDate);
  }

  public testBuildCursorCondition(
    column: PgColumn,
    cursor: string | undefined,
  ): SQL | undefined {
    return this.buildCursorCondition(column, cursor);
  }

  public testBuildTimestampCursorCondition(
    column: PgColumn,
    cursor: Date | undefined,
  ): SQL | undefined {
    return this.buildTimestampCursorCondition(column, cursor);
  }
}

describe("BaseRepository", () => {
  let repository: TestRepository;
  let mockDb: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([mockCustomerRow]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
    };

    const module = await Test.createTestingModule({
      providers: [
        {
          provide: TestRepository,
          useFactory: (db: DrizzleDatabase) => new TestRepository(db),
          inject: [DRIZZLE_PROVIDER],
        },
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<TestRepository>(TestRepository);
  });

  describe("findById", () => {
    it("should return entity when found", async () => {
      mockDb.limit.mockResolvedValueOnce([mockCustomerRow]);

      const result = await repository.findById(mockCustomerRow.id);

      expect(result).toEqual(mockCustomerRow);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalledWith(customers);
      expect(mockDb.where).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(1);
    });

    it("should return null when not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repository.findById("non-existent");

      expect(result).toBeNull();
    });

    it("should use tx when provided", async () => {
      const txMock = {
        select: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([mockCustomerRow]),
      };

      const result = await repository.findById(
        mockCustomerRow.id,
        txMock as never,
      );

      expect(result).toEqual(mockCustomerRow);
      expect(txMock.select).toHaveBeenCalled();
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe("create", () => {
    it("should insert and return the entity", async () => {
      mockDb.returning.mockResolvedValueOnce([mockCustomerRow]);

      const result = await repository.create({
        id: mockCustomerRow.id,
        monolithCustomerId: "mono-123",
        stripeCustomerId: "cus_stripe_123",
        name: "Test Customer",
        email: "test@example.com",
        status: "active",
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(result).toEqual(mockCustomerRow);
      expect(mockDb.insert).toHaveBeenCalledWith(customers);
      expect(mockDb.values).toHaveBeenCalled();
    });

    it("should throw when no row returned from INSERT", async () => {
      mockDb.returning.mockResolvedValueOnce([]);

      await expect(
        repository.create({
          id: mockCustomerRow.id,
          monolithCustomerId: "mono-123",
          stripeCustomerId: "cus_stripe_123",
          name: "Test Customer",
          email: "test@example.com",
          status: "active",
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ).rejects.toThrow("Expected row to be returned from INSERT");
    });

    it("should use tx when provided", async () => {
      const txMock = {
        insert: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([mockCustomerRow]),
      };

      const result = await repository.create(
        {
          id: mockCustomerRow.id,
          monolithCustomerId: "mono-123",
          stripeCustomerId: "cus_stripe_123",
          name: "Test Customer",
          email: "test@example.com",
          status: "active",
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        txMock as never,
      );

      expect(result).toEqual(mockCustomerRow);
      expect(txMock.insert).toHaveBeenCalledWith(customers);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("should update and return the entity", async () => {
      const updatedRow = { ...mockCustomerRow, name: "Updated" };
      mockDb.returning.mockResolvedValueOnce([updatedRow]);

      const result = await repository.update(mockCustomerRow.id, {
        name: "Updated",
      });

      expect(result).toEqual(updatedRow);
      expect(mockDb.update).toHaveBeenCalledWith(customers);
      expect(mockDb.set).toHaveBeenCalledWith({ name: "Updated" });
      expect(mockDb.where).toHaveBeenCalled();
    });

    it("should throw when no row returned from UPDATE", async () => {
      mockDb.returning.mockResolvedValueOnce([]);

      await expect(
        repository.update(mockCustomerRow.id, { name: "Updated" }),
      ).rejects.toThrow("Expected row to be returned from UPDATE");
    });

    it("should use tx when provided", async () => {
      const txMock = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([mockCustomerRow]),
      };

      const result = await repository.update(
        mockCustomerRow.id,
        { name: "Updated" },
        txMock as never,
      );

      expect(result).toEqual(mockCustomerRow);
      expect(txMock.update).toHaveBeenCalledWith(customers);
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("deleteById", () => {
    it("should delete the entity", async () => {
      await repository.deleteById(mockCustomerRow.id);

      expect(mockDb.delete).toHaveBeenCalledWith(customers);
      expect(mockDb.where).toHaveBeenCalled();
    });

    it("should use tx when provided", async () => {
      const txMock = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
      };

      await repository.deleteById(mockCustomerRow.id, txMock as never);

      expect(txMock.delete).toHaveBeenCalledWith(customers);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });
  });

  describe("buildWhereClause", () => {
    it("should return undefined for empty conditions", () => {
      const result = repository.testBuildWhereClause([]);

      expect(result).toBeUndefined();
    });

    it("should return SQL for non-empty conditions", () => {
      const mockCondition = { queryChunks: [] } as unknown as SQL;

      const result = repository.testBuildWhereClause([mockCondition]);

      expect(result).toBeDefined();
    });
  });

  describe("buildDateRangeConditions", () => {
    const column = customers.createdAt as PgColumn;

    it("should return empty array when no dates provided", () => {
      const result = repository.testBuildDateRangeConditions(column);

      expect(result).toEqual([]);
    });

    it("should add gte condition for startDate", () => {
      const result = repository.testBuildDateRangeConditions(
        column,
        "2026-01-01",
      );

      expect(result).toHaveLength(1);
    });

    it("should add lt condition for endDate", () => {
      const result = repository.testBuildDateRangeConditions(
        column,
        undefined,
        "2026-12-31",
      );

      expect(result).toHaveLength(1);
    });

    it("should add both conditions when both dates provided", () => {
      const result = repository.testBuildDateRangeConditions(
        column,
        "2026-01-01",
        "2026-12-31",
      );

      expect(result).toHaveLength(2);
    });

    it("should throw for invalid startDate", () => {
      expect(() =>
        repository.testBuildDateRangeConditions(column, "not-a-date"),
      ).toThrow("Invalid startDate: not-a-date");
    });

    it("should throw for invalid endDate", () => {
      expect(() =>
        repository.testBuildDateRangeConditions(
          column,
          undefined,
          "invalid-date",
        ),
      ).toThrow("Invalid endDate: invalid-date");
    });
  });

  describe("buildCursorCondition", () => {
    const column = customers.id as PgColumn;

    it("should return undefined for undefined cursor", () => {
      const result = repository.testBuildCursorCondition(column, undefined);

      expect(result).toBeUndefined();
    });

    it("should return SQL for string cursor", () => {
      const result = repository.testBuildCursorCondition(column, "some-id");

      expect(result).toBeDefined();
    });
  });

  describe("buildTimestampCursorCondition", () => {
    const column = customers.createdAt as PgColumn;

    it("should return undefined for undefined cursor", () => {
      const result = repository.testBuildTimestampCursorCondition(
        column,
        undefined,
      );

      expect(result).toBeUndefined();
    });

    it("should return SQL for Date cursor", () => {
      const result = repository.testBuildTimestampCursorCondition(
        column,
        new Date("2026-01-01"),
      );

      expect(result).toBeDefined();
    });
  });
});
