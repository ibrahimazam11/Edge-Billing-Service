import { SetMetadata } from "@nestjs/common";
import type { AdminRole } from "../enums/admin-role.enum";

export const ROLES_KEY = "roles";
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);
