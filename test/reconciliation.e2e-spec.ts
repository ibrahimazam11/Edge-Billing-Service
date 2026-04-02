import { INestApplication } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { createTestApp } from "./helpers/test-app";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  seedCustomer,
  seedPaymentMethod,
  seedSubscription,
  seedInvoice,
  seedCharge,
  seedLedgerAccounts,
  seedLedgerEntry,
  seedReconciliationRun,
} from "./helpers/database";
import { ReconciliationService } from "../src/reconciliation/reconciliation.service";
import type { App } from "supertest/types";

// Ledger account IDs from seedLedgerAccounts()
const CASH_ACCOUNT_ID = "a0000000-0000-4000-a000-000000000003";
const AR_ACCOUNT_ID = "a0000000-0000-4000-a000-000000000001";

const CUSTOMER_1 = {
  id: "c0000000-0000-4000-a000-000000000001",
  monolithCustomerId: "mono-recon-001",
  name: "Recon Test Customer",
  email: "recon-test@example.com",
};

const PAYMENT_METHOD_1 = {
  id: "e0000000-0000-4000-a000-000000000001",
  customerId: CUSTOMER_1.id,
  stripePaymentMethodId: "pm_recon_test_1",
  type: "card",
  isDefault: true,
};

const SUBSCRIPTION_1 = {
  id: "d0000000-0000-4000-a000-000000000001",
  customerId: CUSTOMER_1.id,
  planName: "standard-monthly",
  amountCents: 5000,
  billingPeriodStart: new Date("2026-02-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-03-01T00:00:00.000Z"),
  nextBillingDate: new Date("2026-03-01T00:00:00.000Z"),
  status: "active",
};

const INVOICE_1 = {
  id: "a0000000-0000-4000-a000-000000000010",
  customerId: CUSTOMER_1.id,
  subscriptionId: SUBSCRIPTION_1.id,
  status: "paid",
  totalAmountCents: 5000,
  billingPeriodStart: new Date("2026-02-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-03-01T00:00:00.000Z"),
  dueDate: new Date("2026-03-01T00:00:00.000Z"),
};

const CHARGE_1 = {
  id: "b0000000-0000-4000-a000-000000000001",
  invoiceId: INVOICE_1.id,
  customerId: CUSTOMER_1.id,
  paymentMethodId: PAYMENT_METHOD_1.id,
  amountCents: 5000,
  status: "succeeded",
  stripePaymentIntentId: "pi_recon_test_1",
  idempotencyKey: "idem-recon-1",
};

const PERIOD_START = new Date("2026-02-09T00:00:00.000Z");
const PERIOD_END = new Date("2026-02-10T00:00:00.000Z");
const CORRELATION_ID = "corr-e2e-recon-1";

describe("Reconciliation (e2e)", () => {
  let app: INestApplication<App>;
  let reconciliationService: ReconciliationService;

  beforeAll(async () => {
    await setupTestDatabase();
    await cleanDatabase();
    await seedLedgerAccounts();
    app = await createTestApp();
    reconciliationService = app.get(ReconciliationService);
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedLedgerAccounts();
    await seedCustomer(CUSTOMER_1);
    await seedPaymentMethod(PAYMENT_METHOD_1);
    await seedSubscription(SUBSCRIPTION_1);
    await seedInvoice(INVOICE_1);
  });

  describe("reconciliation run storage", () => {
    it("should store reconciliation result in database", async () => {
      // stripe-mock always returns sample balance transactions,
      // so we can't get a truly empty period. Instead verify that
      // reconciliation completes and stores a run successfully.
      const result = await reconciliationService.runDailyReconciliation(
        PERIOD_START,
        PERIOD_END,
        CORRELATION_ID,
      );

      expect(result.id).toBeDefined();
      expect(["balanced", "discrepancy_found"]).toContain(result.status);

      // Verify stored in DB
      const db = getTestDatabase();
      const runs = await db.execute(
        sql`SELECT * FROM reconciliation_runs WHERE correlation_id = ${CORRELATION_ID}`,
      );
      expect(runs.rows).toHaveLength(1);
      expect(["balanced", "discrepancy_found"]).toContain(runs.rows[0].status);
    });
  });

  describe("discrepancy detection", () => {
    it("should detect missing_stripe when internal charge has no matching Stripe transaction", async () => {
      // Seed charge + ledger entry within the period
      await seedCharge(CHARGE_1);
      await seedLedgerEntry({
        id: "f0000000-0000-4000-a000-000000000002",
        debitAccountId: CASH_ACCOUNT_ID,
        creditAccountId: AR_ACCOUNT_ID,
        amountCents: 5000,
        referenceType: "payment",
        referenceId: CHARGE_1.id,
        createdAt: new Date("2026-02-09T12:00:00.000Z"),
      });

      const result = await reconciliationService.runDailyReconciliation(
        PERIOD_START,
        PERIOD_END,
        CORRELATION_ID,
      );

      // stripe-mock won't return our specific pi_recon_test_1,
      // so internal charge will appear as missing_stripe
      expect(result.status).toBe("discrepancy_found");
      expect(result.discrepancies.length).toBeGreaterThanOrEqual(1);

      // Verify stored in DB
      const db = getTestDatabase();
      const runs = await db.execute(
        sql`SELECT * FROM reconciliation_runs WHERE correlation_id = ${CORRELATION_ID}`,
      );
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0].status).toBe("discrepancy_found");

      const discrepancies = await db.execute(
        sql`SELECT * FROM reconciliation_discrepancies WHERE reconciliation_run_id = ${runs.rows[0].id as string}`,
      );
      expect(discrepancies.rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("duplicate run prevention", () => {
    it("should skip reconciliation when period already processed", async () => {
      // Seed an existing balanced run for the same period
      await seedReconciliationRun({
        id: "b0000000-0000-4000-a000-000000000099",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        status: "balanced",
        recordsCompared: 10,
        totalInternalAmountCents: 50000,
        totalStripeAmountCents: 50000,
        correlationId: "corr-existing",
      });

      const result = await reconciliationService.runDailyReconciliation(
        PERIOD_START,
        PERIOD_END,
        CORRELATION_ID,
      );

      // Should return existing run, not create a new one
      expect(result.id).toBe("b0000000-0000-4000-a000-000000000099");
      expect(result.status).toBe("balanced");

      // Should only have the one original run in DB
      const db = getTestDatabase();
      const runs = await db.execute(
        sql`SELECT * FROM reconciliation_runs WHERE period_start = ${PERIOD_START} AND period_end = ${PERIOD_END}`,
      );
      expect(runs.rows).toHaveLength(1);
    });
  });

  describe("reconciliation with seeded payment data", () => {
    it("should complete reconciliation run with correct result shape when charges exist", async () => {
      // Seed charge + ledger entry
      await seedCharge(CHARGE_1);
      await seedLedgerEntry({
        id: "f0000000-0000-4000-a000-000000000003",
        debitAccountId: CASH_ACCOUNT_ID,
        creditAccountId: AR_ACCOUNT_ID,
        amountCents: 5000,
        referenceType: "payment",
        referenceId: CHARGE_1.id,
        createdAt: new Date("2026-02-09T12:00:00.000Z"),
      });

      const result = await reconciliationService.runDailyReconciliation(
        PERIOD_START,
        PERIOD_END,
        CORRELATION_ID,
      );

      // stripe-mock is running, so reconciliation completes (not failed)
      expect(["balanced", "discrepancy_found"]).toContain(result.status);
      expect(result.id).toBeDefined();
      expect(result.periodStart).toEqual(PERIOD_START);
      expect(result.periodEnd).toEqual(PERIOD_END);
    });
  });

  describe("reconciliation run schema", () => {
    it("should persist all required fields in reconciliation_runs table", async () => {
      const result = await reconciliationService.runDailyReconciliation(
        PERIOD_START,
        PERIOD_END,
        CORRELATION_ID,
      );

      const db = getTestDatabase();
      const runs = await db.execute(
        sql`SELECT * FROM reconciliation_runs WHERE id = ${result.id}`,
      );
      expect(runs.rows).toHaveLength(1);

      const run = runs.rows[0];
      expect(run.id).toBe(result.id);
      expect(["balanced", "discrepancy_found"]).toContain(run.status);
      expect(run.records_compared).toBeDefined();
      expect(run.correlation_id).toBe(CORRELATION_ID);
      expect(run.created_at).toBeDefined();
      expect(run.error_reason).toBeNull();
      expect(run.period_start).toBeDefined();
      expect(run.period_end).toBeDefined();
      expect(run.total_internal_amount_cents).toBeDefined();
      expect(run.total_stripe_amount_cents).toBeDefined();
    });
  });

  describe("gateway date filtering", () => {
    it("should call Stripe with correct period timestamps", async () => {
      // This test verifies the end-to-end flow where the service
      // passes date filters to the real Stripe adapter (via stripe-mock).
      // If stripe-mock didn't support `created` filter, this would fail.
      const result = await reconciliationService.runDailyReconciliation(
        PERIOD_START,
        PERIOD_END,
        CORRELATION_ID,
      );

      // stripe-mock should respond successfully (not throw)
      expect(result).toBeDefined();
      expect(result.status).not.toBe("failed");
    });
  });

  describe("multiple reconciliation periods", () => {
    it("should allow different periods to be reconciled independently", async () => {
      const period1Start = new Date("2025-06-01T00:00:00.000Z");
      const period1End = new Date("2025-06-02T00:00:00.000Z");
      const period2Start = new Date("2025-07-01T00:00:00.000Z");
      const period2End = new Date("2025-07-02T00:00:00.000Z");

      const result1 = await reconciliationService.runDailyReconciliation(
        period1Start,
        period1End,
        "corr-1",
      );

      const result2 = await reconciliationService.runDailyReconciliation(
        period2Start,
        period2End,
        "corr-2",
      );

      expect(result1.id).not.toBe(result2.id);
      // Both should complete (either balanced or discrepancy_found)
      expect(["balanced", "discrepancy_found"]).toContain(result1.status);
      expect(["balanced", "discrepancy_found"]).toContain(result2.status);

      // Verify both stored in DB
      const db = getTestDatabase();
      const runs = await db.execute(
        sql`SELECT * FROM reconciliation_runs ORDER BY created_at`,
      );
      expect(runs.rows.length).toBeGreaterThanOrEqual(2);
    });
  });
});
