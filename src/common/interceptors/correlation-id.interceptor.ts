import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { v7 as uuidv7 } from "uuid";
import { Request, Response } from "express";
import * as Sentry from "@sentry/nestjs";

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

    // Tag the current Sentry scope so any event captured during this request
    // (by SentryGlobalFilter, our GlobalExceptionFilter, or anything in
    // between) carries the correlation id without each capture site repeating
    // the tag.
    Sentry.getCurrentScope().setTag("correlation_id", correlationId);

    return next.handle();
  }
}
