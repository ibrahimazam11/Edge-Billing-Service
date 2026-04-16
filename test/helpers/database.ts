import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { resolve } from "path";
import * as schema from "../../src/database/schema";

export type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

let pool: Pool | null = null;
let db: TestDatabase | null = null;

/**
 * Get or create a database connection for e2e tests.
 * Uses DATABASE_NAME from .env.test (billing_service_test).
 */
export function getTestDatabase(): TestDatabase {
  if (db) return db;

  pool = new Pool({
    host: process.env.DATABASE_HOST ?? "localhost",
    port: parseInt(process.env.DATABASE_PORT ?? "5432", 10),
    database: process.env.DATABASE_NAME ?? "billing_service_test",
    user: process.env.DATABASE_USER ?? "postgres",
    password: process.env.DATABASE_PASSWORD ?? "postgres",
  });

  db = drizzle(pool, { schema });
  return db;
}

/**
 * Ensure the test database exists and has tables.
 * Creates the database if it doesn't exist, then applies real Drizzle migrations.
 *
 * SAFETY: Refuses to run against any database whose name doesn't end with "_test".
 */
export async function setupTestDatabase(): Promise<void> {
  const dbName = process.env.DATABASE_NAME ?? "billing_service_test";
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `setupTestDatabase() refused: database "${dbName}" does not end with "_test". ` +
      `This safeguard prevents accidental schema drops on non-test databases. ` +
      `Check .env.test is present and DATABASE_NAME ends with "_test".`,
    );
  }

  const adminPool = new Pool({
    host: process.env.DATABASE_HOST ?? "localhost",
    port: parseInt(process.env.DATABASE_PORT ?? "5432", 10),
    database: "postgres",
    user: process.env.DATABASE_USER ?? "postgres",
    password: process.env.DATABASE_PASSWORD ?? "postgres",
  });

  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } catch (err: unknown) {
    // 42P04 = duplicate_database — safe to ignore if another worker created it first
    if ((err as { code?: string }).code !== "42P04") {
      throw err;
    }
  } finally {
    await adminPool.end();
  }

  // Run real Drizzle migrations against the test database.
  // The migrator tracks applied migrations in "drizzle"."__drizzle_migrations"
  // and is idempotent on subsequent runs.
  const testDb = getTestDatabase();

  // Transition guard: if the DB was set up with old hand-written SQL
  // (no "drizzle" schema), drop public schema to avoid "relation already exists"
  // errors from migrations. Safe because this is a test database.
  const schemaCheck = await testDb.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.schemata
      WHERE schema_name = 'drizzle'
    ) AS has_drizzle_schema
  `);
  const hasDrizzleSchema = (
    schemaCheck.rows[0] as { has_drizzle_schema: boolean }
  ).has_drizzle_schema;

  if (!hasDrizzleSchema) {
    await testDb.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
    await testDb.execute(sql`CREATE SCHEMA public`);
  }

  await migrate(testDb, {
    migrationsFolder: resolve(__dirname, "../../drizzle/migrations"),
  });
}

/**
 * Clean all data from test tables (preserves table structure).
 * Order matters due to foreign key constraints.
 *
 * SAFETY: Refuses to run against any database whose name doesn't end with "_test".
 * This prevents accidental data wipe on dev/UAT/prod if .env.test is missing or
 * misconfigured.
 */
export async function cleanDatabase(): Promise<void> {
  const dbName = process.env.DATABASE_NAME ?? "billing_service_test";
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `cleanDatabase() refused: database "${dbName}" does not end with "_test". ` +
      `This safeguard prevents accidental TRUNCATE on non-test databases. ` +
      `Check .env.test is present and DATABASE_NAME ends with "_test".`,
    );
  }
  const testDb = getTestDatabase();
  // TRUNCATE bypasses row-level triggers (including immutability triggers on ledger_entries)
  await testDb.execute(
    sql`TRUNCATE "audit_trail", "migration_logs", "feature_flags", "surcharge_configs", "reconciliation_discrepancies", "reconciliation_runs", "dunning_attempts", "refunds", "charges", "invoice_line_items", "credit_notes", "invoices", "ledger_entries", "ledger_accounts", "credit_balances", "subscriptions", "gateway_assignments", "payment_methods", "customers", "processed_events" CASCADE`,
  );
}

/**
 * Seed the 5 default ledger accounts for e2e tests.
 * Uses ON CONFLICT DO NOTHING for idempotent re-runs.
 */
export async function seedLedgerAccounts(): Promise<void> {
  const testDb = getTestDatabase();
  await testDb
    .insert(schema.ledgerAccounts)
    .values([
      {
        id: "a0000000-0000-4000-a000-000000000001",
        name: "accounts_receivable",
        type: "accounts_receivable",
        description: "Money owed by customers for invoiced services",
      },
      {
        id: "a0000000-0000-4000-a000-000000000002",
        name: "revenue",
        type: "revenue",
        description: "Income earned from billing subscriptions and charges",
      },
      {
        id: "a0000000-0000-4000-a000-000000000003",
        name: "cash",
        type: "cash",
        description: "Payments received from customers via payment gateway",
      },
      {
        id: "a0000000-0000-4000-a000-000000000004",
        name: "refunds",
        type: "refunds",
        description: "Money returned to customers for refunded charges",
      },
      {
        id: "a0000000-0000-4000-a000-000000000005",
        name: "credits",
        type: "credits",
        description: "Credit balance owed to customers for future invoices",
      },
    ])
    .onConflictDoNothing();
}

/**
 * Seed a customer directly into the test database.
 */
export async function seedCustomer(data: {
  id: string;
  monolithCustomerId: string;
  stripeCustomerId?: string;
  name: string;
  email: string;
  status?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const testDb = getTestDatabase();
  await testDb.insert(schema.customers).values({
    id: data.id,
    monolithCustomerId: data.monolithCustomerId,
    stripeCustomerId: data.stripeCustomerId ?? null,
    name: data.name,
    email: data.email,
    status: data.status ?? "active",
    metadata: data.metadata ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Seed a payment method directly into the test database.
 */
export async function seedPaymentMethod(data: {
  id: string;
  customerId: string;
  stripePaymentMethodId: string;
  type: string;
  isDefault?: boolean;
  lastFour?: string;
  brand?: string;
  status?: string;
  fallbackOrder?: number | null;
  gatewayProvider?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const testDb = getTestDatabase();
  await testDb.insert(schema.paymentMethods).values({
    id: data.id,
    customerId: data.customerId,
    stripePaymentMethodId: data.stripePaymentMethodId,
    type: data.type,
    isDefault: data.isDefault ?? false,
    lastFour: data.lastFour ?? null,
    brand: data.brand ?? null,
    bankName: null,
    expiryMonth: null,
    expiryYear: null,
    metadata: data.metadata ?? null,
    fallbackOrder: data.fallbackOrder ?? null,
    gatewayProvider: data.gatewayProvider ?? "stripe",
    status: data.status ?? "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Seed a gateway assignment directly into the test database.
 */
export async function seedGatewayAssignment(data: {
  id: string;
  customerId: string;
  gatewayProvider: string;
  gatewayCustomerId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const testDb = getTestDatabase();
  await testDb.insert(schema.gatewayAssignments).values({
    id: data.id,
    customerId: data.customerId,
    gatewayProvider: data.gatewayProvider,
    gatewayCustomerId: data.gatewayCustomerId,
    metadata: data.metadata ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Seed a subscription directly into the test database.
 */
export async function seedSubscription(data: {
  id: string;
  customerId: string;
  planName: string;
  amountCents: number;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  nextBillingDate: Date | null;
  status?: string;
  currency?: string;
  billingInterval?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const testDb = getTestDatabase();
  await testDb.insert(schema.subscriptions).values({
    id: data.id,
    customerId: data.customerId,
    planName: data.planName,
    status: data.status ?? "pending",
    amountCents: data.amountCents,
    currency: data.currency ?? "usd",
    billingInterval: data.billingInterval ?? "monthly",
    billingPeriodStart: data.billingPeriodStart,
    billingPeriodEnd: data.billingPeriodEnd,
    nextBillingDate: data.nextBillingDate,
    stripeSubscriptionId: null,
    metadata: data.metadata ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Seed an invoice with line items directly into the test database.
 */
export async function seedInvoice(data: {
  id: string;
  customerId: string;
  subscriptionId?: string;
  status?: string;
  totalAmountCents: number;
  currency?: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  dueDate: Date;
  createdAt?: Date;
  lineItems?: Array<{
    id: string;
    type: string;
    description: string;
    amountCents: number;
    quantity?: number;
  }>;
}): Promise<void> {
  const testDb = getTestDatabase();
  const now = data.createdAt ?? new Date();
  await testDb.insert(schema.invoices).values({
    id: data.id,
    customerId: data.customerId,
    subscriptionId: data.subscriptionId ?? null,
    status: data.status ?? "finalized",
    totalAmountCents: data.totalAmountCents,
    currency: data.currency ?? "usd",
    billingPeriodStart: data.billingPeriodStart,
    billingPeriodEnd: data.billingPeriodEnd,
    dueDate: data.dueDate,
    paidAt: null,
    voidedAt: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  });

  if (data.lineItems) {
    for (const item of data.lineItems) {
      await testDb.insert(schema.invoiceLineItems).values({
        id: item.id,
        invoiceId: data.id,
        type: item.type,
        description: item.description,
        amountCents: item.amountCents,
        quantity: item.quantity ?? 1,
        createdAt: now,
      });
    }
  }
}

/**
 * Seed a charge directly into the test database.
 */
export async function seedCharge(data: {
  id: string;
  invoiceId: string;
  customerId: string;
  paymentMethodId: string;
  amountCents: number;
  currency?: string;
  status?: string;
  stripePaymentIntentId?: string;
  idempotencyKey: string;
  failureReason?: string;
  attemptNumber?: number;
  createdAt?: Date;
}): Promise<void> {
  const testDb = getTestDatabase();
  const now = data.createdAt ?? new Date();
  await testDb.insert(schema.charges).values({
    id: data.id,
    invoiceId: data.invoiceId,
    customerId: data.customerId,
    paymentMethodId: data.paymentMethodId,
    amountCents: data.amountCents,
    currency: data.currency ?? "usd",
    status: data.status ?? "pending",
    stripePaymentIntentId: data.stripePaymentIntentId ?? null,
    idempotencyKey: data.idempotencyKey,
    failureReason: data.failureReason ?? null,
    attemptNumber: data.attemptNumber ?? 1,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Seed a dunning attempt directly into the test database.
 */
export async function seedDunningAttempt(data: {
  id: string;
  invoiceId: string;
  chargeId?: string;
  paymentMethodId?: string;
  attemptNumber: number;
  scheduledDate: Date;
  executedAt?: Date;
  status?: string;
  failureReason?: string;
  createdAt?: Date;
}): Promise<void> {
  const testDb = getTestDatabase();
  await testDb.insert(schema.dunningAttempts).values({
    id: data.id,
    invoiceId: data.invoiceId,
    chargeId: data.chargeId ?? null,
    paymentMethodId: data.paymentMethodId ?? null,
    attemptNumber: data.attemptNumber,
    scheduledDate: data.scheduledDate,
    executedAt: data.executedAt ?? null,
    status: data.status ?? "scheduled",
    failureReason: data.failureReason ?? null,
    createdAt: data.createdAt ?? new Date(),
  });
}

/**
 * Seed a credit note directly into the test database.
 */
export async function seedCreditNote(data: {
  id: string;
  customerId: string;
  invoiceId: string;
  amountCents: number;
  currency?: string;
  reason: string;
  status?: string;
  createdBy?: string;
  createdAt?: Date;
}): Promise<void> {
  const testDb = getTestDatabase();
  await testDb.insert(schema.creditNotes).values({
    id: data.id,
    customerId: data.customerId,
    invoiceId: data.invoiceId,
    amountCents: data.amountCents,
    currency: data.currency ?? "usd",
    reason: data.reason,
    status: data.status ?? "issued",
    createdBy: data.createdBy ?? null,
    createdAt: data.createdAt ?? new Date(),
  });
}

/**
 * Seed a credit balance directly into the test database.
 */
export async function seedCreditBalance(data: {
  id: string;
  customerId: string;
  balanceCents: number;
  currency?: string;
}): Promise<void> {
  const testDb = getTestDatabase();
  await testDb.insert(schema.creditBalances).values({
    id: data.id,
    customerId: data.customerId,
    balanceCents: data.balanceCents,
    currency: data.currency ?? "usd",
    updatedAt: new Date(),
  });
}

/**
 * Seed a ledger entry directly into the test database.
 */
export async function seedLedgerEntry(data: {
  id: string;
  debitAccountId: string;
  creditAccountId: string;
  amountCents: number;
  currency?: string;
  referenceType: string;
  referenceId: string;
  description?: string;
  correlationId?: string;
  createdAt?: Date;
}): Promise<void> {
  const testDb = getTestDatabase();
  await testDb.insert(schema.ledgerEntries).values({
    id: data.id,
    debitAccountId: data.debitAccountId,
    creditAccountId: data.creditAccountId,
    amountCents: data.amountCents,
    currency: data.currency ?? "usd",
    referenceType: data.referenceType,
    referenceId: data.referenceId,
    description: data.description ?? null,
    correlationId: data.correlationId ?? null,
    createdAt: data.createdAt ?? new Date(),
  });
}

/**
 * Seed a reconciliation run directly into the test database.
 */
export async function seedReconciliationRun(data: {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  status: "balanced" | "discrepancy_found" | "failed";
  recordsCompared: number;
  totalInternalAmountCents: number;
  totalStripeAmountCents: number;
  errorReason?: string;
  correlationId?: string;
  createdAt?: Date;
}): Promise<void> {
  const testDb = getTestDatabase();
  await testDb.insert(schema.reconciliationRuns).values({
    id: data.id,
    periodStart: data.periodStart,
    periodEnd: data.periodEnd,
    status: data.status,
    recordsCompared: data.recordsCompared,
    totalInternalAmountCents: data.totalInternalAmountCents,
    totalStripeAmountCents: data.totalStripeAmountCents,
    errorReason: data.errorReason ?? null,
    correlationId: data.correlationId ?? null,
    createdAt: data.createdAt ?? new Date(),
  });
}

/**
 * Seed a reconciliation discrepancy directly into the test database.
 */
export async function seedReconciliationDiscrepancy(data: {
  id: string;
  reconciliationRunId: string;
  type: "missing_internal" | "missing_stripe" | "amount_mismatch";
  internalReferenceId?: string;
  stripeTransactionId?: string;
  expectedAmountCents: number;
  actualAmountCents: number;
  differenceCents: number;
  disputeStatus?: string;
  resolvedBy?: string;
  resolutionNotes?: string;
  resolvedAt?: Date;
  createdAt?: Date;
}): Promise<void> {
  const testDb = getTestDatabase();
  await testDb.insert(schema.reconciliationDiscrepancies).values({
    id: data.id,
    reconciliationRunId: data.reconciliationRunId,
    type: data.type,
    internalReferenceId: data.internalReferenceId ?? null,
    stripeTransactionId: data.stripeTransactionId ?? null,
    expectedAmountCents: data.expectedAmountCents,
    actualAmountCents: data.actualAmountCents,
    differenceCents: data.differenceCents,
    disputeStatus: data.disputeStatus ?? "open",
    resolvedBy: data.resolvedBy ?? null,
    resolutionNotes: data.resolutionNotes ?? null,
    resolvedAt: data.resolvedAt ?? null,
    createdAt: data.createdAt ?? new Date(),
  });
}

/**
 * Seed a feature flag directly into the test database.
 */
export async function seedFeatureFlag(data: {
  id: string;
  customerId: string;
  flagName: string;
  enabled: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const testDb = getTestDatabase();
  await testDb.insert(schema.featureFlags).values({
    id: data.id,
    customerId: data.customerId,
    flagName: data.flagName,
    enabled: data.enabled,
    metadata: data.metadata ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Seed a surcharge config directly into the test database.
 */
export async function seedSurchargeConfig(data: {
  id: string;
  customerId: string;
  allowCreditCard?: boolean;
  surchargeType?: "percentage" | "flat_fee" | null;
  surchargeValue?: number | null;
  reason?: string | null;
  notes?: string | null;
  enabledBy?: string | null;
}): Promise<void> {
  const testDb = getTestDatabase();
  await testDb.insert(schema.surchargeConfigs).values({
    id: data.id,
    customerId: data.customerId,
    allowCreditCard: data.allowCreditCard ?? false,
    surchargeType: data.surchargeType ?? null,
    surchargeValue: data.surchargeValue ?? null,
    reason: data.reason ?? null,
    notes: data.notes ?? null,
    enabledBy: data.enabledBy ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Seed a migration log directly into the test database.
 */
export async function seedMigrationLog(data: {
  id: string;
  runId: string;
  scriptName: string;
  monolithCustomerId: string;
  billingCustomerId?: string;
  status: string;
  errorMessage?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  const testDb = getTestDatabase();
  await testDb.insert(schema.migrationLogs).values({
    id: data.id,
    runId: data.runId,
    scriptName: data.scriptName,
    monolithCustomerId: data.monolithCustomerId,
    billingCustomerId: data.billingCustomerId ?? null,
    status: data.status,
    errorMessage: data.errorMessage ?? null,
    details: data.details ?? null,
    createdAt: new Date(),
  });
}

/**
 * Seed a refund directly into the test database.
 */
export async function seedRefund(data: {
  id: string;
  chargeId: string;
  invoiceId: string;
  customerId: string;
  amountCents: number;
  currency?: string;
  status?: string;
  reason?: string;
  idempotencyKey: string;
  gatewayRefundId?: string;
  failureReason?: string;
  createdAt?: Date;
}): Promise<void> {
  const testDb = getTestDatabase();
  const now = data.createdAt ?? new Date();
  await testDb.insert(schema.refunds).values({
    id: data.id,
    chargeId: data.chargeId,
    invoiceId: data.invoiceId,
    customerId: data.customerId,
    amountCents: data.amountCents,
    currency: data.currency ?? "usd",
    status: data.status ?? "pending",
    reason: data.reason ?? null,
    idempotencyKey: data.idempotencyKey,
    gatewayRefundId: data.gatewayRefundId ?? null,
    failureReason: data.failureReason ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Get all audit trail records ordered by created_at descending.
 */
export async function getAuditTrailRecords(): Promise<
  Record<string, unknown>[]
> {
  const testDb = getTestDatabase();
  const result = await testDb.execute(
    sql`SELECT * FROM audit_trail ORDER BY created_at DESC`,
  );
  return result.rows;
}

/**
 * Close the database connection pool.
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
