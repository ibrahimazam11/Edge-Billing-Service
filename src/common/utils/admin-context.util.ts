export interface AdminContext {
  adminRole: string;
  adminUserId: string;
}

export function getAdminContext(request: unknown): AdminContext {
  const req = request as Record<string, unknown>;
  return {
    adminRole: typeof req.adminRole === "string" ? req.adminRole : "unknown",
    adminUserId:
      typeof req.adminUserId === "string" ? req.adminUserId : "unknown",
  };
}
