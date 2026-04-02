import { AuditTrailInterceptor } from "./audit-trail.interceptor";
import { AuditTrailService } from "./audit-trail.service";
import { ExecutionContext, CallHandler, Logger } from "@nestjs/common";
import { of, throwError } from "rxjs";
import { lastValueFrom } from "rxjs";

describe("AuditTrailInterceptor", () => {
  let interceptor: AuditTrailInterceptor;
  let mockAuditService: { createAuditRecord: jest.Mock };

  beforeEach(() => {
    mockAuditService = {
      createAuditRecord: jest.fn().mockResolvedValue(undefined),
    };
    interceptor = new AuditTrailInterceptor(
      mockAuditService as unknown as AuditTrailService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createMockContext(overrides: {
    method: string;
    path: string;
    params?: Record<string, string>;
    body?: unknown;
    adminUserId?: string;
  }): ExecutionContext {
    const mockRequest = {
      method: overrides.method,
      path: overrides.path,
      params: overrides.params ?? {},
      body: overrides.body ?? {},
      adminUserId: overrides.adminUserId,
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
    } as unknown as ExecutionContext;
  }

  function createMockNext(responseBody: unknown = {}): CallHandler {
    return { handle: () => of(responseBody) } as CallHandler;
  }

  function createErrorNext(error: Error): CallHandler {
    return { handle: () => throwError(() => error) } as CallHandler;
  }

  // ── AC2: Non-admin routes completely unaffected ──

  it("should pass through non-admin routes without auditing", async () => {
    const context = createMockContext({
      method: "GET",
      path: "/v1/customers",
    });
    const next = createMockNext();

    await lastValueFrom(interceptor.intercept(context, next));

    expect(mockAuditService.createAuditRecord).not.toHaveBeenCalled();
  });

  it("should pass through non-admin POST routes without auditing", async () => {
    const context = createMockContext({
      method: "POST",
      path: "/v1/customers",
      body: { name: "test" },
    });
    const next = createMockNext();

    await lastValueFrom(interceptor.intercept(context, next));

    expect(mockAuditService.createAuditRecord).not.toHaveBeenCalled();
  });

  // ── AC4: Read operations not audited ──

  it("should not audit admin GET requests", async () => {
    const context = createMockContext({
      method: "GET",
      path: "/v1/admin/info",
      adminUserId: "admin-1",
    });
    const next = createMockNext();

    await lastValueFrom(interceptor.intercept(context, next));

    expect(mockAuditService.createAuditRecord).not.toHaveBeenCalled();
  });

  // ── AC3: Successful write operations audited ──

  it("should audit admin POST requests", async () => {
    const context = createMockContext({
      method: "POST",
      path: "/v1/admin/refunds",
      body: { amount: 1000 },
      adminUserId: "admin-user-123",
    });
    const next = createMockNext({ id: "refund-uuid", status: "created" });

    await lastValueFrom(interceptor.intercept(context, next));

    // Allow fire-and-forget to resolve
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockAuditService.createAuditRecord).toHaveBeenCalledWith({
      adminUserId: "admin-user-123",
      action: "POST /v1/admin/refunds",
      entityType: "refunds",
      entityId: "refund-uuid",
      details: { amount: 1000 },
    });
  });

  it("should audit admin PUT requests", async () => {
    const context = createMockContext({
      method: "PUT",
      path: "/v1/admin/settings/setting-1",
      params: { id: "setting-1" },
      body: { value: "updated" },
      adminUserId: "admin-2",
    });
    const next = createMockNext();

    await lastValueFrom(interceptor.intercept(context, next));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockAuditService.createAuditRecord).toHaveBeenCalledWith({
      adminUserId: "admin-2",
      action: "PUT /v1/admin/settings/setting-1",
      entityType: "settings",
      entityId: "setting-1",
      details: { value: "updated" },
    });
  });

  it("should audit admin PATCH requests", async () => {
    const context = createMockContext({
      method: "PATCH",
      path: "/v1/admin/users/user-1",
      params: { id: "user-1" },
      body: { status: "disabled" },
      adminUserId: "admin-3",
    });
    const next = createMockNext();

    await lastValueFrom(interceptor.intercept(context, next));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockAuditService.createAuditRecord).toHaveBeenCalledWith({
      adminUserId: "admin-3",
      action: "PATCH /v1/admin/users/user-1",
      entityType: "users",
      entityId: "user-1",
      details: { status: "disabled" },
    });
  });

  it("should audit admin DELETE requests", async () => {
    const context = createMockContext({
      method: "DELETE",
      path: "/v1/admin/resources/res-1",
      params: { id: "res-1" },
      adminUserId: "admin-4",
    });
    const next = createMockNext();

    await lastValueFrom(interceptor.intercept(context, next));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockAuditService.createAuditRecord).toHaveBeenCalledWith({
      adminUserId: "admin-4",
      action: "DELETE /v1/admin/resources/res-1",
      entityType: "resources",
      entityId: "res-1",
      details: {},
    });
  });

  // ── AC5: Failed operations not audited ──

  it("should not audit when handler throws error", async () => {
    const context = createMockContext({
      method: "POST",
      path: "/v1/admin/refunds",
      body: { amount: -1 },
      adminUserId: "admin-5",
    });
    const next = createErrorNext(new Error("Bad Request"));

    await expect(
      lastValueFrom(interceptor.intercept(context, next)),
    ).rejects.toThrow("Bad Request");

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockAuditService.createAuditRecord).not.toHaveBeenCalled();
  });

  // ── AC6: Secondary concern resilience ──

  it("should log warning and not propagate when audit creation fails", async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});

    mockAuditService.createAuditRecord.mockRejectedValueOnce(
      new Error("DB connection lost"),
    );

    const context = createMockContext({
      method: "POST",
      path: "/v1/admin/refunds",
      body: { amount: 500 },
      adminUserId: "admin-6",
    });
    const next = createMockNext({ id: "refund-1" });

    const result = await lastValueFrom(interceptor.intercept(context, next));

    // Primary response returned normally
    expect(result).toEqual({ id: "refund-1" });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to create audit trail record",
      expect.objectContaining({
        error: "DB connection lost",
        method: "POST",
        path: "/v1/admin/refunds",
      }),
    );
  });

  it("should handle non-Error thrown objects in audit creation", async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});

    mockAuditService.createAuditRecord.mockRejectedValueOnce("string error");

    const context = createMockContext({
      method: "POST",
      path: "/v1/admin/test",
      adminUserId: "admin-7",
    });
    const next = createMockNext({ id: "test-1" });

    await lastValueFrom(interceptor.intercept(context, next));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to create audit trail record",
      expect.objectContaining({
        error: "string error",
      }),
    );
  });

  // ── AC7: Entity extraction logic ──

  it("should extract entityId from route params", async () => {
    const context = createMockContext({
      method: "PUT",
      path: "/v1/admin/refunds/refund-uuid-1",
      params: { id: "refund-uuid-1" },
      adminUserId: "admin-8",
    });
    const next = createMockNext();

    await lastValueFrom(interceptor.intercept(context, next));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockAuditService.createAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "refunds",
        entityId: "refund-uuid-1",
      }),
    );
  });

  it("should extract entityId from response body id field for POST/create", async () => {
    const context = createMockContext({
      method: "POST",
      path: "/v1/admin/refunds",
      body: { amount: 500 },
      adminUserId: "admin-9",
    });
    const next = createMockNext({ id: "new-refund-id", status: "created" });

    await lastValueFrom(interceptor.intercept(context, next));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockAuditService.createAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "refunds",
        entityId: "new-refund-id",
      }),
    );
  });

  it("should default entityId to 'unknown' when not available", async () => {
    const context = createMockContext({
      method: "POST",
      path: "/v1/admin/bulk-operations",
      body: { count: 10 },
      adminUserId: "admin-10",
    });
    const next = createMockNext({ success: true });

    await lastValueFrom(interceptor.intercept(context, next));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockAuditService.createAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "bulk-operations",
        entityId: "unknown",
      }),
    );
  });

  it("should extract entityType from path segments", async () => {
    const context = createMockContext({
      method: "PATCH",
      path: "/v1/admin/subscriptions/sub-1",
      params: { id: "sub-1" },
      adminUserId: "admin-11",
    });
    const next = createMockNext();

    await lastValueFrom(interceptor.intercept(context, next));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockAuditService.createAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "subscriptions",
      }),
    );
  });

  // ── AC3: adminUserId extraction ──

  it("should extract adminUserId from request", async () => {
    const context = createMockContext({
      method: "POST",
      path: "/v1/admin/echo",
      adminUserId: "specific-admin-user",
    });
    const next = createMockNext({ id: "echo-1" });

    await lastValueFrom(interceptor.intercept(context, next));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockAuditService.createAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: "specific-admin-user",
      }),
    );
  });

  it("should default adminUserId to 'unknown' when missing", async () => {
    const context = createMockContext({
      method: "POST",
      path: "/v1/admin/echo",
    });
    const next = createMockNext({ id: "echo-2" });

    await lastValueFrom(interceptor.intercept(context, next));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockAuditService.createAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: "unknown",
      }),
    );
  });

  // ── AC6: Double-fault resilience (Logger throws inside catch) ──

  it("should handle logger failure during audit error handling gracefully", async () => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {
      throw new Error("Logger transport failed");
    });

    mockAuditService.createAuditRecord.mockRejectedValueOnce(
      new Error("DB error"),
    );

    const context = createMockContext({
      method: "POST",
      path: "/v1/admin/echo",
      adminUserId: "admin-h1",
    });
    const next = createMockNext({ id: "echo-1" });

    // Response should still be returned despite double-fault
    const result = await lastValueFrom(interceptor.intercept(context, next));
    expect(result).toEqual({ id: "echo-1" });

    // Allow fire-and-forget to resolve (outer .catch() swallows the double-fault)
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  // ── Route params take priority over response body ──

  it("should prefer route params id over response body id", async () => {
    const context = createMockContext({
      method: "PUT",
      path: "/v1/admin/items/param-id",
      params: { id: "param-id" },
      adminUserId: "admin-12",
    });
    const next = createMockNext({ id: "response-id" });

    await lastValueFrom(interceptor.intercept(context, next));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockAuditService.createAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "param-id",
      }),
    );
  });
});
