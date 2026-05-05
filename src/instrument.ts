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

// source-map-support resolves runtime stack frames to .ts paths so Sentry
// (and console traces) point at source rather than compiled dist/*.js.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  require("source-map-support").install();
} catch {
  /* missing in some test contexts — non-fatal */
}

import * as Sentry from "@sentry/nestjs";

const PII_KEYS = new Set([
  "email",
  "phone",
  "firstname",
  "lastname",
  "dateofbirth",
  "taxid",
  "ssn",
  "cardnumber",
  "cvv",
  "iban",
  "bankaccount",
  "accountnumber",
  "routingnumber",
  "paymentmethodid",
  "stripesecretkey",
  "adyenapikey",
  "webhooksecret",
]);

const REDACTED = "[REDACTED]";

// Match keys regardless of case or `_`/`-` separators so payloads using
// snake_case (`payment_method_id`) or kebab-case still get redacted alongside
// camelCase (`paymentMethodId`).
function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[_-]/g, "");
}

function isWalkableObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  // Skip well-known non-walkable types — return as-is rather than walking
  // their internals (which produces meaningless output and risks data loss).
  if (
    v instanceof Date ||
    v instanceof RegExp ||
    v instanceof Map ||
    v instanceof Set ||
    Buffer.isBuffer(v)
  ) {
    return false;
  }
  return true;
}

export function redactPii<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (Array.isArray(value)) {
    const arr = value.map((v: unknown) => redactPii(v, depth + 1));
    return arr as unknown as T;
  }
  if (!isWalkableObject(value)) return value;
  const out: Record<string, unknown> = {};
  // `Object.entries` invokes own getters; a throwing getter would propagate
  // out of `beforeSend` and silently drop the event. Iterate defensively.
  let keys: string[] = [];
  try {
    keys = Object.keys(value);
  } catch {
    return value;
  }
  for (const k of keys) {
    if (PII_KEYS.has(normalizeKey(k))) {
      out[k] = REDACTED;
      continue;
    }
    try {
      out[k] = redactPii((value as Record<string, unknown>)[k], depth + 1);
    } catch {
      out[k] = REDACTED;
    }
  }
  return out as unknown as T;
}

const dsn = process.env.SENTRY_DSN;

function resolveEnvironment(): "staging" | "production" | "development" {
  const raw = (process.env.SENTRY_ENVIRONMENT || "").toLowerCase();
  if (raw === "staging" || raw === "production") return raw;
  return "development";
}

if (dsn) {
  Sentry.init({
    dsn,
    environment: resolveEnvironment(),
    release: process.env.SENTRY_RELEASE || undefined,
    spotlight: process.env.SENTRY_SPOTLIGHT === "true",
    // Performance tracing is intentionally disabled — out of scope for the
    // initial rollout. Re-enable later by setting tracesSampleRate > 0.
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.request?.data) {
        event.request.data = redactPii(event.request.data);
      }
      if (event.contexts) {
        event.contexts = redactPii(event.contexts);
      }
      if (event.extra) {
        event.extra = redactPii(event.extra);
      }
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.map((b) =>
          b.data ? { ...b, data: redactPii(b.data) } : b,
        );
      }
      return event;
    },
  });
}
