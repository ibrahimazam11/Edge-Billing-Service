import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import * as Sentry from "@sentry/nestjs";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode: number;
    let message: string;
    let error: string;
    let details: unknown = null;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === "object" && exceptionResponse !== null) {
        const resp = exceptionResponse as Record<string, unknown>;
        message = (resp.message as string) || exception.message;
        error = (resp.error as string) || HttpStatus[statusCode];
        details = resp.details || null;
      } else {
        message = exception.message;
        error = HttpStatus[statusCode];
      }
    } else {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      message = "Internal server error";
      error = "INTERNAL_SERVER_ERROR";

      this.logger.error(
        `Unhandled exception: ${exception instanceof Error ? exception.message : String(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    // Express delivers a duplicate header as string[]; coerce to a single string.
    const rawCorrelationHeader = request.headers["x-correlation-id"];
    const correlationId = Array.isArray(rawCorrelationHeader)
      ? rawCorrelationHeader[0]
      : (rawCorrelationHeader ?? "");

    // 4xx HttpExceptions are client-driven and not actionable noise for Sentry.
    // Capture only 5xx and unknown exceptions so the dashboard reflects real
    // server-side failures.
    if (typeof statusCode === "number" && statusCode >= 500) {
      const route = (request as { route?: { path?: string } }).route;
      const httpRoute =
        typeof route?.path === "string" ? route.path : undefined;
      try {
        Sentry.captureException(exception, {
          tags: {
            ...(correlationId ? { correlation_id: correlationId } : {}),
            ...(request.method ? { http_method: request.method } : {}),
            ...(httpRoute
              ? { http_route: httpRoute }
              : request.url
                ? { http_url: request.url }
                : {}),
          },
        });
      } catch (sentryError) {
        // Sentry must never block the error response.
        this.logger.warn(
          `Sentry capture failed: ${sentryError instanceof Error ? sentryError.message : String(sentryError)}`,
        );
      }
    }

    response.status(statusCode).json({
      statusCode,
      error,
      message,
      details,
      ...(correlationId && { correlationId }),
    });
  }
}
