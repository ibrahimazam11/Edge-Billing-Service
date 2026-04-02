# Billing Service

A production-grade billing microservice built with NestJS, providing subscription lifecycle management, invoice generation, payment processing, dunning workflows, credit management, reconciliation, and multi-gateway payment integration (Stripe & Adyen).

## Table of Contents

- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Environment Configuration](#environment-configuration)
- [Docker Services](#docker-services)
- [Database](#database)
- [Running the Application](#running-the-application)
- [Testing](#testing)
- [API Documentation (Swagger)](#api-documentation-swagger)
- [Authentication](#authentication)
- [Project Structure](#project-structure)
- [Architecture Overview](#architecture-overview)
- [Repository Pattern (Data Access Layer)](#repository-pattern-data-access-layer)

---

## Tech Stack

| Category | Technology | Version |
|---|---|---|
| Framework | NestJS | 11.x |
| Language | TypeScript (strict mode) | 5.7 |
| Runtime | Node.js | 24 |
| Package Manager | pnpm | latest |
| ORM | Drizzle ORM | 0.45 |
| Database | PostgreSQL | 18 |
| Testing | Jest | 30 |
| Payment Gateways | Stripe SDK, Adyen API Library | 20.x, 30.x |
| Queue | AWS SQS (via LocalStack locally) | - |
| API Docs | Swagger / OpenAPI | - |
| Error Tracking | Sentry (optional) | - |
| Resilience | Opossum (circuit breaker) | 9.x |

---

## Prerequisites

- **Node.js** >= 24
- **pnpm** (enabled via corepack: `corepack enable`)
- **Docker** & **Docker Compose** (for local development services)

---

## Getting Started

### 1. Clone and install dependencies

```bash
git clone <repository-url>
cd billing-service
pnpm install
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` with your local values. The defaults in `.env.example` are pre-configured for the Docker Compose services.

### 3. Start Docker services

```bash
docker compose up -d
```

This starts PostgreSQL, LocalStack, Stripe Mock, and WireMock. Wait for all services to be healthy:

```bash
docker compose ps
```

### 4. Run database migrations

```bash
pnpm migrate
```

### 5. Start the application

```bash
# Development (watch mode with hot reload)
pnpm start:dev

# Standard start
pnpm start

# Production
pnpm build
pnpm start:prod
```

The server starts on `http://localhost:3000` by default.

---

## Environment Configuration

Copy `.env.example` to `.env` and configure:

### Required Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Application port | `3000` |
| `NODE_ENV` | Environment (`development`, `production`, `test`) | `development` |
| `DATABASE_HOST` | PostgreSQL host | `localhost` |
| `DATABASE_PORT` | PostgreSQL port | `5432` |
| `DATABASE_NAME` | Database name | `billing_service` |
| `DATABASE_USER` | Database user | `postgres` |
| `DATABASE_PASSWORD` | Database password | `postgres` |
| `DATABASE_SSL` | Enable SSL connection | `false` |
| `AWS_REGION` | AWS region | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS access key (use `test` for LocalStack) | `test` |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key (use `test` for LocalStack) | `test` |
| `AWS_ENDPOINT_URL` | LocalStack endpoint (omit in production) | `http://localhost:4566` |
| `SQS_MONOLITH_INBOUND_QUEUE_URL` | Inbound SQS queue URL | see `.env.example` |
| `SQS_MONOLITH_OUTBOUND_QUEUE_URL` | Outbound SQS queue URL | see `.env.example` |
| `SQS_SCHEDULER_QUEUE_URL` | Scheduler SQS queue URL | see `.env.example` |
| `STRIPE_SECRET_KEY` | Stripe API secret key | - |
| `STRIPE_API_VERSION` | Stripe API version | `2026-01-28.clover` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | - |
| `STRIPE_API_BASE_URL` | Stripe API base URL (use `http://localhost:12111` for stripe-mock) | - |
| `API_KEY` | Static API key for HMAC auth | - |
| `HMAC_SECRET` | HMAC signing secret | - |
| `DUNNING_RETRY_SCHEDULE_DAYS` | Dunning retry schedule (comma-separated days) | `1,3,5,7` |

### Optional Variables

| Variable | Description |
|---|---|
| `ADYEN_API_KEY` | Adyen API key (enables Adyen gateway) |
| `ADYEN_MERCHANT_ACCOUNT` | Adyen merchant account |
| `ADYEN_HMAC_KEY` | Adyen webhook HMAC key |
| `ADYEN_ENVIRONMENT` | `TEST` or `LIVE` |
| `ADYEN_API_BASE_URL` | Adyen API URL (use `http://localhost:8080` for WireMock) |
| `SENTRY_DSN` | Sentry error tracking DSN |
| `SENTRY_SPOTLIGHT` | Enable Sentry Spotlight for local dev |
| `MONOLITH_DATABASE_HOST` | Legacy monolith database host (enables migration module) |
| `MONOLITH_DATABASE_PORT` | Monolith database port |
| `MONOLITH_DATABASE_NAME` | Monolith database name |
| `MONOLITH_DATABASE_USER` | Monolith database user |
| `MONOLITH_DATABASE_PASSWORD` | Monolith database password |

---

## Docker Services

The `docker-compose.yml` provides four services for local development and E2E testing:

```bash
# Start all services
docker compose up -d

# Stop all services
docker compose down

# Stop and remove volumes (reset all data)
docker compose down -v
```

### PostgreSQL

| | |
|---|---|
| **Image** | `postgres:18` |
| **Container** | `billing-postgres` |
| **Port** | `5433:5432` (host:container) |
| **Database** | `billing_service` |
| **Credentials** | `postgres` / `postgres` |

The port is mapped to **5433** on the host to avoid conflicts with any local PostgreSQL instance. The `DATABASE_PORT` in `.env` should be set to `5432` (the container's internal port) when connecting from within Docker, or `5433` when connecting from the host machine.

### LocalStack (AWS SQS)

| | |
|---|---|
| **Image** | `localstack/localstack:latest` |
| **Container** | `billing-localstack` |
| **Port** | `4566:4566` |
| **Services** | SQS, SNS, CloudWatch, EventBridge, S3 |
| **Region** | `us-east-1` |

LocalStack emulates AWS services locally. On startup, it automatically creates three SQS queues via the init script at `localstack/init-aws.sh`:

- `billing-inbound` -- receives events from the monolith (customers, subscriptions, webhooks)
- `billing-outbound` -- sends events to the monolith (payment results, reconciliation)
- `billing-scheduler` -- receives scheduled events (invoice generation, dunning runs)

### Stripe Mock

| | |
|---|---|
| **Image** | `stripe/stripe-mock:latest` |
| **Container** | `billing-stripe-mock` |
| **Port** | `12111:12111` |

[stripe-mock](https://github.com/stripe/stripe-mock) is Stripe's official mock HTTP server. It implements the Stripe API spec locally so you can develop and test without hitting the real Stripe API. The billing service connects to it by setting `STRIPE_API_BASE_URL=http://localhost:12111`.

Supported operations include customer management, payment intents, payment methods, charges, refunds, and balance transactions.

### WireMock (Adyen Mock)

| | |
|---|---|
| **Image** | `wiremock/wiremock:3.13.0` |
| **Container** | `billing-wiremock` |
| **Port** | `8080:8080` |
| **Mappings** | `test/wiremock/mappings/` |
| **Response Files** | `test/wiremock/__files/` |

[WireMock](https://wiremock.org/) mocks the Adyen API for local development and E2E testing. Request/response mappings are stored in `test/wiremock/mappings/` and mounted into the container. The service runs with `--verbose --global-response-templating` for dynamic response generation.

Set `ADYEN_API_BASE_URL=http://localhost:8080` to route Adyen API calls through WireMock.

Admin API: `http://localhost:8080/__admin` (for verifying recorded requests, managing stubs at runtime).

---

## Database

### Drizzle ORM

The project uses [Drizzle ORM](https://orm.drizzle.team/) as the database toolkit. Configuration is in `drizzle.config.ts`:

```typescript
export default defineConfig({
  schema: './src/database/schema/index.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: { /* from environment variables */ },
});
```

### Schema

Database schemas are defined as Drizzle table definitions in `src/database/schema/`, with all tables exported from `src/database/schema/index.ts`:

| Table | Description |
|---|---|
| `customers` | Customer records with monolith and gateway references |
| `payment_methods` | Payment instruments with fallback ordering and gateway assignment |
| `subscriptions` | Recurring billing subscriptions with lifecycle state |
| `invoices` | Generated invoices with billing period and status tracking |
| `invoice_line_items` | Line items for each invoice |
| `charges` | Payment attempts linked to invoices and payment methods |
| `refunds` | Refund records with status and gateway references |
| `ledger_accounts` | Chart of accounts (assets, liabilities, revenue, expenses, equity) |
| `ledger_entries` | Double-entry bookkeeping journal entries |
| `dunning_attempts` | Payment recovery attempt tracking |
| `credit_notes` | Credit issuances for customers |
| `credit_balances` | Running credit balance per customer |
| `reconciliation_runs` | Reconciliation batch records |
| `reconciliation_discrepancies` | Mismatches found during reconciliation |
| `audit_trail` | Immutable admin action log |
| `processed_events` | Idempotency tracking for webhook/event processing |
| `feature_flags` | Feature toggle configuration |
| `surcharge_configs` | Surcharge rules and configuration |
| `gateway_assignments` | Customer-to-payment-gateway mapping |
| `migration_logs` | Monolith migration tracking |

### Migrations

Migrations are SQL files generated by Drizzle Kit and stored in `drizzle/migrations/`. The project currently has 22 migrations.

```bash
# Run pending migrations against the database
pnpm migrate

# Generate a new migration after schema changes
pnpm drizzle-kit generate

# View migration status
pnpm drizzle-kit status
```

Migrations are also run automatically during E2E test setup via the `drizzle-orm/node-postgres/migrator` programmatic API.

### Seed Data

Ledger accounts are seeded via migration `0007_ledger_accounts_seed.sql` which inserts the five standard GL accounts (Assets, Liabilities, Revenue, Expenses, Equity) using `ON CONFLICT DO NOTHING` for idempotency.

E2E tests use dedicated seed helpers in `test/helpers/database.ts` to set up test data per spec file.

---

## Running the Application

### Development

```bash
# Watch mode (auto-restarts on file changes)
pnpm start:dev

# Debug mode (attaches Node.js inspector)
pnpm start:debug
```

### Production

```bash
pnpm build
pnpm start:prod
```

### Docker Build

The project includes a multi-stage `Dockerfile`:

```bash
# Build the image
docker build -t billing-service .

# Run the container
docker run -p 3000:3000 --env-file .env billing-service
```

The Dockerfile uses a two-stage build:
1. **Build stage** -- installs all dependencies, compiles TypeScript
2. **Production stage** -- installs only production dependencies, copies compiled output

---

## Testing

The project has **1,990 tests** total: 1,598 unit tests and 392 E2E tests.

### Unit Tests

Unit tests are co-located with source files as `*.spec.ts`:

```bash
# Run all unit tests
pnpm test

# Run tests matching a pattern
pnpm test -- --testPathPatterns=customers

# Watch mode
pnpm test:watch

# Coverage report (full suite)
pnpm test:cov

# Coverage for specific files
pnpm test:cov:files -- 'src/customers/**/*.ts'
```

**Configuration**: Jest config is in `package.json` under the `"jest"` key. Tests run from the `src/` root directory, matching `*.spec.ts` files (98 test suites), and use `ts-jest` for TypeScript compilation.

### End-to-End (E2E) Tests

E2E tests live in the `test/` directory as `*.e2e-spec.ts` files. They test the full request lifecycle against real Docker services.

**Prerequisites**: All Docker Compose services must be running.

```bash
# Start services
docker compose up -d

# Run all E2E tests
pnpm test:e2e

# Run a specific E2E test file
pnpm test:e2e -- --testPathPatterns=customers
```

**Configuration**: `test/jest-e2e.json` with a 30-second timeout. Tests run sequentially (`--runInBand`) to avoid database conflicts.

#### E2E Test Infrastructure

| File | Purpose |
|---|---|
| `test/jest-e2e.json` | Jest E2E configuration |
| `test/helpers/setup.ts` | Loads `.env.test` before all tests |
| `test/helpers/database.ts` | Test database creation, migration, cleanup, and seeding |
| `test/helpers/test-app.ts` | Bootstraps a NestJS application instance for testing |
| `test/helpers/hmac-signer.ts` | Generates HMAC signatures for authenticated requests |
| `test/helpers/sqs.ts` | LocalStack SQS helpers for publishing/reading messages |
| `test/helpers/stripe-mock.ts` | Stripe mock API helpers |
| `test/helpers/wiremock.ts` | WireMock stub management helpers |
| `test/fixtures/` | Test fixture data (e.g., Adyen webhook payloads) |
| `test/wiremock/mappings/` | WireMock request/response stubs for Adyen |

#### E2E Test Files (30 spec files)

The E2E suite covers every domain:

- `health.e2e-spec.ts` -- Health check endpoints
- `customers.e2e-spec.ts` -- Customer CRUD operations
- `subscriptions.e2e-spec.ts` -- Subscription lifecycle
- `invoices.e2e-spec.ts` -- Invoice generation and finalization
- `invoice-query-void.e2e-spec.ts` -- Invoice querying and voiding
- `charges.e2e-spec.ts` -- Payment charge processing
- `one-time-onboarding-charges.e2e-spec.ts` -- One-time charges
- `ledger.e2e-spec.ts` -- Double-entry ledger operations
- `webhooks.e2e-spec.ts` -- Webhook processing
- `dunning-scheduling.e2e-spec.ts` -- Dunning schedule creation
- `dunning-execution.e2e-spec.ts` -- Dunning run execution
- `dunning-fallback-cascading.e2e-spec.ts` -- Payment method fallback
- `credits.e2e-spec.ts` -- Credit note issuance
- `credits-application.e2e-spec.ts` -- Credit application to invoices
- `reconciliation.e2e-spec.ts` -- Reconciliation workflows
- `feature-flags.e2e-spec.ts` -- Feature flag management
- `surcharges.e2e-spec.ts` -- Surcharge configuration
- `migration-payment-settings.e2e-spec.ts` -- Monolith migration (payment settings)
- `migration-charges.e2e-spec.ts` -- Monolith migration (charges)
- `migration-payroll.e2e-spec.ts` -- Monolith migration (payroll)
- `migration-validation.e2e-spec.ts` -- Migration validation
- `multi-gateway.e2e-spec.ts` -- Multi-gateway routing (Stripe + Adyen)
- `refunds.e2e-spec.ts` -- Refund lifecycle
- `reporting.e2e-spec.ts` -- Financial reporting endpoints
- `cs-billing-inquiry.e2e-spec.ts` -- Customer support billing inquiry
- `finance-reconciliation.e2e-spec.ts` -- Finance self-service reconciliation
- `admin.e2e-spec.ts` -- Admin operations
- `expanded-admin.e2e-spec.ts` -- Expanded admin operations (billing history, bulk ops)
- `sqs-infrastructure.e2e-spec.ts` -- SQS integration verification
- `stripe-mock-infrastructure.e2e-spec.ts` -- Stripe mock integration verification

### Linting & Type Checking

```bash
# Lint with auto-fix
pnpm lint

# Type check (no emit)
pnpm tsc --noEmit
```

ESLint uses the flat config format (`eslint.config.mjs`) with `typescript-eslint` and Prettier integration.

### Code Formatting

```bash
pnpm format
```

Uses Prettier to format all TypeScript files in `src/` and `test/`.

---

## API Documentation (Swagger)

Swagger UI is available at **`http://localhost:3000/api-docs`** when the application is running.

The OpenAPI specification includes:
- All REST endpoints grouped by module
- Request/response schemas auto-generated from DTOs
- Security scheme documentation (HMAC authentication headers)
- Pagination patterns and cursor-based pagination

The `@nestjs/swagger` plugin is configured in `nest-cli.json` with `classValidatorShim` and `introspectComments` enabled, so DTO properties and JSDoc comments are automatically included in the generated specification.

---

## Authentication

All API endpoints (except health checks) require HMAC-SHA256 authentication via three HTTP headers:

| Header | Description |
|---|---|
| `x-api-key` | Static API key matching the `API_KEY` env var |
| `x-signature` | HMAC-SHA256 hex digest of: `METHOD + PATH + TIMESTAMP + SHA256(BODY)` |
| `x-timestamp` | Unix timestamp in milliseconds (must be within a 5-minute window) |

### Signing Algorithm

```
signature = HMAC-SHA256(
  HMAC_SECRET,
  HTTP_METHOD + REQUEST_PATH + TIMESTAMP + SHA256(REQUEST_BODY)
)
```

- `REQUEST_PATH` excludes query strings
- `REQUEST_BODY` is `JSON.stringify(body)` for requests with a body, or an empty string otherwise
- The timestamp must be within 300,000ms (5 minutes) of the server time

### Admin Endpoints

Admin endpoints additionally require role headers:

| Header | Description |
|---|---|
| `x-admin-role` | One of: `cs`, `finance`, `admin` |
| `x-admin-user-id` | Admin user identifier (for audit trail) |

Endpoints are protected with role-based access control via the `@Roles()` decorator.

---

## Project Structure

```
billing-service/
├── src/
│   ├── admin/               # Admin panel (billing history, bulk ops, audit trail)*
│   ├── charges/             # One-time and recurring charge management*
│   ├── common/              # Shared utilities
│   │   ├── constants/       # Application constants
│   │   ├── decorators/      # @Public, @Roles, @ApiPaginatedResponse
│   │   ├── dto/             # Common DTOs (pagination, etc.)
│   │   ├── enums/           # GatewayProvider, AdminRole, etc.
│   │   ├── exceptions/      # BillingException hierarchy
│   │   ├── filters/         # GlobalExceptionFilter
│   │   ├── guards/          # HmacAuthGuard, RolesGuard
│   │   ├── interceptors/    # CorrelationIdInterceptor
│   │   ├── interfaces/      # Shared TypeScript interfaces
│   │   ├── pipes/           # Validation pipe
│   │   └── utils/           # Utility functions
│   ├── config/              # Environment config modules
│   ├── credits/             # Credit notes and balances*
│   ├── customers/           # Customer onboarding and management*
│   ├── database/            # Drizzle ORM setup
│   │   ├── schema/          # Table definitions (21 schema files)
│   │   ├── base.repository.ts   # Generic CRUD base class
│   │   ├── database-health.repository.ts
│   │   └── types.ts         # TransactionClient, DbOrTx types
│   ├── dunning/             # Payment recovery workflows*
│   ├── feature-flags/       # Feature toggles*
│   ├── gateway/             # Payment gateway abstraction
│   │   ├── stripe/          # Stripe adapter
│   │   ├── adyen/           # Adyen adapter
│   │   └── circuit-breaker/ # Resilience pattern
│   ├── health/              # Liveness/readiness checks
│   ├── integration/
│   │   └── sqs/             # SQS producers and consumers
│   ├── invoices/            # Invoice generation and lifecycle*
│   ├── ledger/              # Double-entry accounting*
│   ├── migration/           # Monolith migration (dual-write)*
│   ├── payment-methods/     # Payment method management*
│   ├── reconciliation/      # Financial reconciliation*
│   ├── refunds/             # Refund lifecycle*
│   ├── reporting/           # Revenue, dunning, and dashboard reports
│   ├── subscriptions/       # Subscription lifecycle*
│   ├── surcharges/          # Surcharge configuration*
│   ├── webhooks/            # Gateway webhook processing*
│   ├── app.module.ts        # Root module
│   ├── main.ts              # Bootstrap + Swagger setup
│   └── instrument.ts        # Sentry initialization
├── test/
│   ├── helpers/             # E2E test utilities
│   ├── fixtures/            # Test fixture data
│   ├── wiremock/            # WireMock stubs for Adyen
│   └── *.e2e-spec.ts       # 30 E2E test files
├── drizzle/
│   └── migrations/          # 22 SQL migration files
├── localstack/
│   └── init-aws.sh          # SQS queue initialization script
├── docker-compose.yml       # Local dev services
├── Dockerfile               # Multi-stage production build
├── drizzle.config.ts        # Drizzle ORM configuration
├── nest-cli.json            # NestJS CLI + Swagger plugin config
├── eslint.config.mjs        # ESLint flat config
├── tsconfig.json            # TypeScript configuration
├── tsconfig.build.json      # TypeScript build configuration
└── package.json             # Dependencies and scripts
```

> **\*** Modules marked with an asterisk contain co-located `*.repository.ts` files. See [Repository Pattern](#repository-pattern-data-access-layer) below.

---

## Architecture Overview

### Payment Gateway Abstraction

The service uses a **Gateway Registry** pattern to support multiple payment processors:

- `PaymentGateway` interface defines a unified contract (customers, charges, refunds, webhooks)
- `GatewayRegistry` resolves the correct adapter based on the `GatewayProvider` enum
- **Stripe** and **Adyen** adapters implement the interface
- A **circuit breaker** (via Opossum) wraps gateway calls for resilience

### Event-Driven Architecture

The service communicates asynchronously via AWS SQS:

- **Inbound queue** -- receives customer, subscription, and webhook events from the monolith
- **Outbound queue** -- publishes payment results and reconciliation events
- **Scheduler queue** -- receives timed events for invoice generation and dunning runs

All event processing is idempotent via the `processed_events` table.

### Double-Entry Ledger

Financial transactions are recorded as double-entry journal entries in the `ledger_entries` table, with immutability enforced via database triggers. Five standard GL accounts are maintained: Assets, Liabilities, Revenue, Expenses, and Equity.

### Monolith Migration

The service supports a gradual migration from a legacy monolith via:

- **Dual-write** capability (write to both systems simultaneously)
- **Migration services** for payment settings, charges, and payroll data
- **Validation service** to verify migration integrity
- Optional monolith database connection (enabled when `MONOLITH_DATABASE_HOST` is set)

---

## Scripts Reference

| Script | Description |
|---|---|
| `pnpm start` | Start the application |
| `pnpm start:dev` | Start with watch mode (hot reload) |
| `pnpm start:debug` | Start with debugger attached |
| `pnpm start:prod` | Start production build |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm test` | Run unit tests |
| `pnpm test:watch` | Run unit tests in watch mode |
| `pnpm test:cov` | Run unit tests with coverage |
| `pnpm test:cov:files` | Run targeted coverage |
| `pnpm test:e2e` | Run E2E tests (requires Docker services) |
| `pnpm test:debug` | Run tests with debugger |
| `pnpm migrate` | Run database migrations |
| `pnpm lint` | Lint and auto-fix |
| `pnpm format` | Format code with Prettier |

---

## Repository Pattern (Data Access Layer)

All database access is routed through a **repository layer** that separates query logic from business logic. Every domain module has one or more co-located `*.repository.ts` files, all extending a shared base class.

### Base Repository

`src/database/base.repository.ts` provides generic CRUD and pagination helpers for every table:

| Method | Description |
|---|---|
| `findById(id, tx?)` | Retrieve a single entity by primary key |
| `create(data, tx?)` | Insert and return the new row |
| `update(id, data, tx?)` | Partial update and return the updated row |
| `deleteById(id, tx?)` | Delete by primary key |
| `buildWhereClause(conditions)` | Combine `SQL[]` conditions with `and()` |
| `buildDateRangeConditions(col, start?, end?)` | Generate `>=` / `<=` filters for date columns |
| `buildCursorCondition(col, cursor?)` | Cursor-based pagination for string IDs |
| `buildTimestampCursorCondition(col, cursor?)` | Cursor-based pagination for timestamps (reverse-chronological) |
| `conn(tx?)` | Select between database connection or transaction client |

All methods accept an optional `TransactionClient` parameter so repositories compose naturally inside `db.transaction()` blocks.

### Repository Inventory

21 repositories across 16 modules:

| Module | Repository | Notable Capabilities |
|---|---|---|
| `database` | `BaseRepository` | Generic CRUD, pagination, date-range helpers |
| `database` | `DatabaseHealthRepository` | Raw `SELECT 1` health probe |
| `customers` | `CustomersRepository` | `ilike()` search, cursor pagination |
| `invoices` | `InvoicesRepository` | Concurrency-checked updates, JSONB metadata queries, billing-history aggregation |
| `charges` | `ChargesRepository` | Idempotent inserts (`createWithIdempotency`), LEFT JOIN projections |
| `subscriptions` | `SubscriptionsRepository` | State-machine updates, batch queries |
| `refunds` | `RefundsRepository` | Idempotent inserts, gateway-reference lookups |
| `payment-methods` | `PaymentMethodsRepository` | Fallback ordering, gateway-scoped queries |
| `payment-methods` | `GatewayAssignmentsRepository` | Customer-to-gateway mapping |
| `credits` | `CreditBalancesRepository` | Transaction-only upsert/deduct (`*InTx` methods) |
| `credits` | `CreditNotesRepository` | Credit note queries with customer filter |
| `dunning` | `DunningRepository` | Attempt tracking, schedule queries |
| `ledger` | `LedgerEntriesRepository` | Double-entry journal inserts |
| `ledger` | `LedgerAccountsRepository` | Chart-of-accounts lookups |
| `reconciliation` | `ReconciliationRunsRepository` | Batch run management |
| `reconciliation` | `ReconciliationDiscrepanciesRepository` | Discrepancy CRUD with multi-column filtering |
| `admin` | `AuditTrailRepository` | Immutable append-only audit log |
| `surcharges` | `SurchargeConfigRepository` | Surcharge rule queries |
| `feature-flags` | `FeatureFlagsRepository` | Flag lookups with caching support |
| `migration` | `MigrationLogsRepository` | Migration tracking and validation |
| `integration/sqs` | `ProcessedEventsRepository` | Idempotency tracking for event processing |

### Key Patterns

**Idempotent inserts** -- `ChargesRepository` and `RefundsRepository` catch unique-constraint violations and return the existing row with an `isDuplicate` flag, avoiding retry failures.

**Transaction-aware methods** -- Repositories like `CreditBalancesRepository` expose explicit `*InTx` variants that require a `TransactionClient`, ensuring atomicity for multi-write operations (e.g., applying credits to an invoice).

**Concurrency checks** -- `InvoicesRepository.updateWithConcurrencyCheck()` adds the expected status to the `WHERE` clause and returns `null` if the row has already transitioned, providing optimistic-locking semantics without database-level locks.

**Cursor pagination** -- Repositories consistently fetch `limit + 1` rows to determine whether more results exist, returning exactly `limit` rows to the caller. The base class provides both string-ID and timestamp cursor helpers.

### Module Registration

Repositories are registered as NestJS providers and explicitly exported so other modules can import them:

```typescript
@Module({
  controllers: [CustomersController],
  providers: [CustomersRepository, CustomersService],
  exports: [CustomersRepository, CustomersService],
})
export class CustomersModule {}
```

Every repository injects the Drizzle ORM instance via the global `DRIZZLE_PROVIDER` token:

```typescript
constructor(@Inject(DRIZZLE_PROVIDER) db: DrizzleDatabase) {
  super(db);
}
```

### Type Safety

The base class uses Drizzle's `InferSelectModel<TTable>` and `InferInsertModel<TTable>` generics, so schema changes propagate automatically to all repository method signatures at compile time -- no manual DTO mapping required for CRUD operations.
