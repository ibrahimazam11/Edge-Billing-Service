import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { createHmac, createHash, timingSafeEqual } from "crypto";
import type { Request } from "express";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";

@Injectable()
export class HmacAuthGuard implements CanActivate {
  private readonly logger = new Logger(HmacAuthGuard.name);
  private readonly TIMESTAMP_WINDOW_MS = 300_000; // 5 minutes

  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    // NOTE: request.path excludes query strings. Client must sign using path only (no query params).
    const { method, path } = request;
    const correlationId = request.headers["x-correlation-id"] as
      | string
      | undefined;

    const apiKey = request.headers["x-api-key"] as string | undefined;
    const signature = request.headers["x-signature"] as string | undefined;
    const timestamp = request.headers["x-timestamp"] as string | undefined;

    if (!apiKey || !signature || !timestamp) {
      this.logger.warn("HMAC auth failed: missing required headers", {
        path,
        method,
        correlationId,
      });
      throw new UnauthorizedException("Unauthorized");
    }

    const configuredApiKey = this.configService.get<string>("auth.apiKey")!;
    if (!this.timingSafeCompare(apiKey, configuredApiKey)) {
      this.logger.warn("HMAC auth failed: invalid API key", {
        path,
        method,
        correlationId,
      });
      throw new UnauthorizedException("Unauthorized");
    }

    const now = Date.now();
    const requestTimestamp = parseInt(timestamp, 10);
    if (
      isNaN(requestTimestamp) ||
      Math.abs(now - requestTimestamp) > this.TIMESTAMP_WINDOW_MS
    ) {
      this.logger.warn("HMAC auth failed: timestamp outside valid window", {
        path,
        method,
        correlationId,
      });
      throw new UnauthorizedException("Unauthorized");
    }

    const hmacSecret = this.configService.get<string>("auth.hmacSecret");
    // Body contract: truthy request.body is JSON-stringified; falsy (undefined/null) hashes "".
    // Client must match: POST with parsed body → hash JSON.stringify(body), GET/DELETE → hash "".
    const body = request.body
      ? JSON.stringify(request.body as Record<string, unknown>)
      : "";
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const signaturePayload = method + path + timestamp + bodyHash;
    const computedSignature = createHmac("sha256", hmacSecret!)
      .update(signaturePayload)
      .digest("hex");

    try {
      const sigBuffer = Buffer.from(signature, "hex");
      const computedBuffer = Buffer.from(computedSignature, "hex");

      if (
        sigBuffer.length !== computedBuffer.length ||
        !timingSafeEqual(sigBuffer, computedBuffer)
      ) {
        this.logger.warn("HMAC auth failed: invalid signature", {
          path,
          method,
          correlationId,
        });
        throw new UnauthorizedException("Unauthorized");
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.warn("HMAC auth failed: signature comparison error", {
        path,
        method,
        correlationId,
      });
      throw new UnauthorizedException("Unauthorized");
    }

    // Extract admin context headers (informational — not part of HMAC signature)
    const adminRole = request.headers["x-admin-role"] as string | undefined;
    const adminUserId = request.headers["x-admin-user-id"] as
      | string
      | undefined;
    if (adminRole) {
      (request as unknown as Record<string, unknown>).adminRole = adminRole;
    }
    if (adminUserId) {
      (request as unknown as Record<string, unknown>).adminUserId = adminUserId;
    }

    return true;
  }

  private timingSafeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      // Compare against self to consume constant time, then return false
      timingSafeEqual(bufA, bufA);
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }
}
