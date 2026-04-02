import { Test } from "@nestjs/testing";
import { ProcessedEventsRepository } from "./processed-events.repository";
import { DRIZZLE_PROVIDER } from "../../database/database.provider";

const mockProcessedEventRow = {
  eventId: "evt_001",
  eventType: "customer.created",
  processedAt: new Date("2026-01-15T12:00:00Z"),
};

describe("ProcessedEventsRepository", () => {
  let repository: ProcessedEventsRepository;
  let mockDb: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        ProcessedEventsRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<ProcessedEventsRepository>(
      ProcessedEventsRepository,
    );
  });

  describe("composite PK guards", () => {
    it("findById should throw — composite PK table", async () => {
      await expect(repository.findById("any-id")).rejects.toThrow(
        "findById() is not supported",
      );
    });

    it("update should throw — composite PK table", async () => {
      await expect(repository.update("any-id", {} as never)).rejects.toThrow(
        "update() is not supported",
      );
    });

    it("deleteById should throw — composite PK table", async () => {
      await expect(repository.deleteById("any-id")).rejects.toThrow(
        "deleteById() is not supported",
      );
    });
  });

  describe("findByEventIdAndType", () => {
    it("should return the row when a matching event exists", async () => {
      mockDb.where.mockResolvedValueOnce([mockProcessedEventRow]);

      const result = await repository.findByEventIdAndType(
        "evt_001",
        "customer.created",
      );

      expect(result).toEqual(mockProcessedEventRow);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
    });

    it("should return null when no matching event exists", async () => {
      mockDb.where.mockResolvedValueOnce([]);

      const result = await repository.findByEventIdAndType(
        "evt_999",
        "payment.failed",
      );

      expect(result).toBeNull();
    });
  });

  describe("markProcessed", () => {
    it("should insert a new processed event record", async () => {
      await repository.markProcessed("evt_002", "payment.succeeded");

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith({
        eventId: "evt_002",
        eventType: "payment.succeeded",
      });
    });

    it("should handle duplicate key error gracefully (no throw)", async () => {
      const duplicateError = new Error(
        "duplicate key value violates unique constraint",
      ) as Error & { code: string };
      duplicateError.code = "23505";
      mockDb.values.mockRejectedValueOnce(duplicateError);

      await expect(
        repository.markProcessed("evt_003", "customer.created"),
      ).resolves.toBeUndefined();
    });

    it("should handle drizzle-orm wrapped duplicate error gracefully (error.cause.code)", async () => {
      const pgError = new Error(
        "duplicate key value violates unique constraint",
      ) as Error & { code: string };
      pgError.code = "23505";
      const wrappedError = new Error("Failed query: INSERT INTO ...", {
        cause: pgError,
      });
      mockDb.values.mockRejectedValueOnce(wrappedError);

      await expect(
        repository.markProcessed("evt_004", "customer.created"),
      ).resolves.toBeUndefined();
    });

    it("should re-throw non-duplicate errors", async () => {
      const otherError = new Error("connection refused") as Error & {
        code: string;
      };
      otherError.code = "ECONNREFUSED";
      mockDb.values.mockRejectedValueOnce(otherError);

      await expect(
        repository.markProcessed("evt_005", "customer.created"),
      ).rejects.toThrow("connection refused");
    });

    it("should re-throw drizzle-orm wrapped non-duplicate errors", async () => {
      const pgError = new Error("connection lost") as Error & {
        code: string;
      };
      pgError.code = "08006";
      const wrappedError = new Error("Failed query: INSERT INTO ...", {
        cause: pgError,
      });
      mockDb.values.mockRejectedValueOnce(wrappedError);

      await expect(
        repository.markProcessed("evt_006", "customer.created"),
      ).rejects.toThrow("Failed query: INSERT INTO ...");
    });
  });
});
