import { dunningConfig } from "./dunning.config";

describe("dunningConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should load default schedule [1,3,5,7] when env var is not set", () => {
    delete process.env.DUNNING_RETRY_SCHEDULE_DAYS;

    const config = dunningConfig();

    expect(config).toEqual({
      retryScheduleDays: [1, 3, 5, 7],
      maxRetryAttempts: 4,
    });
  });

  it("should load custom schedule from env var", () => {
    process.env.DUNNING_RETRY_SCHEDULE_DAYS = "2,5,10";

    const config = dunningConfig();

    expect(config).toEqual({
      retryScheduleDays: [2, 5, 10],
      maxRetryAttempts: 3,
    });
  });

  it("should trim and parse values with extra whitespace", () => {
    process.env.DUNNING_RETRY_SCHEDULE_DAYS = " 1 , 3 , 5 ";

    const config = dunningConfig();

    expect(config).toEqual({
      retryScheduleDays: [1, 3, 5],
      maxRetryAttempts: 3,
    });
  });

  it("should reject whitespace-only env var", () => {
    process.env.DUNNING_RETRY_SCHEDULE_DAYS = "   ";

    expect(() => dunningConfig()).toThrow(
      "DUNNING_RETRY_SCHEDULE_DAYS cannot be empty",
    );
  });

  it("should reject empty string env var", () => {
    process.env.DUNNING_RETRY_SCHEDULE_DAYS = "";

    expect(() => dunningConfig()).toThrow(
      "DUNNING_RETRY_SCHEDULE_DAYS cannot be empty",
    );
  });

  it("should reject non-numeric values", () => {
    process.env.DUNNING_RETRY_SCHEDULE_DAYS = "1,foo,3";

    expect(() => dunningConfig()).toThrow(
      'DUNNING_RETRY_SCHEDULE_DAYS contains invalid value "foo"',
    );
  });

  it("should reject negative values", () => {
    process.env.DUNNING_RETRY_SCHEDULE_DAYS = "1,-3,5";

    expect(() => dunningConfig()).toThrow(
      'DUNNING_RETRY_SCHEDULE_DAYS contains invalid value "-3"',
    );
  });

  it("should reject zero values", () => {
    process.env.DUNNING_RETRY_SCHEDULE_DAYS = "1,0,5";

    expect(() => dunningConfig()).toThrow(
      'DUNNING_RETRY_SCHEDULE_DAYS contains invalid value "0"',
    );
  });

  it("should reject decimal values", () => {
    process.env.DUNNING_RETRY_SCHEDULE_DAYS = "1,3.5,7";

    expect(() => dunningConfig()).toThrow(
      'DUNNING_RETRY_SCHEDULE_DAYS contains invalid value "3.5"',
    );
  });

  it("should support single value schedule", () => {
    process.env.DUNNING_RETRY_SCHEDULE_DAYS = "7";

    const config = dunningConfig();

    expect(config).toEqual({
      retryScheduleDays: [7],
      maxRetryAttempts: 1,
    });
  });
});
