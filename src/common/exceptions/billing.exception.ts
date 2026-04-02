import { HttpException, HttpStatus } from "@nestjs/common";

export class BillingException extends HttpException {
  constructor(
    message: string,
    statusCode: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
    public readonly details?: Record<string, unknown>,
  ) {
    super(
      {
        statusCode,
        error: HttpStatus[statusCode],
        message,
        details: details || null,
      },
      statusCode,
    );
  }
}

export class BusinessRuleViolationException extends BillingException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
}

export class StateTransitionException extends BillingException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, HttpStatus.CONFLICT, details);
  }
}
