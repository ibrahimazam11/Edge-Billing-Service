import { registerAs } from "@nestjs/config";

export type SentryEnvironment = "staging" | "production" | "development";

// Mirrors NODE_ENV — matches app.config.ts and time-machine guard.
function resolveEnvironment(): SentryEnvironment {
  const raw = (process.env.NODE_ENV || "").toLowerCase();
  if (raw === "staging" || raw === "production") return raw;
  return "development";
}

export const sentryConfig = registerAs("sentry", () => ({
  dsn: process.env.SENTRY_DSN || "",
  environment: resolveEnvironment(),
  release: process.env.SENTRY_RELEASE || "",
  spotlight: process.env.SENTRY_SPOTLIGHT === "true",
  enabled: Boolean(process.env.SENTRY_DSN),
}));
