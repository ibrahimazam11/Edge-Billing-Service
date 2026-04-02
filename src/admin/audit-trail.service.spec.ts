import { Test, TestingModule } from "@nestjs/testing";
import { AuditTrailService } from "./audit-trail.service";
import { AuditTrailRepository } from "./audit-trail.repository";

describe("AuditTrailService", () => {
  let service: AuditTrailService;

  const mockAuditTrailRepo = {
    create: jest.fn().mockResolvedValue({
      id: "00000000-0000-7000-8000-000000000001",
      adminUserId: "admin-user-123",
      action: "POST /v1/admin/refunds",
      entityType: "refunds",
      entityId: "refund-uuid-456",
      details: null,
      createdAt: new Date("2026-01-20T15:00:00.000Z"),
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAuditTrailRepo.create.mockResolvedValue({
      id: "00000000-0000-7000-8000-000000000001",
      adminUserId: "admin-user-123",
      action: "POST /v1/admin/refunds",
      entityType: "refunds",
      entityId: "refund-uuid-456",
      details: null,
      createdAt: new Date("2026-01-20T15:00:00.000Z"),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditTrailService,
        { provide: AuditTrailRepository, useValue: mockAuditTrailRepo },
      ],
    }).compile();

    service = module.get<AuditTrailService>(AuditTrailService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should insert an audit record with all fields", async () => {
    const params = {
      adminUserId: "admin-user-123",
      action: "POST /v1/admin/refunds",
      entityType: "refunds",
      entityId: "refund-uuid-456",
      details: { amount: 1000, reason: "customer request" },
    };

    await service.createAuditRecord(params);

    expect(mockAuditTrailRepo.create).toHaveBeenCalledWith({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ) as string,
      adminUserId: "admin-user-123",
      action: "POST /v1/admin/refunds",
      entityType: "refunds",
      entityId: "refund-uuid-456",
      details: { amount: 1000, reason: "customer request" },
    });
  });

  it("should generate a UUIDv7 for the id field", async () => {
    await service.createAuditRecord({
      adminUserId: "admin-1",
      action: "DELETE /v1/admin/users/123",
      entityType: "users",
      entityId: "123",
    });

    const callArgs = mockAuditTrailRepo.create.mock.calls[0]?.[0] as {
      id: string;
    };
    // UUIDv7: version nibble is '7'
    expect(callArgs.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("should set details to null when not provided", async () => {
    await service.createAuditRecord({
      adminUserId: "admin-1",
      action: "PUT /v1/admin/settings",
      entityType: "settings",
      entityId: "setting-1",
    });

    const callArgs = mockAuditTrailRepo.create.mock.calls[0]?.[0] as {
      details: unknown;
    };
    expect(callArgs.details).toBeNull();
  });

  it("should propagate database errors", async () => {
    const dbError = new Error("Connection refused");
    mockAuditTrailRepo.create.mockRejectedValueOnce(dbError);

    await expect(
      service.createAuditRecord({
        adminUserId: "admin-1",
        action: "POST /v1/admin/test",
        entityType: "test",
        entityId: "test-1",
      }),
    ).rejects.toThrow("Connection refused");
  });
});
