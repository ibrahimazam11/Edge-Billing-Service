import { HmacAuthGuard } from "./hmac-auth.guard";
import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { createHmac, createHash } from "crypto";

describe("HmacAuthGuard", () => {
  let guard: HmacAuthGuard;
  let configService: ConfigService;
  let reflector: Reflector;

  const TEST_API_KEY = "test-api-key";
  const TEST_HMAC_SECRET = "test-hmac-secret";

  function computeSignature(
    method: string,
    path: string,
    timestamp: string,
    body: string,
  ): string {
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const payload = method + path + timestamp + bodyHash;
    return createHmac("sha256", TEST_HMAC_SECRET).update(payload).digest("hex");
  }

  function createMockContext(overrides: {
    headers?: Record<string, string>;
    method?: string;
    path?: string;
    body?: unknown;
    isPublic?: boolean;
  }): ExecutionContext {
    const method = overrides.method ?? "GET";
    const path = overrides.path ?? "/v1/test";
    const headers = overrides.headers ?? {};
    const body = overrides.body ?? undefined;

    return {
      switchToHttp: () => ({
        getRequest: () => ({
          method,
          path,
          headers,
          body,
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    configService = {
      get: jest.fn((key: string) => {
        if (key === "auth.apiKey") return TEST_API_KEY;
        if (key === "auth.hmacSecret") return TEST_HMAC_SECRET;
        return undefined;
      }),
    } as unknown as ConfigService;

    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;

    guard = new HmacAuthGuard(configService, reflector);
  });

  it("should allow request with valid API key, valid signature, and valid timestamp", () => {
    const timestamp = Date.now().toString();
    const method = "GET";
    const path = "/v1/test";
    const signature = computeSignature(method, path, timestamp, "");

    const context = createMockContext({
      headers: {
        "x-api-key": TEST_API_KEY,
        "x-signature": signature,
        "x-timestamp": timestamp,
      },
      method,
      path,
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("should reject request with missing x-api-key header", () => {
    const timestamp = Date.now().toString();
    const context = createMockContext({
      headers: {
        "x-signature": "some-signature",
        "x-timestamp": timestamp,
      },
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("should reject request with missing x-signature header", () => {
    const timestamp = Date.now().toString();
    const context = createMockContext({
      headers: {
        "x-api-key": TEST_API_KEY,
        "x-timestamp": timestamp,
      },
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("should reject request with missing x-timestamp header", () => {
    const context = createMockContext({
      headers: {
        "x-api-key": TEST_API_KEY,
        "x-signature": "some-signature",
      },
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("should reject request with wrong API key", () => {
    const timestamp = Date.now().toString();
    const method = "GET";
    const path = "/v1/test";
    const signature = computeSignature(method, path, timestamp, "");

    const context = createMockContext({
      headers: {
        "x-api-key": "wrong-api-key",
        "x-signature": signature,
        "x-timestamp": timestamp,
      },
      method,
      path,
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("should reject request with invalid HMAC signature", () => {
    const timestamp = Date.now().toString();
    const method = "GET";
    const path = "/v1/test";
    // Use a valid hex string of correct length (64 hex chars = 32 bytes)
    const invalidSignature = "a".repeat(64);

    const context = createMockContext({
      headers: {
        "x-api-key": TEST_API_KEY,
        "x-signature": invalidSignature,
        "x-timestamp": timestamp,
      },
      method,
      path,
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("should reject request with expired timestamp (>5 minutes in the past)", () => {
    const expiredTimestamp = (Date.now() - 6 * 60 * 1000).toString(); // 6 minutes ago
    const method = "GET";
    const path = "/v1/test";
    const signature = computeSignature(method, path, expiredTimestamp, "");

    const context = createMockContext({
      headers: {
        "x-api-key": TEST_API_KEY,
        "x-signature": signature,
        "x-timestamp": expiredTimestamp,
      },
      method,
      path,
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("should reject request with future timestamp (>5 minutes ahead)", () => {
    const futureTimestamp = (Date.now() + 6 * 60 * 1000).toString(); // 6 minutes in future
    const method = "GET";
    const path = "/v1/test";
    const signature = computeSignature(method, path, futureTimestamp, "");

    const context = createMockContext({
      headers: {
        "x-api-key": TEST_API_KEY,
        "x-signature": signature,
        "x-timestamp": futureTimestamp,
      },
      method,
      path,
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("should bypass authentication for @Public() decorated route", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);

    const context = createMockContext({
      headers: {},
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("should compute signature with empty body hash for GET request", () => {
    const timestamp = Date.now().toString();
    const method = "GET";
    const path = "/v1/customers/123";
    const signature = computeSignature(method, path, timestamp, "");

    const context = createMockContext({
      headers: {
        "x-api-key": TEST_API_KEY,
        "x-signature": signature,
        "x-timestamp": timestamp,
      },
      method,
      path,
      body: undefined,
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("should compute signature including body SHA256 hash for POST request", () => {
    const timestamp = Date.now().toString();
    const method = "POST";
    const path = "/v1/customers";
    const body = { name: "Acme Corp", email: "billing@acme.com" };
    const bodyString = JSON.stringify(body);
    const signature = computeSignature(method, path, timestamp, bodyString);

    const context = createMockContext({
      headers: {
        "x-api-key": TEST_API_KEY,
        "x-signature": signature,
        "x-timestamp": timestamp,
      },
      method,
      path,
      body,
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("should attach adminRole to request when x-admin-role header is present", () => {
    const timestamp = Date.now().toString();
    const method = "GET";
    const path = "/v1/test";
    const signature = computeSignature(method, path, timestamp, "");
    const request: Record<string, unknown> = {
      method,
      path,
      headers: {
        "x-api-key": TEST_API_KEY,
        "x-signature": signature,
        "x-timestamp": timestamp,
        "x-admin-role": "admin",
      },
      body: undefined,
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(context)).toBe(true);
    expect(request.adminRole).toBe("admin");
  });

  it("should attach adminUserId to request when x-admin-user-id header is present", () => {
    const timestamp = Date.now().toString();
    const method = "GET";
    const path = "/v1/test";
    const signature = computeSignature(method, path, timestamp, "");
    const request: Record<string, unknown> = {
      method,
      path,
      headers: {
        "x-api-key": TEST_API_KEY,
        "x-signature": signature,
        "x-timestamp": timestamp,
        "x-admin-user-id": "user-123",
      },
      body: undefined,
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(context)).toBe(true);
    expect(request.adminUserId).toBe("user-123");
  });

  it("should not attach adminRole or adminUserId when admin headers are absent", () => {
    const timestamp = Date.now().toString();
    const method = "GET";
    const path = "/v1/test";
    const signature = computeSignature(method, path, timestamp, "");
    const request: Record<string, unknown> = {
      method,
      path,
      headers: {
        "x-api-key": TEST_API_KEY,
        "x-signature": signature,
        "x-timestamp": timestamp,
      },
      body: undefined,
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(context)).toBe(true);
    expect(request.adminRole).toBeUndefined();
    expect(request.adminUserId).toBeUndefined();
  });

  it("should reject request with malformed (non-hex) signature", () => {
    const timestamp = Date.now().toString();
    const method = "GET";
    const path = "/v1/test";

    const context = createMockContext({
      headers: {
        "x-api-key": TEST_API_KEY,
        "x-signature": "not-a-valid-hex-string",
        "x-timestamp": timestamp,
      },
      method,
      path,
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
