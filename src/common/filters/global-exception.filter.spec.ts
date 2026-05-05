import { GlobalExceptionFilter } from "./global-exception.filter";
import {
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { BillingException } from "../exceptions/billing.exception";
import * as Sentry from "@sentry/nestjs";

jest.mock("@sentry/nestjs", () => ({
  captureException: jest.fn(),
}));

describe("GlobalExceptionFilter", () => {
  let filter: GlobalExceptionFilter;
  let mockResponse: { status: jest.Mock; json: jest.Mock };
  let mockRequest: {
    headers: Record<string, string>;
    method?: string;
    url?: string;
    route?: { path: string };
  };
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    (Sentry.captureException as jest.Mock).mockClear();
    filter = new GlobalExceptionFilter();
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockRequest = { headers: {}, method: "GET", url: "/v1/charges" };
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should return standardized error format for HttpException", () => {
    const exception = new HttpException("Not found", HttpStatus.NOT_FOUND);

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(404);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: "Not found",
      }),
    );
  });

  it("should return standardized error format for BillingException", () => {
    const exception = new BillingException(
      "Payment failed",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { reason: "insufficient_funds" },
    );

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(422);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 422,
        message: "Payment failed",
        details: { reason: "insufficient_funds" },
      }),
    );
  });

  it("should handle unknown exceptions as 500", () => {
    const exception = new Error("Something unexpected");

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(500);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        error: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
      }),
    );
  });

  it("should include correlationId when present in request", () => {
    mockRequest.headers["x-correlation-id"] = "test-correlation-id";
    const exception = new HttpException("Error", HttpStatus.BAD_REQUEST);

    filter.catch(exception, mockHost);

    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "test-correlation-id",
      }),
    );
  });

  it("should capture unknown exceptions in Sentry with correlation_id and http tags", () => {
    mockRequest.headers["x-correlation-id"] = "abc-123";
    const exception = new Error("Boom");

    filter.catch(exception, mockHost);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      exception,
      expect.objectContaining({
        tags: expect.objectContaining({
          correlation_id: "abc-123",
          http_method: "GET",
          http_url: "/v1/charges",
        }),
      }),
    );
  });

  it("should capture 5xx HttpExceptions in Sentry", () => {
    const exception = new HttpException("Bad gateway", HttpStatus.BAD_GATEWAY);

    filter.catch(exception, mockHost);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("should NOT capture 4xx HttpExceptions in Sentry", () => {
    const exception = new HttpException("Bad input", HttpStatus.BAD_REQUEST);

    filter.catch(exception, mockHost);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("should NOT capture 422 BillingException as Sentry event", () => {
    const exception = new BillingException(
      "Payment failed",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { reason: "insufficient_funds" },
    );

    filter.catch(exception, mockHost);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("prefers http_route tag over http_url when express has resolved a route", () => {
    mockRequest.route = { path: "/v1/charges/:id" };
    const exception = new Error("Boom");

    filter.catch(exception, mockHost);

    expect(Sentry.captureException).toHaveBeenCalledWith(
      exception,
      expect.objectContaining({
        tags: expect.objectContaining({
          http_route: "/v1/charges/:id",
        }),
      }),
    );
    const call = (Sentry.captureException as jest.Mock).mock.calls[0] as [
      unknown,
      { tags: Record<string, unknown> },
    ];
    expect(call[1].tags).not.toHaveProperty("http_url");
  });

  it("coerces array-valued x-correlation-id header to first value", () => {
    mockRequest.headers["x-correlation-id"] = [
      "first",
      "second",
    ] as unknown as string;
    const exception = new Error("Boom");

    filter.catch(exception, mockHost);

    expect(Sentry.captureException).toHaveBeenCalledWith(
      exception,
      expect.objectContaining({
        tags: expect.objectContaining({ correlation_id: "first" }),
      }),
    );
  });

  it("never crashes the response if Sentry.captureException throws", () => {
    (Sentry.captureException as jest.Mock).mockImplementationOnce(() => {
      throw new Error("sentry transport down");
    });
    const exception = new Error("Boom");

    expect(() => filter.catch(exception, mockHost)).not.toThrow();
    expect(mockResponse.status).toHaveBeenCalledWith(500);
    expect(mockResponse.json).toHaveBeenCalled();
  });
});
