import { Test } from "@nestjs/testing";
import { AuditTrailRepository } from "./audit-trail.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

const mockAuditTrailRow = (overrides: Record<string, unknown> = {}) => ({
  id: "at000000-0000-4000-a000-000000000001",
  adminUserId: "admin-user-1",
  action: "PUT /v1/admin/discrepancies/123/resolve",
  entityType: "reconciliation_discrepancy",
  entityId: "rd000000-0000-4000-a000-000000000001",
  details: { resolutionNotes: "Confirmed" },
  createdAt: new Date("2026-01-20T15:00:00.000Z"),
  ...overrides,
});

describe("AuditTrailRepository", () => {
  let repository: AuditTrailRepository;
  let mockDb: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([mockAuditTrailRow()]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
    };

    const module = await Test.createTestingModule({
      providers: [
        AuditTrailRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<AuditTrailRepository>(AuditTrailRepository);
  });

  describe("search", () => {
    it("should return all rows when no filters applied", async () => {
      const row = mockAuditTrailRow();
      mockDb.limit.mockResolvedValueOnce([row]);

      const result = await repository.search({}, 20);

      expect(result).toEqual([row]);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
      expect(mockDb.orderBy).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(21);
    });

    it("should filter by entityType with eq condition", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await repository.search({ entityType: "reconciliation_discrepancy" }, 20);

      expect(mockDb.where).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(21);
    });

    it("should filter by entityId and adminUserId", async () => {
      const row = mockAuditTrailRow();
      mockDb.limit.mockResolvedValueOnce([row]);

      const result = await repository.search(
        {
          entityId: "rd000000-0000-4000-a000-000000000001",
          adminUserId: "admin-user-1",
        },
        20,
      );

      expect(result).toEqual([row]);
      expect(mockDb.where).toHaveBeenCalled();
    });

    it("should filter by date range (startDate and endDate)", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await repository.search(
        {
          startDate: "2026-01-01T00:00:00.000Z",
          endDate: "2026-02-01T00:00:00.000Z",
        },
        10,
      );

      expect(mockDb.where).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(11);
    });

    it("should apply cursor pagination with lt(id, cursor)", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await repository.search(
        { cursor: "at000000-0000-4000-a000-000000000099" },
        20,
      );

      expect(mockDb.where).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(21);
    });

    it("should combine all filters together", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await repository.search(
        {
          entityType: "reconciliation_discrepancy",
          entityId: "rd000000-0000-4000-a000-000000000001",
          adminUserId: "admin-user-1",
          startDate: "2026-01-01T00:00:00.000Z",
          endDate: "2026-02-01T00:00:00.000Z",
          cursor: "at000000-0000-4000-a000-000000000099",
        },
        5,
      );

      expect(mockDb.where).toHaveBeenCalled();
      expect(mockDb.orderBy).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(6);
    });
  });
});
