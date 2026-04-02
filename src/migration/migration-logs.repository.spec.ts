import { Test } from "@nestjs/testing";
import { MigrationLogsRepository } from "./migration-logs.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

describe("MigrationLogsRepository", () => {
  let repository: MigrationLogsRepository;
  let selectChain: Record<string, jest.Mock>;
  let insertChain: Record<string, jest.Mock>;
  let mockDb: Record<string, jest.Mock>;

  beforeEach(async () => {
    selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      then: jest.fn((resolve: (value: unknown[]) => void) => resolve([])),
    };

    insertChain = {
      values: jest.fn().mockResolvedValue(undefined),
    };

    mockDb = {
      select: jest.fn(() => selectChain),
      insert: jest.fn(() => insertChain),
      execute: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        MigrationLogsRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<MigrationLogsRepository>(MigrationLogsRepository);
  });

  describe("createLog", () => {
    it("should insert a migration log record", async () => {
      const logData = {
        id: "log-001",
        runId: "run-001",
        scriptName: "migrate-payment-settings",
        monolithCustomerId: "MONO-001",
        billingCustomerId: "cust-001",
        status: "succeeded",
        errorMessage: null,
        details: { paymentMethodCount: 2 },
        createdAt: new Date("2026-02-10"),
      };

      await repository.createLog(logData);

      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      expect(insertChain.values).toHaveBeenCalledWith(logData);
    });

    it("should insert a failed migration log with error message", async () => {
      const logData = {
        id: "log-002",
        runId: "run-002",
        scriptName: "migrate-customer-charges",
        monolithCustomerId: "MONO-002",
        billingCustomerId: null,
        status: "failed",
        errorMessage: "Connection timeout",
        details: { chargeId: 42, action: "migration.charges" },
        createdAt: new Date("2026-02-10"),
      };

      await repository.createLog(logData);

      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      expect(insertChain.values).toHaveBeenCalledWith(logData);
    });
  });

  describe("getStatusSummary", () => {
    it("should return status summary from raw SQL query", async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ total: 100, succeeded: 85, failed: 15 }],
      });

      const result = await repository.getStatusSummary();

      expect(result).toEqual({ total: 100, succeeded: 85, failed: 15 });
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("should return zeroes when no rows returned", async () => {
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

      const result = await repository.getStatusSummary();

      expect(result).toEqual({ total: 0, succeeded: 0, failed: 0 });
    });
  });

  describe("countByRunId", () => {
    it("should return count of logs for a given run ID", async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ count: 42 }],
      });

      const result = await repository.countByRunId("run-001");

      expect(result).toBe(42);
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("should return 0 when no rows returned", async () => {
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

      const result = await repository.countByRunId("run-unknown");

      expect(result).toBe(0);
    });
  });

  describe("getResultsByRunId", () => {
    it("should return migration logs for a given run ID", async () => {
      const mockLogs = [
        {
          id: "log-001",
          runId: "run-001",
          scriptName: "migrate-payment-settings",
          monolithCustomerId: "MONO-001",
          billingCustomerId: "cust-001",
          status: "succeeded",
          errorMessage: null,
          details: null,
          createdAt: new Date("2026-02-10"),
        },
        {
          id: "log-002",
          runId: "run-001",
          scriptName: "migrate-payment-settings",
          monolithCustomerId: "MONO-002",
          billingCustomerId: null,
          status: "failed",
          errorMessage: "Stripe error",
          details: null,
          createdAt: new Date("2026-02-10"),
        },
      ];

      selectChain.where.mockResolvedValueOnce(mockLogs);

      const result = await repository.getResultsByRunId("run-001");

      expect(result).toEqual(mockLogs);
      expect(result).toHaveLength(2);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(selectChain.from).toHaveBeenCalledTimes(1);
      expect(selectChain.where).toHaveBeenCalledTimes(1);
    });

    it("should return empty array when no logs found", async () => {
      selectChain.where.mockResolvedValueOnce([]);

      const result = await repository.getResultsByRunId("run-nonexistent");

      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });
  });

  describe("findLatestByMonolithCustomerId", () => {
    it("should return the latest migration log for a monolith customer", async () => {
      const mockLog = {
        id: "log-001",
        runId: "run-001",
        scriptName: "payment_settings_migration",
        monolithCustomerId: "MONO-001",
        billingCustomerId: "cust-001",
        status: "succeeded",
        errorMessage: null,
        details: null,
        createdAt: new Date("2026-02-10"),
      };

      selectChain.limit.mockResolvedValueOnce([mockLog]);

      const result =
        await repository.findLatestByMonolithCustomerId("MONO-001");

      expect(result).toEqual(mockLog);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(selectChain.from).toHaveBeenCalledTimes(1);
      expect(selectChain.where).toHaveBeenCalledTimes(1);
      expect(selectChain.orderBy).toHaveBeenCalledTimes(1);
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });

    it("should return null when no logs found for monolith customer", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result =
        await repository.findLatestByMonolithCustomerId("MONO-UNKNOWN");

      expect(result).toBeNull();
    });
  });

  describe("getAggregateMigrationStats", () => {
    it("should return aggregate migration stats from raw SQL", async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ migrated: 50, failed: 5 }],
      });

      const result = await repository.getAggregateMigrationStats();

      expect(result).toEqual({ migrated: 50, failed: 5 });
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("should return zeroes when no rows returned", async () => {
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

      const result = await repository.getAggregateMigrationStats();

      expect(result).toEqual({ migrated: 0, failed: 0 });
    });

    it("should handle all-failed scenario", async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ migrated: 0, failed: 10 }],
      });

      const result = await repository.getAggregateMigrationStats();

      expect(result).toEqual({ migrated: 0, failed: 10 });
    });
  });
});
