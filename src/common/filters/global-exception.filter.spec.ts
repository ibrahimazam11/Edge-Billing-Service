import { GlobalExceptionFilter } from "./global-exception.filter";
import {
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { BillingException } from "../exceptions/billing.exception";

describe("GlobalExceptionFilter", () => {
  let filter: GlobalExceptionFilter;
  let mockResponse: { status: jest.Mock; json: jest.Mock };
  let mockRequest: { headers: Record<string, string> };
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    filter = new GlobalExceptionFilter();
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockRequest = { headers: {} };
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
});
