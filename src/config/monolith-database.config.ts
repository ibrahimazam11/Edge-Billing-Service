import { registerAs } from "@nestjs/config";

export const monolithDatabaseConfig = registerAs("monolithDatabase", () => {
  const host = (process.env.MONOLITH_DATABASE_HOST ?? "").trim();
  const port = (process.env.MONOLITH_DATABASE_PORT ?? "").trim();
  const name = (process.env.MONOLITH_DATABASE_NAME ?? "").trim();
  const user = (process.env.MONOLITH_DATABASE_USER ?? "").trim();
  const password = (process.env.MONOLITH_DATABASE_PASSWORD ?? "").trim();

  if (!host) {
    throw new Error(
      "MONOLITH_DATABASE_HOST is required. Set the environment variable to the monolith PostgreSQL host.",
    );
  }

  if (!port) {
    throw new Error(
      "MONOLITH_DATABASE_PORT is required. Set the environment variable to the monolith PostgreSQL port.",
    );
  }

  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || String(portNum) !== port || portNum < 1) {
    throw new Error(
      `MONOLITH_DATABASE_PORT must be a positive integer, got "${port}".`,
    );
  }

  if (!name) {
    throw new Error(
      "MONOLITH_DATABASE_NAME is required. Set the environment variable to the monolith database name.",
    );
  }

  if (!user) {
    throw new Error(
      "MONOLITH_DATABASE_USER is required. Set the environment variable to the monolith database user.",
    );
  }

  if (!password) {
    throw new Error(
      "MONOLITH_DATABASE_PASSWORD is required. Set the environment variable to the monolith database password.",
    );
  }

  return {
    host,
    port: portNum,
    database: name,
    user,
    password,
  };
});
