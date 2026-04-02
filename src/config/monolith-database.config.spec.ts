import { monolithDatabaseConfig } from "./monolith-database.config";

describe("monolithDatabaseConfig", () => {
  const originalEnv = process.env;

  const validEnv = {
    MONOLITH_DATABASE_HOST: "monolith-db.example.com",
    MONOLITH_DATABASE_PORT: "5432",
    MONOLITH_DATABASE_NAME: "monolith_production",
    MONOLITH_DATABASE_USER: "readonly_user",
    MONOLITH_DATABASE_PASSWORD: "secret123",
  };

  beforeEach(() => {
    process.env = { ...originalEnv, ...validEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should load valid config with all env vars set", () => {
    const config = monolithDatabaseConfig();

    expect(config).toEqual({
      host: "monolith-db.example.com",
      port: 5432,
      database: "monolith_production",
      user: "readonly_user",
      password: "secret123",
    });
  });

  it("should trim whitespace from all env vars", () => {
    process.env.MONOLITH_DATABASE_HOST = "  host.example.com  ";
    process.env.MONOLITH_DATABASE_PORT = " 5433 ";
    process.env.MONOLITH_DATABASE_NAME = "  mydb  ";
    process.env.MONOLITH_DATABASE_USER = "  user  ";
    process.env.MONOLITH_DATABASE_PASSWORD = "  pass  ";

    const config = monolithDatabaseConfig();

    expect(config).toEqual({
      host: "host.example.com",
      port: 5433,
      database: "mydb",
      user: "user",
      password: "pass",
    });
  });

  it("should throw when MONOLITH_DATABASE_HOST is missing", () => {
    delete process.env.MONOLITH_DATABASE_HOST;

    expect(() => monolithDatabaseConfig()).toThrow(
      "MONOLITH_DATABASE_HOST is required",
    );
  });

  it("should throw when MONOLITH_DATABASE_HOST is empty", () => {
    process.env.MONOLITH_DATABASE_HOST = "   ";

    expect(() => monolithDatabaseConfig()).toThrow(
      "MONOLITH_DATABASE_HOST is required",
    );
  });

  it("should throw when MONOLITH_DATABASE_PORT is missing", () => {
    delete process.env.MONOLITH_DATABASE_PORT;

    expect(() => monolithDatabaseConfig()).toThrow(
      "MONOLITH_DATABASE_PORT is required",
    );
  });

  it("should throw when MONOLITH_DATABASE_PORT is non-numeric", () => {
    process.env.MONOLITH_DATABASE_PORT = "abc";

    expect(() => monolithDatabaseConfig()).toThrow(
      'MONOLITH_DATABASE_PORT must be a positive integer, got "abc"',
    );
  });

  it("should throw when MONOLITH_DATABASE_PORT is negative", () => {
    process.env.MONOLITH_DATABASE_PORT = "-1";

    expect(() => monolithDatabaseConfig()).toThrow(
      'MONOLITH_DATABASE_PORT must be a positive integer, got "-1"',
    );
  });

  it("should throw when MONOLITH_DATABASE_PORT is decimal", () => {
    process.env.MONOLITH_DATABASE_PORT = "5432.5";

    expect(() => monolithDatabaseConfig()).toThrow(
      'MONOLITH_DATABASE_PORT must be a positive integer, got "5432.5"',
    );
  });

  it("should throw when MONOLITH_DATABASE_NAME is missing", () => {
    delete process.env.MONOLITH_DATABASE_NAME;

    expect(() => monolithDatabaseConfig()).toThrow(
      "MONOLITH_DATABASE_NAME is required",
    );
  });

  it("should throw when MONOLITH_DATABASE_USER is missing", () => {
    delete process.env.MONOLITH_DATABASE_USER;

    expect(() => monolithDatabaseConfig()).toThrow(
      "MONOLITH_DATABASE_USER is required",
    );
  });

  it("should throw when MONOLITH_DATABASE_PASSWORD is missing", () => {
    delete process.env.MONOLITH_DATABASE_PASSWORD;

    expect(() => monolithDatabaseConfig()).toThrow(
      "MONOLITH_DATABASE_PASSWORD is required",
    );
  });

  it("should throw when MONOLITH_DATABASE_PORT is zero", () => {
    process.env.MONOLITH_DATABASE_PORT = "0";

    expect(() => monolithDatabaseConfig()).toThrow(
      'MONOLITH_DATABASE_PORT must be a positive integer, got "0"',
    );
  });
});
