import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { v7 as uuidv7 } from "uuid";
import { Request, Response } from "express";

const CORRELATION_ID_HEADER = "x-correlation-id";

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const correlationId =
      (request.headers[CORRELATION_ID_HEADER] as string) || uuidv7();

    request.headers[CORRELATION_ID_HEADER] = correlationId;
    response.setHeader(CORRELATION_ID_HEADER, correlationId);

    // Sentry scope tagging is handled at each capture site (e.g.
    // GlobalExceptionFilter passes `correlation_id` explicitly via tags).
    // Do NOT call Sentry.getCurrentScope().setTag here — without an explicit
    // per-request scope fork it would leak across concurrent requests.

    return next.handle();
  }
}
