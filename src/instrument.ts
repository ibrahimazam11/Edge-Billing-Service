// Pre-load .env so app.module.ts's decorator-time `process.env.X ? [...] : []`
// spreads see real values (ConfigModule.forRoot loads .env too late for those).
// dotenv is a devDependency and isn't present in the production image; in ECS
// env vars are injected by the platform, so we silently skip when absent.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv/config");
} catch {
  /* dotenv not installed (production image) — env vars come from the platform */
}

import * as Sentry from "@sentry/nestjs";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    spotlight: process.env.SENTRY_SPOTLIGHT === "true",
  });
}
