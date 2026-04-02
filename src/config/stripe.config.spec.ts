import { stripeConfig } from "./stripe.config";

describe("stripeConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_API_VERSION = "2026-01-28.clover";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_123";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should load config successfully with all valid env vars", () => {
    const config = stripeConfig();

    expect(config).toEqual({
      secretKey: "sk_test_123",
      apiVersion: "2026-01-28.clover",
      webhookSecret: "whsec_test_123",
      apiBaseUrl: undefined,
    });
  });

  it("should include apiBaseUrl when provided", () => {
    process.env.STRIPE_API_BASE_URL = "http://localhost:12111";

    const config = stripeConfig();

    expect(config.apiBaseUrl).toBe("http://localhost:12111");
  });

  it("should throw error when STRIPE_SECRET_KEY is missing", () => {
    delete process.env.STRIPE_SECRET_KEY;

    expect(() => stripeConfig()).toThrow("STRIPE_SECRET_KEY is required");
  });

  it("should throw error when STRIPE_API_VERSION is missing", () => {
    delete process.env.STRIPE_API_VERSION;

    expect(() => stripeConfig()).toThrow("STRIPE_API_VERSION is required");
  });

  it("should throw error when STRIPE_WEBHOOK_SECRET is missing", () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;

    expect(() => stripeConfig()).toThrow("STRIPE_WEBHOOK_SECRET is required");
  });

  it("should throw error when STRIPE_SECRET_KEY is whitespace-only", () => {
    process.env.STRIPE_SECRET_KEY = "   ";

    expect(() => stripeConfig()).toThrow("STRIPE_SECRET_KEY is required");
  });

  it("should throw error when STRIPE_API_VERSION is whitespace-only", () => {
    process.env.STRIPE_API_VERSION = "   ";

    expect(() => stripeConfig()).toThrow("STRIPE_API_VERSION is required");
  });

  it("should throw error when STRIPE_WEBHOOK_SECRET is whitespace-only", () => {
    process.env.STRIPE_WEBHOOK_SECRET = "   ";

    expect(() => stripeConfig()).toThrow("STRIPE_WEBHOOK_SECRET is required");
  });
});
