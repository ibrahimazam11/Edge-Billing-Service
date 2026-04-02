import * as Sentry from "@sentry/nestjs";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    spotlight: process.env.SENTRY_SPOTLIGHT === "true",
  });
}
