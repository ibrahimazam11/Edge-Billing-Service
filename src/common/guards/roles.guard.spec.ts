import { RolesGuard } from "./roles.guard";
import { ExecutionContext, ForbiddenException, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AdminRole } from "../enums/admin-role.enum";

describe("RolesGuard", () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  function createMockContext(overrides?: {
    adminRole?: string;
    adminUserId?: string;
  }): ExecutionContext {
    const request: Record<string, unknown> = {};
    if (overrides?.adminRole !== undefined) {
      request.adminRole = overrides.adminRole;
    }
    if (overrides?.adminUserId !== undefined) {
      request.adminUserId = overrides.adminUserId;
    }

    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    } as unknown as Reflector;

    guard = new RolesGuard(reflector);
    loggerWarnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  // AC6: No @Roles() metadata, no role header → allow
  it("should allow request when no @Roles() metadata is set and no role header", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);
    const context = createMockContext();
    expect(guard.canActivate(context)).toBe(true);
  });

  // AC6: No @Roles() metadata, role header present → allow
  it("should allow request when no @Roles() metadata is set even with role header", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);
    const context = createMockContext({ adminRole: "admin" });
    expect(guard.canActivate(context)).toBe(true);
  });

  // AC3: @Roles('admin'), role = admin → allow
  it("should allow request when role matches @Roles() metadata", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
      AdminRole.Admin,
    ]);
    const context = createMockContext({ adminRole: "admin" });
    expect(guard.canActivate(context)).toBe(true);
  });

  // AC4: @Roles('admin'), role = cs → 403
  it("should deny request when role does not match @Roles() metadata", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
      AdminRole.Admin,
    ]);
    const context = createMockContext({ adminRole: "cs" });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  // AC5: @Roles('cs', 'finance', 'admin'), role = finance → allow
  it("should allow request when role is one of multiple allowed roles", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
      AdminRole.Cs,
      AdminRole.Finance,
      AdminRole.Admin,
    ]);
    const context = createMockContext({ adminRole: "finance" });
    expect(guard.canActivate(context)).toBe(true);
  });

  // AC7: @Roles('admin'), no role header → 403
  it("should deny request when @Roles() is set but no role header is present", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
      AdminRole.Admin,
    ]);
    const context = createMockContext();
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  // AC8: @Roles('admin'), role = superuser → 403
  it("should deny request with invalid role value not in enum", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
      AdminRole.Admin,
    ]);
    const context = createMockContext({ adminRole: "superuser" });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  // AC10: Unexpected error → log warn + 403 (fail-closed)
  it("should deny and log warn when reflector throws unexpected error", () => {
    (reflector.getAllAndOverride as jest.Mock).mockImplementation(() => {
      throw new Error("Unexpected reflector error");
    });
    const context = createMockContext({ adminRole: "admin" });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      "RolesGuard encountered unexpected error",
      { error: "Unexpected reflector error" },
    );
  });

  // Edge case: @Roles() with empty array acts as deny-all
  it("should deny all requests when @Roles() is applied with no arguments (empty array)", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([]);
    const context = createMockContext({ adminRole: "admin" });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
