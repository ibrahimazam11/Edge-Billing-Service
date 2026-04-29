// Pre-load .env so app.module.ts's decorator-time `process.env.X ? [...] : []`
// spreads see real values (ConfigModule.forRoot loads .env too late for those).
import "dotenv/config";

import * as Sentry from "@sentry/nestjs";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    spotlight: process.env.SENTRY_SPOTLIGHT === "true",
  });
}
