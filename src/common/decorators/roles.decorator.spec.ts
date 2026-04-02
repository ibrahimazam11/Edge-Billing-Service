import { AdminRole } from "../enums/admin-role.enum";
import { ROLES_KEY, Roles } from "./roles.decorator";

describe("Roles decorator", () => {
  it("should set ROLES_KEY metadata with a single role", () => {
    @Roles(AdminRole.Admin)
    class TestController {}

    const metadata = Reflect.getMetadata(ROLES_KEY, TestController);
    expect(metadata).toEqual([AdminRole.Admin]);
  });

  it("should set ROLES_KEY metadata with multiple roles", () => {
    @Roles(AdminRole.Cs, AdminRole.Finance, AdminRole.Admin)
    class TestController {}

    const metadata = Reflect.getMetadata(ROLES_KEY, TestController);
    expect(metadata).toEqual([
      AdminRole.Cs,
      AdminRole.Finance,
      AdminRole.Admin,
    ]);
  });

  it("should set ROLES_KEY metadata with empty roles array", () => {
    @Roles()
    class TestController {}

    const metadata = Reflect.getMetadata(ROLES_KEY, TestController);
    expect(metadata).toEqual([]);
  });
});
