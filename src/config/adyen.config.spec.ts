import { adyenConfig } from "./adyen.config";

describe("adyenConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ADYEN_API_KEY = "AQEtest123";
    process.env.ADYEN_MERCHANT_ACCOUNT = "TestMerchant";
    process.env.ADYEN_HMAC_KEY = "hmac_test_key_abc";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should load config successfully with all valid env vars", () => {
    const config = adyenConfig();

    expect(config).toEqual({
      apiKey: "AQEtest123",
      merchantAccount: "TestMerchant",
      hmacKey: "hmac_test_key_abc",
      environment: "TEST",
      liveUrlPrefix: undefined,
      apiBaseUrl: undefined,
    });
  });

  it("should default environment to TEST when not set", () => {
    delete process.env.ADYEN_ENVIRONMENT;

    const config = adyenConfig();

    expect(config.environment).toBe("TEST");
  });

  it("should uppercase environment value", () => {
    process.env.ADYEN_ENVIRONMENT = "live";

    process.env.ADYEN_LIVE_URL_PREFIX = "abc123";

    const config = adyenConfig();

    expect(config.environment).toBe("LIVE");
  });

  it("should include liveUrlPrefix when provided", () => {
    process.env.ADYEN_ENVIRONMENT = "LIVE";
    process.env.ADYEN_LIVE_URL_PREFIX = "abc123prefix";

    const config = adyenConfig();

    expect(config.liveUrlPrefix).toBe("abc123prefix");
  });

  it("should throw error when ADYEN_API_KEY is missing", () => {
    delete process.env.ADYEN_API_KEY;

    expect(() => adyenConfig()).toThrow("ADYEN_API_KEY is required");
  });

  it("should throw error when ADYEN_MERCHANT_ACCOUNT is missing", () => {
    delete process.env.ADYEN_MERCHANT_ACCOUNT;

    expect(() => adyenConfig()).toThrow("ADYEN_MERCHANT_ACCOUNT is required");
  });

  it("should throw error when ADYEN_HMAC_KEY is missing", () => {
    delete process.env.ADYEN_HMAC_KEY;

    expect(() => adyenConfig()).toThrow("ADYEN_HMAC_KEY is required");
  });

  it("should throw error when environment is LIVE and ADYEN_LIVE_URL_PREFIX is missing", () => {
    process.env.ADYEN_ENVIRONMENT = "LIVE";
    delete process.env.ADYEN_LIVE_URL_PREFIX;

    expect(() => adyenConfig()).toThrow(
      "ADYEN_LIVE_URL_PREFIX is required when ADYEN_ENVIRONMENT is LIVE",
    );
  });

  it("should throw error when ADYEN_API_KEY is whitespace-only", () => {
    process.env.ADYEN_API_KEY = "   ";

    expect(() => adyenConfig()).toThrow("ADYEN_API_KEY is required");
  });

  it("should throw error when ADYEN_MERCHANT_ACCOUNT is whitespace-only", () => {
    process.env.ADYEN_MERCHANT_ACCOUNT = "   ";

    expect(() => adyenConfig()).toThrow("ADYEN_MERCHANT_ACCOUNT is required");
  });

  it("should throw error when ADYEN_HMAC_KEY is whitespace-only", () => {
    process.env.ADYEN_HMAC_KEY = "   ";

    expect(() => adyenConfig()).toThrow("ADYEN_HMAC_KEY is required");
  });

  it("should include apiBaseUrl when ADYEN_API_BASE_URL is set", () => {
    process.env.ADYEN_API_BASE_URL = "http://localhost:8080";

    const config = adyenConfig();

    expect(config.apiBaseUrl).toBe("http://localhost:8080");
  });

  it("should set apiBaseUrl to undefined when ADYEN_API_BASE_URL is not set", () => {
    delete process.env.ADYEN_API_BASE_URL;

    const config = adyenConfig();

    expect(config.apiBaseUrl).toBeUndefined();
  });

  it("should set apiBaseUrl to undefined when ADYEN_API_BASE_URL is empty", () => {
    process.env.ADYEN_API_BASE_URL = "";

    const config = adyenConfig();

    expect(config.apiBaseUrl).toBeUndefined();
  });

  it("should trim whitespace from ADYEN_API_BASE_URL", () => {
    process.env.ADYEN_API_BASE_URL = "  http://localhost:8080  ";

    const config = adyenConfig();

    expect(config.apiBaseUrl).toBe("http://localhost:8080");
  });

  it("should trim whitespace from env var values", () => {
    process.env.ADYEN_API_KEY = "  AQEtest123  ";
    process.env.ADYEN_MERCHANT_ACCOUNT = "  TestMerchant  ";
    process.env.ADYEN_HMAC_KEY = "  hmac_key  ";

    const config = adyenConfig();

    expect(config.apiKey).toBe("AQEtest123");
    expect(config.merchantAccount).toBe("TestMerchant");
    expect(config.hmacKey).toBe("hmac_key");
  });
});
