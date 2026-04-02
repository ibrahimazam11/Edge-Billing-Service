import { registerAs } from "@nestjs/config";

export const sentryConfig = registerAs("sentry", () => ({
  dsn: process.env.SENTRY_DSN || "",
  spotlight: process.env.SENTRY_SPOTLIGHT === "true",
}));
