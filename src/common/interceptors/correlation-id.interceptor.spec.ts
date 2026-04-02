import { CorrelationIdInterceptor } from "./correlation-id.interceptor";
import { ExecutionContext, CallHandler } from "@nestjs/common";
import { of } from "rxjs";

describe("CorrelationIdInterceptor", () => {
  let interceptor: CorrelationIdInterceptor;
  let mockRequest: { headers: Record<string, string> };
  let mockResponse: { setHeader: jest.Mock };
  let mockContext: ExecutionContext;
  let mockNext: CallHandler;

  beforeEach(() => {
    interceptor = new CorrelationIdInterceptor();
    mockRequest = { headers: {} };
    mockResponse = { setHeader: jest.fn() };
    mockContext = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => mockResponse,
      }),
    } as unknown as ExecutionContext;
    mockNext = { handle: () => of("test") } as CallHandler;
  });

  it("should generate a correlation ID when none is provided", (done) => {
    interceptor.intercept(mockContext, mockNext).subscribe(() => {
      expect(mockRequest.headers["x-correlation-id"]).toBeDefined();
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        "x-correlation-id",
        expect.any(String),
      );
      done();
    });
  });

  it("should propagate existing correlation ID from request headers", (done) => {
    const existingId = "existing-correlation-id";
    mockRequest.headers["x-correlation-id"] = existingId;

    interceptor.intercept(mockContext, mockNext).subscribe(() => {
      expect(mockRequest.headers["x-correlation-id"]).toBe(existingId);
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        "x-correlation-id",
        existingId,
      );
      done();
    });
  });

  it("should call next.handle()", (done) => {
    interceptor.intercept(mockContext, mockNext).subscribe((result) => {
      expect(result).toBe("test");
      done();
    });
  });
});
