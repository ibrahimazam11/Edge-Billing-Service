import { authConfig } from "./auth.config";

describe("authConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should load config successfully with valid API_KEY and HMAC_SECRET", () => {
    process.env.API_KEY = "test-api-key";
    process.env.HMAC_SECRET = "test-hmac-secret";

    const config = authConfig();

    expect(config).toEqual({
      apiKey: "test-api-key",
      hmacSecret: "test-hmac-secret",
    });
  });

  it("should throw error when API_KEY is missing", () => {
    delete process.env.API_KEY;
    process.env.HMAC_SECRET = "test-hmac-secret";

    expect(() => authConfig()).toThrow("API_KEY is required");
  });

  it("should throw error when HMAC_SECRET is missing", () => {
    process.env.API_KEY = "test-api-key";
    delete process.env.HMAC_SECRET;

    expect(() => authConfig()).toThrow("HMAC_SECRET is required");
  });

  it("should throw error when API_KEY is whitespace-only", () => {
    process.env.API_KEY = "   ";
    process.env.HMAC_SECRET = "test-hmac-secret";

    expect(() => authConfig()).toThrow("API_KEY is required");
  });

  it("should throw error when HMAC_SECRET is whitespace-only", () => {
    process.env.API_KEY = "test-api-key";
    process.env.HMAC_SECRET = "   ";

    expect(() => authConfig()).toThrow("HMAC_SECRET is required");
  });
});
