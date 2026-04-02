import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "../decorators/roles.decorator";
import type { AdminRole } from "../enums/admin-role.enum";

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    try {
      const requiredRoles = this.reflector.getAllAndOverride<
        AdminRole[] | undefined
      >(ROLES_KEY, [context.getHandler(), context.getClass()]);

      // No @Roles() decorator → allow (backward compatible — AC6)
      if (!requiredRoles) {
        return true;
      }

      const request = context
        .switchToHttp()
        .getRequest<Record<string, unknown>>();
      const adminRole = request.adminRole as string | undefined;

      // Role-protected endpoint without role header → 403 (AC7)
      if (!adminRole) {
        throw new ForbiddenException("Forbidden resource");
      }

      // Role not in allowed list → 403 (AC4, AC8)
      if (!requiredRoles.includes(adminRole as AdminRole)) {
        throw new ForbiddenException("Forbidden resource");
      }

      // Role matches → allow (AC3, AC5)
      return true;
    } catch (error) {
      // Rethrow deliberate 403 denials
      if (error instanceof ForbiddenException) {
        throw error;
      }

      // Unexpected errors → log warn and deny (fail-closed — AC10)
      this.logger.warn("RolesGuard encountered unexpected error", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ForbiddenException("Forbidden resource");
    }
  }
}
