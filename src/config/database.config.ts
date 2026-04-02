import { registerAs } from "@nestjs/config";

export const databaseConfig = registerAs("database", () => {
  const host = process.env.DATABASE_HOST;
  const port = parseInt(process.env.DATABASE_PORT || "5432", 10);
  const name = process.env.DATABASE_NAME;
  const user = process.env.DATABASE_USER;
  const password = process.env.DATABASE_PASSWORD;

  if (!host) throw new Error("DATABASE_HOST is required");
  if (!name) throw new Error("DATABASE_NAME is required");
  if (!user) throw new Error("DATABASE_USER is required");
  if (!password) throw new Error("DATABASE_PASSWORD is required");
  if (isNaN(port)) throw new Error("DATABASE_PORT must be a valid number");

  return { host, port, name, user, password };
});
