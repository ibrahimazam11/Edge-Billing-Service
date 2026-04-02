import { IdempotencyService } from "./idempotency.service";
import type { ProcessedEventsRepository } from "./processed-events.repository";

const mockProcessedEventsRepo: jest.Mocked<
  Pick<ProcessedEventsRepository, "findByEventIdAndType" | "markProcessed">
> = {
  findByEventIdAndType: jest.fn(),
  markProcessed: jest.fn(),
};

describe("IdempotencyService", () => {
  let service: IdempotencyService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IdempotencyService(
      mockProcessedEventsRepo as unknown as ProcessedEventsRepository,
    );
  });

  describe("isProcessed", () => {
    it("should return false when the event has not been processed", async () => {
      mockProcessedEventsRepo.findByEventIdAndType.mockResolvedValueOnce(null);

      const result = await service.isProcessed("event-1", "customer.created");

      expect(result).toBe(false);
      expect(mockProcessedEventsRepo.findByEventIdAndType).toHaveBeenCalledWith(
        "event-1",
        "customer.created",
      );
    });

    it("should return true when the event has already been processed", async () => {
      mockProcessedEventsRepo.findByEventIdAndType.mockResolvedValueOnce({
        eventId: "event-1",
        eventType: "customer.created",
        processedAt: new Date("2026-01-15T12:00:00Z"),
      });

      const result = await service.isProcessed("event-1", "customer.created");

      expect(result).toBe(true);
      expect(mockProcessedEventsRepo.findByEventIdAndType).toHaveBeenCalledWith(
        "event-1",
        "customer.created",
      );
    });
  });

  describe("markProcessed", () => {
    it("should delegate to repository markProcessed with correct arguments", async () => {
      mockProcessedEventsRepo.markProcessed.mockResolvedValueOnce(undefined);

      await service.markProcessed("event-2", "payment.succeeded");

      expect(mockProcessedEventsRepo.markProcessed).toHaveBeenCalledWith(
        "event-2",
        "payment.succeeded",
      );
    });

    it("should propagate errors from the repository", async () => {
      const dbError = new Error("connection refused");
      mockProcessedEventsRepo.markProcessed.mockRejectedValueOnce(dbError);

      await expect(
        service.markProcessed("event-3", "customer.created"),
      ).rejects.toThrow("connection refused");
    });

    it("should not call findByEventIdAndType", async () => {
      mockProcessedEventsRepo.markProcessed.mockResolvedValueOnce(undefined);

      await service.markProcessed("event-4", "payment.failed");

      expect(
        mockProcessedEventsRepo.findByEventIdAndType,
      ).not.toHaveBeenCalled();
    });
  });
});
