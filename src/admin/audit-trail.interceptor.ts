import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { Request } from "express";
import { AuditTrailService } from "./audit-trail.service";
import { getAdminContext } from "../common/utils/admin-context.util";

@Injectable()
export class AuditTrailInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditTrailInterceptor.name);
  private readonly WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  private readonly ADMIN_PATH_PREFIX = "/v1/admin/";

  constructor(private readonly auditTrailService: AuditTrailService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method, path } = request;

    if (
      !path.startsWith(this.ADMIN_PATH_PREFIX) ||
      !this.WRITE_METHODS.has(method)
    ) {
      return next.handle();
    }

    const { adminUserId: resolvedAdminUserId } = getAdminContext(request);

    return next.handle().pipe(
      tap((responseBody: unknown) => {
        void this.recordAudit(request, resolvedAdminUserId, responseBody).catch(
          () => {
            // Intentionally empty — recordAudit has its own try-catch;
            // this outer catch guards against Logger failures
          },
        );
      }),
    );
  }

  private async recordAudit(
    request: Request,
    adminUserId: string,
    responseBody: unknown,
  ): Promise<void> {
    try {
      const { entityType, entityId } = this.extractEntity(
        request,
        responseBody,
      );
      await this.auditTrailService.createAuditRecord({
        adminUserId,
        action: `${request.method} ${request.path}`,
        entityType,
        entityId,
        details: request.body as unknown,
      });
    } catch (error: unknown) {
      this.logger.warn("Failed to create audit trail record", {
        error: error instanceof Error ? error.message : String(error),
        method: request.method,
        path: request.path,
      });
    }
  }

  private extractEntity(
    request: Request,
    responseBody: unknown,
  ): { entityType: string; entityId: string } {
    const segments = request.path
      .replace(this.ADMIN_PATH_PREFIX, "")
      .split("/");
    const entityType = segments[0] || "unknown";

    const params = request.params as Record<string, string>;
    const entityId =
      params["id"] ??
      (responseBody && typeof responseBody === "object" && "id" in responseBody
        ? String((responseBody as Record<string, unknown>).id)
        : "unknown");

    return { entityType, entityId };
  }
}
