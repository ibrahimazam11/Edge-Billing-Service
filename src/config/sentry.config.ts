import { registerAs } from "@nestjs/config";

export type SentryEnvironment = "staging" | "production" | "development";

function resolveEnvironment(): SentryEnvironment {
  const raw = (process.env.SENTRY_ENVIRONMENT || "").toLowerCase();
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
