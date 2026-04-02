import { INestApplication } from "@nestjs/common";
import request from "supertest";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  seedLedgerAccounts,
  seedLedgerEntry,
  seedReconciliationRun,
  seedReconciliationDiscrepancy,
  seedCustomer,
  seedPaymentMethod,
  seedInvoice,
  seedCharge,
  seedDunningAttempt,
  seedSubscription,
} from "./helpers/database";
import { createTestApp } from "./helpers/test-app";
import { signRequest } from "./helpers/hmac-signer";
import type { App } from "supertest/types";

// Ledger account IDs from seedLedgerAccounts()
const AR_ACCOUNT_ID = "a0000000-0000-4000-a000-000000000001";
const REVENUE_ACCOUNT_ID = "a0000000-0000-4000-a000-000000000002";
const CASH_ACCOUNT_ID = "a0000000-0000-4000-a000-000000000003";
const CREDITS_ACCOUNT_ID = "a0000000-0000-4000-a000-000000000005";

// HMAC guard signs path only (no query params), so sign with base path
const REVENUE_PATH = "/v1/reports/revenue";
const RECONCILIATION_PATH = "/v1/reports/reconciliation";
const DUNNING_PATH = "/v1/reports/dunning";
const DASHBOARD_PATH = "/v1/reports/dashboard";

describe("Reporting (e2e)", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    await setupTestDatabase();
    await cleanDatabase();
    await seedLedgerAccounts();
    app = await createTestApp();
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedLedgerAccounts();
  });

  describe("GET /v1/reports/revenue", () => {
    it("should return correct sums for seeded ledger entries", async () => {
      const refId = "a0000000-0000-4000-a000-000000000099";
      const createdAt = new Date("2026-01-15T12:00:00.000Z");

      // Seed: 2 invoices (10000 + 20000 = 30000)
      await seedLedgerEntry({
        id: "e0000000-0000-4000-a000-000000000001",
        debitAccountId: AR_ACCOUNT_ID,
        creditAccountId: REVENUE_ACCOUNT_ID,
        amountCents: 10000,
        referenceType: "invoice",
        referenceId: refId,
        createdAt,
      });
      await seedLedgerEntry({
        id: "e0000000-0000-4000-a000-000000000002",
        debitAccountId: AR_ACCOUNT_ID,
        creditAccountId: REVENUE_ACCOUNT_ID,
        amountCents: 20000,
        referenceType: "invoice",
        referenceId: refId,
        createdAt,
      });

      // Seed: 1 payment (15000)
      await seedLedgerEntry({
        id: "e0000000-0000-4000-a000-000000000003",
        debitAccountId: CASH_ACCOUNT_ID,
        creditAccountId: AR_ACCOUNT_ID,
        amountCents: 15000,
        referenceType: "payment",
        referenceId: refId,
        createdAt,
      });

      // Seed: 1 void (3000)
      await seedLedgerEntry({
        id: "e0000000-0000-4000-a000-000000000004",
        debitAccountId: REVENUE_ACCOUNT_ID,
        creditAccountId: AR_ACCOUNT_ID,
        amountCents: 3000,
        referenceType: "invoice_void",
        referenceId: refId,
        createdAt,
      });

      // Seed: 1 credit note (2000)
      await seedLedgerEntry({
        id: "e0000000-0000-4000-a000-000000000005",
        debitAccountId: CREDITS_ACCOUNT_ID,
        creditAccountId: AR_ACCOUNT_ID,
        amountCents: 2000,
        referenceType: "credit_note",
        referenceId: refId,
        createdAt,
      });

      const headers = signRequest("GET", REVENUE_PATH);

      const response = await request(app.getHttpServer())
        .get(`${REVENUE_PATH}?startDate=2026-01-01&endDate=2026-02-01`)
        .set(headers)
        .expect(200);

      expect(response.body.totalInvoiced).toBe(30000);
      expect(response.body.totalCollected).toBe(15000);
      expect(response.body.totalWriteOff).toBe(3000);
      expect(response.body.totalCreditsIssued).toBe(2000);
      expect(response.body.totalOutstanding).toBe(10000); // 30000 - 15000 - 3000 - 2000
      expect(response.body.netRevenue).toBe(12000); // 15000 - 3000
      expect(response.body.currency).toBe("usd");
      expect(response.body.periodStart).toBe("2026-01-01");
      expect(response.body.periodEnd).toBe("2026-02-01");
    });

    it("should return zeros for empty period", async () => {
      const headers = signRequest("GET", REVENUE_PATH);

      const response = await request(app.getHttpServer())
        .get(`${REVENUE_PATH}?startDate=2099-01-01&endDate=2099-02-01`)
        .set(headers)
        .expect(200);

      expect(response.body.totalInvoiced).toBe(0);
      expect(response.body.totalCollected).toBe(0);
      expect(response.body.totalOutstanding).toBe(0);
      expect(response.body.totalWriteOff).toBe(0);
      expect(response.body.totalCreditsIssued).toBe(0);
      expect(response.body.netRevenue).toBe(0);
    });

    it("should respond within 200ms", async () => {
      const refId = "a0000000-0000-4000-a000-000000000099";
      const createdAt = new Date("2026-01-15T12:00:00.000Z");
      for (let i = 0; i < 10; i++) {
        await seedLedgerEntry({
          id: `e0000000-0000-4000-a000-0000000001${String(i).padStart(2, "0")}`,
          debitAccountId: AR_ACCOUNT_ID,
          creditAccountId: REVENUE_ACCOUNT_ID,
          amountCents: 1000,
          referenceType: "invoice",
          referenceId: refId,
          createdAt,
        });
      }

      const headers = signRequest("GET", REVENUE_PATH);

      const start = Date.now();
      await request(app.getHttpServer())
        .get(`${REVENUE_PATH}?startDate=2026-01-01&endDate=2026-02-01`)
        .set(headers)
        .expect(200);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(200);
    });

    it("should reject missing date parameters", async () => {
      const headers = signRequest("GET", REVENUE_PATH);

      await request(app.getHttpServer())
        .get(REVENUE_PATH)
        .set(headers)
        .expect(400);
    });

    it("should reject inverted date range", async () => {
      const headers = signRequest("GET", REVENUE_PATH);

      await request(app.getHttpServer())
        .get(`${REVENUE_PATH}?startDate=2026-02-01&endDate=2026-01-01`)
        .set(headers)
        .expect(400);
    });

    it("should not count invoice entries with wrong debit account", async () => {
      const refId = "a0000000-0000-4000-a000-000000000099";
      const createdAt = new Date("2026-01-15T12:00:00.000Z");

      // Correct invoice: debit accounts_receivable (should be counted)
      await seedLedgerEntry({
        id: "e0000000-0000-4000-a000-000000000010",
        debitAccountId: AR_ACCOUNT_ID,
        creditAccountId: REVENUE_ACCOUNT_ID,
        amountCents: 10000,
        referenceType: "invoice",
        referenceId: refId,
        createdAt,
      });

      // Wrong invoice: debit cash instead of AR (should NOT be counted)
      await seedLedgerEntry({
        id: "e0000000-0000-4000-a000-000000000011",
        debitAccountId: CASH_ACCOUNT_ID,
        creditAccountId: REVENUE_ACCOUNT_ID,
        amountCents: 5000,
        referenceType: "invoice",
        referenceId: refId,
        createdAt,
      });

      // Correct payment: debit cash (should be counted)
      await seedLedgerEntry({
        id: "e0000000-0000-4000-a000-000000000012",
        debitAccountId: CASH_ACCOUNT_ID,
        creditAccountId: AR_ACCOUNT_ID,
        amountCents: 8000,
        referenceType: "payment",
        referenceId: refId,
        createdAt,
      });

      // Wrong payment: debit AR instead of cash (should NOT be counted)
      await seedLedgerEntry({
        id: "e0000000-0000-4000-a000-000000000013",
        debitAccountId: AR_ACCOUNT_ID,
        creditAccountId: CASH_ACCOUNT_ID,
        amountCents: 3000,
        referenceType: "payment",
        referenceId: refId,
        createdAt,
      });

      const headers = signRequest("GET", REVENUE_PATH);

      const response = await request(app.getHttpServer())
        .get(`${REVENUE_PATH}?startDate=2026-01-01&endDate=2026-02-01`)
        .set(headers)
        .expect(200);

      // Only correctly debited entries should be counted
      expect(response.body.totalInvoiced).toBe(10000);
      expect(response.body.totalCollected).toBe(8000);
    });
  });

  describe("GET /v1/reports/reconciliation", () => {
    const baseRun = {
      periodStart: new Date("2026-01-01T00:00:00.000Z"),
      periodEnd: new Date("2026-01-02T00:00:00.000Z"),
      recordsCompared: 10,
      totalInternalAmountCents: 50000,
      totalStripeAmountCents: 50000,
    };

    it("should return paginated list of reconciliation runs", async () => {
      await seedReconciliationRun({
        id: "b0000000-0000-4000-a000-000000000001",
        ...baseRun,
        status: "balanced",
      });
      await seedReconciliationRun({
        id: "b0000000-0000-4000-a000-000000000002",
        ...baseRun,
        periodStart: new Date("2026-01-02T00:00:00.000Z"),
        periodEnd: new Date("2026-01-03T00:00:00.000Z"),
        status: "discrepancy_found",
      });

      const headers = signRequest("GET", RECONCILIATION_PATH);

      const response = await request(app.getHttpServer())
        .get(RECONCILIATION_PATH)
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.hasMore).toBe(false);
    });

    it("should filter by status", async () => {
      await seedReconciliationRun({
        id: "b0000000-0000-4000-a000-000000000003",
        ...baseRun,
        status: "balanced",
      });
      await seedReconciliationRun({
        id: "b0000000-0000-4000-a000-000000000004",
        ...baseRun,
        periodStart: new Date("2026-01-02T00:00:00.000Z"),
        periodEnd: new Date("2026-01-03T00:00:00.000Z"),
        status: "discrepancy_found",
      });

      const headers = signRequest("GET", RECONCILIATION_PATH);

      const response = await request(app.getHttpServer())
        .get(`${RECONCILIATION_PATH}?status=balanced`)
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].status).toBe("balanced");
    });

    it("should filter by date range", async () => {
      await seedReconciliationRun({
        id: "b0000000-0000-4000-a000-000000000005",
        ...baseRun,
        periodStart: new Date("2026-01-01T00:00:00.000Z"),
        periodEnd: new Date("2026-01-02T00:00:00.000Z"),
        status: "balanced",
      });
      await seedReconciliationRun({
        id: "b0000000-0000-4000-a000-000000000006",
        ...baseRun,
        periodStart: new Date("2026-03-01T00:00:00.000Z"),
        periodEnd: new Date("2026-03-02T00:00:00.000Z"),
        status: "balanced",
      });

      const headers = signRequest("GET", RECONCILIATION_PATH);

      const response = await request(app.getHttpServer())
        .get(`${RECONCILIATION_PATH}?startDate=2026-01-01&endDate=2026-02-01`)
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
    });

    it("should paginate with cursor when >20 runs", async () => {
      // Seed 25 runs with UUIDs that sort descending
      for (let i = 1; i <= 25; i++) {
        const hex = i.toString(16).padStart(2, "0");
        await seedReconciliationRun({
          id: `b0000000-0000-4000-a000-0000000000${hex}`,
          ...baseRun,
          periodStart: new Date(
            `2026-01-${String(i).padStart(2, "0")}T00:00:00.000Z`,
          ),
          periodEnd: new Date(
            `2026-01-${String(i + 1 > 28 ? 28 : i + 1).padStart(2, "0")}T00:00:00.000Z`,
          ),
          status: "balanced",
        });
      }

      const headers = signRequest("GET", RECONCILIATION_PATH);

      const response = await request(app.getHttpServer())
        .get(`${RECONCILIATION_PATH}?limit=20`)
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(20);
      expect(response.body.hasMore).toBe(true);
      expect(response.body.cursor).toBeDefined();

      // Fetch next page using cursor
      const cursor = response.body.cursor as string;
      const nextHeaders = signRequest("GET", RECONCILIATION_PATH);

      const nextResponse = await request(app.getHttpServer())
        .get(`${RECONCILIATION_PATH}?limit=20&cursor=${cursor}`)
        .set(nextHeaders)
        .expect(200);

      expect(nextResponse.body.data).toHaveLength(5);
      expect(nextResponse.body.hasMore).toBe(false);
    });

    it("should include discrepancies for runs with discrepancy_found status", async () => {
      await seedReconciliationRun({
        id: "b0000000-0000-4000-a000-000000000030",
        ...baseRun,
        status: "discrepancy_found",
        totalStripeAmountCents: 45000,
      });

      await seedReconciliationDiscrepancy({
        id: "d0000000-0000-4000-a000-000000000001",
        reconciliationRunId: "b0000000-0000-4000-a000-000000000030",
        type: "amount_mismatch",
        internalReferenceId: "int-ref-1",
        stripeTransactionId: "txn_test_1",
        expectedAmountCents: 5000,
        actualAmountCents: 4500,
        differenceCents: 500,
      });

      const headers = signRequest("GET", RECONCILIATION_PATH);

      const response = await request(app.getHttpServer())
        .get(RECONCILIATION_PATH)
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      const run = response.body.data[0];
      expect(run.status).toBe("discrepancy_found");
      expect(run.discrepancies).toHaveLength(1);
      expect(run.discrepancies[0].type).toBe("amount_mismatch");
      expect(run.discrepancies[0].expectedAmountCents).toBe(5000);
      expect(run.discrepancies[0].actualAmountCents).toBe(4500);
      expect(run.discrepancies[0].differenceCents).toBe(500);
    });
  });

  describe("GET /v1/reports/dunning", () => {
    // FK chain: customer → invoice → dunning_attempt
    const customerId = "c0000000-0000-4000-a000-000000000001";
    const paymentMethodId = "d0000000-0000-4000-a000-000000000001";
    const invoiceId1 = "f0000000-0000-4000-a000-000000000001";
    const invoiceId2 = "f0000000-0000-4000-a000-000000000002";
    const invoiceId3 = "f0000000-0000-4000-a000-000000000003";

    async function seedDunningFKChain(): Promise<void> {
      await seedCustomer({
        id: customerId,
        monolithCustomerId: "mono-dunning-1",
        name: "Dunning Test Customer",
        email: "dunning@test.com",
      });
      await seedPaymentMethod({
        id: paymentMethodId,
        customerId,
        stripePaymentMethodId: "pm_dunning_test",
        type: "card",
      });

      const now = new Date();
      const periodStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      const periodEnd = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      );
      const dueDate = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15),
      );

      for (const invId of [invoiceId1, invoiceId2, invoiceId3]) {
        await seedInvoice({
          id: invId,
          customerId,
          totalAmountCents: 10000,
          billingPeriodStart: periodStart,
          billingPeriodEnd: periodEnd,
          dueDate,
        });
      }
    }

    it("should return correct aggregation fields for seeded dunning attempts", async () => {
      await seedDunningFKChain();

      const now = new Date();
      // Invoice 1: recovered on attempt 1
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000001",
        invoiceId: invoiceId1,
        attemptNumber: 1,
        scheduledDate: now,
        executedAt: now,
        status: "succeeded",
      });
      // Invoice 2: recovered on attempt 2 (first attempt failed)
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000002",
        invoiceId: invoiceId2,
        attemptNumber: 1,
        scheduledDate: now,
        executedAt: now,
        status: "failed",
        failureReason: "card_declined",
      });
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000003",
        invoiceId: invoiceId2,
        attemptNumber: 2,
        scheduledDate: now,
        executedAt: now,
        status: "succeeded",
      });
      // Invoice 3: escalated (all failed, no scheduled)
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000004",
        invoiceId: invoiceId3,
        attemptNumber: 1,
        scheduledDate: now,
        executedAt: now,
        status: "failed",
        failureReason: "card_declined",
      });
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000005",
        invoiceId: invoiceId3,
        attemptNumber: 2,
        scheduledDate: now,
        executedAt: now,
        status: "failed",
        failureReason: "insufficient_funds",
      });

      const headers = signRequest("GET", DUNNING_PATH);

      // Use current month range (default behavior)
      const response = await request(app.getHttpServer())
        .get(DUNNING_PATH)
        .set(headers)
        .expect(200);

      const body = response.body;
      expect(body.totalInvoicesInDunning).toBe(3);
      expect(body.totalRecovered.count).toBe(2);
      expect(body.totalRecovered.amountCents).toBe(20000); // 2 invoices * 10000
      expect(body.totalEscalated.count).toBe(1);
      expect(body.totalEscalated.amountCents).toBe(10000);
      expect(body.recoveryRate).toBeCloseTo(66.67, 1);
      expect(body.averageRecoveryAttempts).toBe(1.5); // (1 + 2) / 2
      expect(body.recoveryByAttempt).toHaveLength(2);
      expect(body.recoveryByAttempt[0]).toEqual({ attemptNumber: 1, count: 1 });
      expect(body.recoveryByAttempt[1]).toEqual({ attemptNumber: 2, count: 1 });
    });

    it("should return zeros for empty period", async () => {
      const headers = signRequest("GET", DUNNING_PATH);

      const response = await request(app.getHttpServer())
        .get(`${DUNNING_PATH}?startDate=2099-01-01&endDate=2099-02-01`)
        .set(headers)
        .expect(200);

      expect(response.body.totalInvoicesInDunning).toBe(0);
      expect(response.body.totalRecovered.count).toBe(0);
      expect(response.body.totalRecovered.amountCents).toBe(0);
      expect(response.body.totalEscalated.count).toBe(0);
      expect(response.body.totalEscalated.amountCents).toBe(0);
      expect(response.body.recoveryRate).toBe(0);
      expect(response.body.averageRecoveryAttempts).toBe(0);
      expect(response.body.recoveryByAttempt).toEqual([]);
    });

    it("should filter by date range — only matching attempts included", async () => {
      await seedDunningFKChain();

      // Seed a dunning attempt in Jan 2025 (outside current month)
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000010",
        invoiceId: invoiceId1,
        attemptNumber: 1,
        scheduledDate: new Date("2025-01-15T00:00:00Z"),
        executedAt: new Date("2025-01-15T00:00:00Z"),
        status: "succeeded",
        createdAt: new Date("2025-01-15T00:00:00Z"),
      });

      const headers = signRequest("GET", DUNNING_PATH);

      // Query for Jan 2025 range
      const response = await request(app.getHttpServer())
        .get(`${DUNNING_PATH}?startDate=2025-01-01&endDate=2025-02-01`)
        .set(headers)
        .expect(200);

      expect(response.body.totalInvoicesInDunning).toBe(1);
      expect(response.body.totalRecovered.count).toBe(1);
    });

    it("should default to current month when no dates provided", async () => {
      await seedDunningFKChain();

      const now = new Date();
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000020",
        invoiceId: invoiceId1,
        attemptNumber: 1,
        scheduledDate: now,
        executedAt: now,
        status: "succeeded",
      });

      const headers = signRequest("GET", DUNNING_PATH);

      const response = await request(app.getHttpServer())
        .get(DUNNING_PATH)
        .set(headers)
        .expect(200);

      expect(response.body.totalInvoicesInDunning).toBeGreaterThanOrEqual(1);
      // Verify period boundaries are current month
      const expectedStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      expect(response.body.periodStart).toBe(expectedStart.toISOString());
    });

    it("should reject inverted date range with 400", async () => {
      const headers = signRequest("GET", DUNNING_PATH);

      await request(app.getHttpServer())
        .get(`${DUNNING_PATH}?startDate=2026-02-01&endDate=2026-01-01`)
        .set(headers)
        .expect(400);
    });

    it("should reject partial date parameters — only startDate provided", async () => {
      const headers = signRequest("GET", DUNNING_PATH);

      await request(app.getHttpServer())
        .get(`${DUNNING_PATH}?startDate=2026-01-01`)
        .set(headers)
        .expect(400);
    });

    it("should reject partial date parameters — only endDate provided", async () => {
      const headers = signRequest("GET", DUNNING_PATH);

      await request(app.getHttpServer())
        .get(`${DUNNING_PATH}?endDate=2026-02-01`)
        .set(headers)
        .expect(400);
    });

    it("should return recoveryByAttempt breakdown grouped by attempt number", async () => {
      await seedDunningFKChain();

      const now = new Date();
      // Invoice 1: recovered on attempt 1
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000030",
        invoiceId: invoiceId1,
        attemptNumber: 1,
        scheduledDate: now,
        executedAt: now,
        status: "succeeded",
      });
      // Invoice 2: recovered on attempt 3
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000031",
        invoiceId: invoiceId2,
        attemptNumber: 1,
        scheduledDate: now,
        executedAt: now,
        status: "failed",
      });
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000032",
        invoiceId: invoiceId2,
        attemptNumber: 2,
        scheduledDate: now,
        executedAt: now,
        status: "failed",
      });
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000033",
        invoiceId: invoiceId2,
        attemptNumber: 3,
        scheduledDate: now,
        executedAt: now,
        status: "succeeded",
      });

      const headers = signRequest("GET", DUNNING_PATH);
      const response = await request(app.getHttpServer())
        .get(DUNNING_PATH)
        .set(headers)
        .expect(200);

      expect(response.body.recoveryByAttempt).toEqual([
        { attemptNumber: 1, count: 1 },
        { attemptNumber: 3, count: 1 },
      ]);
    });

    it("should respond within 200ms", async () => {
      const headers = signRequest("GET", DUNNING_PATH);
      const start = Date.now();
      await request(app.getHttpServer())
        .get(DUNNING_PATH)
        .set(headers)
        .expect(200);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe("GET /v1/reports/dashboard", () => {
    const customerId = "c0000000-0000-4000-a000-000000000002";
    const paymentMethodId = "d0000000-0000-4000-a000-000000000002";

    async function seedDashboardBaseData(): Promise<void> {
      await seedCustomer({
        id: customerId,
        monolithCustomerId: "mono-dash-1",
        name: "Dashboard Test Customer",
        email: "dash@test.com",
      });
      await seedPaymentMethod({
        id: paymentMethodId,
        customerId,
        stripePaymentMethodId: "pm_dash_test",
        type: "card",
      });
    }

    it("should return all metrics with seeded data", async () => {
      await seedDashboardBaseData();

      const now = new Date();
      const periodStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      const periodEnd = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      );
      const dueDate = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15),
      );

      // Seed 2 active subscriptions
      await seedSubscription({
        id: "50000000-0000-4000-a000-000000000001",
        customerId,
        planName: "basic",
        amountCents: 5000,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        nextBillingDate: periodEnd,
        status: "active",
      });
      await seedSubscription({
        id: "50000000-0000-4000-a000-000000000002",
        customerId,
        planName: "premium",
        amountCents: 15000,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        nextBillingDate: periodEnd,
        status: "active",
      });

      // Seed ledger entries for current month
      const refId = "a0000000-0000-4000-a000-000000000099";
      const createdAt = new Date();
      await seedLedgerEntry({
        id: "e0000000-0000-4000-a000-000000000020",
        debitAccountId: AR_ACCOUNT_ID,
        creditAccountId: REVENUE_ACCOUNT_ID,
        amountCents: 20000,
        referenceType: "invoice",
        referenceId: refId,
        createdAt,
      });
      await seedLedgerEntry({
        id: "e0000000-0000-4000-a000-000000000021",
        debitAccountId: CASH_ACCOUNT_ID,
        creditAccountId: AR_ACCOUNT_ID,
        amountCents: 15000,
        referenceType: "payment",
        referenceId: refId,
        createdAt,
      });
      // Seed write-off and credit entries to verify full outstanding formula
      await seedLedgerEntry({
        id: "e0000000-0000-4000-a000-000000000022",
        debitAccountId: REVENUE_ACCOUNT_ID,
        creditAccountId: AR_ACCOUNT_ID,
        amountCents: 2000,
        referenceType: "invoice_void",
        referenceId: refId,
        createdAt,
      });
      await seedLedgerEntry({
        id: "e0000000-0000-4000-a000-000000000023",
        debitAccountId: CREDITS_ACCOUNT_ID,
        creditAccountId: AR_ACCOUNT_ID,
        amountCents: 1000,
        referenceType: "credit_note",
        referenceId: refId,
        createdAt,
      });

      // Seed charges in current month
      const invId = "f0000000-0000-4000-a000-000000000010";
      await seedInvoice({
        id: invId,
        customerId,
        totalAmountCents: 20000,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        dueDate,
      });
      await seedCharge({
        id: "c1000000-0000-4000-a000-000000000001",
        invoiceId: invId,
        customerId,
        paymentMethodId,
        amountCents: 20000,
        status: "succeeded",
        idempotencyKey: "idem-dash-1",
      });
      await seedCharge({
        id: "c1000000-0000-4000-a000-000000000002",
        invoiceId: invId,
        customerId,
        paymentMethodId,
        amountCents: 20000,
        status: "failed",
        idempotencyKey: "idem-dash-2",
        failureReason: "card_declined",
      });

      // Seed dunning attempt for current month
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000050",
        invoiceId: invId,
        attemptNumber: 1,
        scheduledDate: now,
        executedAt: now,
        status: "succeeded",
      });

      // Seed reconciliation run
      await seedReconciliationRun({
        id: "b0000000-0000-4000-a000-000000000050",
        periodStart,
        periodEnd,
        status: "balanced",
        recordsCompared: 5,
        totalInternalAmountCents: 20000,
        totalStripeAmountCents: 20000,
      });

      const headers = signRequest("GET", DASHBOARD_PATH);
      const response = await request(app.getHttpServer())
        .get(DASHBOARD_PATH)
        .set(headers)
        .expect(200);

      const body = response.body;
      expect(body.activeSubscriptions).toBe(2);
      expect(body.monthlyRecurringRevenue).toBe(20000); // 5000 + 15000
      expect(body.currentMonthInvoiced).toBe(20000);
      expect(body.currentMonthCollected).toBe(15000);
      // outstanding = 20000 - 15000 - 2000 (write-off) - 1000 (credits) = 2000
      expect(body.currentMonthOutstanding).toBe(2000);
      expect(body.paymentSuccessRate).toBe(50); // 1/2 * 100
      expect(body.dunningRecoveryRate).toBe(100); // 1/1 * 100
      expect(body.reconciliationStatus).toBe("balanced");
      expect(body.currency).toBe("usd");
    });

    it("should return zeros and 'none' for fresh system", async () => {
      const headers = signRequest("GET", DASHBOARD_PATH);
      const response = await request(app.getHttpServer())
        .get(DASHBOARD_PATH)
        .set(headers)
        .expect(200);

      const body = response.body;
      expect(body.activeSubscriptions).toBe(0);
      expect(body.monthlyRecurringRevenue).toBe(0);
      expect(body.currentMonthInvoiced).toBe(0);
      expect(body.currentMonthCollected).toBe(0);
      expect(body.currentMonthOutstanding).toBe(0);
      expect(body.paymentSuccessRate).toBe(0);
      expect(body.dunningRecoveryRate).toBe(0);
      expect(body.reconciliationStatus).toBe("none");
    });

    it("should return latest reconciliation status", async () => {
      const now = new Date();
      await seedReconciliationRun({
        id: "b0000000-0000-4000-a000-000000000060",
        periodStart: new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
        ),
        periodEnd: new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2),
        ),
        status: "balanced",
        recordsCompared: 5,
        totalInternalAmountCents: 10000,
        totalStripeAmountCents: 10000,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      });
      await seedReconciliationRun({
        id: "b0000000-0000-4000-a000-000000000061",
        periodStart: new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2),
        ),
        periodEnd: new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 3),
        ),
        status: "discrepancy_found",
        recordsCompared: 5,
        totalInternalAmountCents: 10000,
        totalStripeAmountCents: 9000,
        createdAt: new Date("2026-02-01T00:00:00Z"),
      });

      const headers = signRequest("GET", DASHBOARD_PATH);
      const response = await request(app.getHttpServer())
        .get(DASHBOARD_PATH)
        .set(headers)
        .expect(200);

      // Latest run (by created_at DESC) is discrepancy_found
      expect(response.body.reconciliationStatus).toBe("discrepancy_found");
    });

    it("should respond within 200ms", async () => {
      const headers = signRequest("GET", DASHBOARD_PATH);
      const start = Date.now();
      await request(app.getHttpServer())
        .get(DASHBOARD_PATH)
        .set(headers)
        .expect(200);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(200);
    });
  });
});
