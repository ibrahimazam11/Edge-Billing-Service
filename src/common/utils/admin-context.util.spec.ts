import { getAdminContext } from "./admin-context.util";
import type { AdminContext } from "./admin-context.util";

describe("getAdminContext", () => {
  it("should extract adminRole and adminUserId from request object", () => {
    const request = { adminRole: "admin", adminUserId: "user-1" };

    const result: AdminContext = getAdminContext(request);

    expect(result).toEqual({
      adminRole: "admin",
      adminUserId: "user-1",
    });
  });

  it("should handle super_admin role", () => {
    const request = { adminRole: "super_admin", adminUserId: "user-2" };

    const result = getAdminContext(request);

    expect(result.adminRole).toBe("super_admin");
    expect(result.adminUserId).toBe("user-2");
  });

  it("should return 'unknown' when adminRole is missing", () => {
    const request = { adminUserId: "user-1" };

    const result = getAdminContext(request);

    expect(result.adminRole).toBe("unknown");
    expect(result.adminUserId).toBe("user-1");
  });

  it("should return 'unknown' when adminUserId is missing", () => {
    const request = { adminRole: "admin" };

    const result = getAdminContext(request);

    expect(result.adminRole).toBe("admin");
    expect(result.adminUserId).toBe("unknown");
  });

  it("should return 'unknown' for both when request has no admin properties", () => {
    const request = {};

    const result = getAdminContext(request);

    expect(result).toEqual({
      adminRole: "unknown",
      adminUserId: "unknown",
    });
  });

  it("should return 'unknown' when adminRole is not a string", () => {
    const request = { adminRole: 123, adminUserId: "user-1" };

    const result = getAdminContext(request);

    expect(result.adminRole).toBe("unknown");
  });

  it("should return 'unknown' when adminUserId is not a string", () => {
    const request = { adminRole: "admin", adminUserId: null };

    const result = getAdminContext(request);

    expect(result.adminUserId).toBe("unknown");
  });

  it("should handle Express Request-like objects with extra properties", () => {
    const request = {
      method: "GET",
      path: "/v1/admin/info",
      adminRole: "admin",
      adminUserId: "user-3",
      headers: {},
    };

    const result = getAdminContext(request);

    expect(result).toEqual({
      adminRole: "admin",
      adminUserId: "user-3",
    });
  });
});
