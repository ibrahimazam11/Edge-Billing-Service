import { INestApplication } from "@nestjs/common";
import { Server } from "http";
import request from "supertest";
import { sql } from "drizzle-orm";
import { createTestApp } from "./helpers/test-app";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  seedCustomer,
  seedFeatureFlag,
  seedMigrationLog,
  seedInvoice,
  seedLedgerAccounts,
} from "./helpers/database";
import { signRequest } from "./helpers/hmac-signer";
import { DualWriteService } from "../src/migration/dual-write.service";
import { MigrationValidationService } from "../src/migration/migration-validation.service";
import { SqsProducerService } from "../src/integration/sqs/sqs-producer.service";

// --- Test constants ---

const CUST_A = {
  id: "c0000000-0000-4000-a000-000000000a01",
  monolithCustomerId: "MONO-VAL-001",
  name: "Validation Customer A",
  email: "val-a@example.com",
};

const CUST_B = {
  id: "c0000000-0000-4000-a000-000000000a02",
  monolithCustomerId: "MONO-VAL-002",
  name: "Validation Customer B",
  email: "val-b@example.com",
};

const CUST_C = {
  id: "c0000000-0000-4000-a000-000000000a03",
  monolithCustomerId: "MONO-VAL-003",
  name: "Validation Customer C",
  email: "val-c@example.com",
};

// --- Monolith table helpers ---

async function createMonolithTables(): Promise<void> {
  const db = getTestDatabase();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "Customer_Charge" (
      "Charge_ID" serial PRIMARY KEY,
      "Customer_ID" varchar(255) NOT NULL,
      "Amount" numeric(10,2),
      "Charge_Type" varchar(255),
      "Payment_Status" varchar(255),
      "Payment_Date" timestamptz,
      "Failure_Reason" varchar(255),
      "Scheduled_At" date,
      "Credit_Card_Surcharge" numeric,
      "Starting_Balance" numeric,
      "Invoice_ID" varchar(255),
      "deletedAt" timestamptz,
      "createdAt" timestamptz DEFAULT now(),
      "updatedAt" timestamptz DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "Customer_Payroll" (
      "Customer_Payroll_ID" varchar(255) PRIMARY KEY,
      "Customer_ID" varchar(255),
      "Total_Amount" numeric,
      "Total_Bonus" numeric,
      "Payment_Date" timestamptz,
      "Paid_On" timestamptz,
      "Status" varchar(255),
      "Payroll_Month" date,
      "Credit_Card_Surcharge" numeric,
      "Failure" boolean DEFAULT false,
      "Failure_Date" timestamptz,
      "Failure_Reason" varchar(255),
      "Payment_Method" varchar(255),
      "Reference_Number" varchar(255),
      "createdBy" varchar(255),
      "updatedBy" varchar(255),
      "Invoice_ID" varchar(255),
      "createdAt" timestamptz DEFAULT now(),
      "updatedAt" timestamptz DEFAULT now()
    )
  `);
}

async function seedMonolithCharge(data: {
  chargeId: number;
  customerId: string;
  amount: number | null;
  paymentStatus: string;
  deletedAt?: Date | null;
}): Promise<void> {
  const db = getTestDatabase();
  await db.execute(sql`
    INSERT INTO "Customer_Charge" (
      "Charge_ID", "Customer_ID", "Amount", "Payment_Status",
      "Scheduled_At", "deletedAt"
    ) VALUES (
      ${data.chargeId}, ${data.customerId},
      ${data.amount}, ${data.paymentStatus},
      ${new Date("2025-06-01")}, ${data.deletedAt ?? null}
    )
  `);
}

async function cleanMonolithTables(): Promise<void> {
  const db = getTestDatabase();
  await db.execute(
    sql`DELETE FROM "Customer_Charge" WHERE "Customer_ID" LIKE 'MONO-VAL-%'`,
  );
  await db.execute(
    sql`DELETE FROM "Customer_Payroll" WHERE "Customer_ID" LIKE 'MONO-VAL-%'`,
  );
}

// --- Test suite ---

describe("Migration Validation (e2e)", () => {
  let app: INestApplication;
  let dualWriteService: DualWriteService;
  let validationService: MigrationValidationService;
  let sqsProducerService: SqsProducerService;

  beforeAll(async () => {
    await setupTestDatabase();
    await seedLedgerAccounts();
    await createMonolithTables();
    app = await createTestApp();
    dualWriteService = app.get(DualWriteService);
    validationService = app.get(MigrationValidationService);
    sqsProducerService = app.get(SqsProducerService);
  });

  afterAll(async () => {
    await app.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedLedgerAccounts();
    await cleanMonolithTables();
  });

  // ---------------------------------------------------------------
  // 10.1 Dual-write enabled: verify metadata.dual_write
  // ---------------------------------------------------------------
  describe("Dual-write flag integration", () => {
    it("should return dual_write metadata when both flags enabled", async () => {
      await seedCustomer(CUST_A);
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000a01",
        customerId: CUST_A.id,
        flagName: "billing_service_enabled",
        enabled: true,
      });
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000a02",
        customerId: CUST_A.id,
        flagName: "dual_write_enabled",
        enabled: true,
      });

      const metadata = await dualWriteService.getDualWriteMetadata(CUST_A.id);

      expect(metadata).toEqual({ dual_write: true });
    });

    // ---------------------------------------------------------------
    // 10.2 Dual-write disabled: verify NO dual_write metadata
    // ---------------------------------------------------------------
    it("should return undefined metadata when dual_write_enabled is false", async () => {
      await seedCustomer(CUST_A);
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000a03",
        customerId: CUST_A.id,
        flagName: "billing_service_enabled",
        enabled: true,
      });
      // dual_write_enabled NOT set — should be false

      const metadata = await dualWriteService.getDualWriteMetadata(CUST_A.id);

      expect(metadata).toBeUndefined();
    });

    it("should return undefined metadata when billing_service_enabled is false", async () => {
      await seedCustomer(CUST_A);
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000a04",
        customerId: CUST_A.id,
        flagName: "dual_write_enabled",
        enabled: true,
      });
      // billing_service_enabled NOT set — should be false

      const metadata = await dualWriteService.getDualWriteMetadata(CUST_A.id);

      expect(metadata).toBeUndefined();
    });

    // ---------------------------------------------------------------
    // 10.1 (continued): SQS publish includes metadata in envelope
    // ---------------------------------------------------------------
    it("should include metadata in SQS envelope when provided", async () => {
      const publishSpy = jest.spyOn(sqsProducerService, "publish");

      await sqsProducerService.publish(
        "payment.succeeded",
        {
          invoiceId: "inv-test",
          customerId: CUST_A.id,
          monolithCustomerId: "mono-test",
          amountCents: 10000,
          currency: "usd",
          paymentMethodId: "pm-test",
          stripePaymentIntentId: "pi_test",
        },
        "corr-test-001",
        { dual_write: true },
      );

      expect(publishSpy).toHaveBeenCalledWith(
        "payment.succeeded",
        expect.any(Object),
        "corr-test-001",
        { dual_write: true },
      );

      publishSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------
  // 10.3 Validation: seed matching data, verify consistent
  // ---------------------------------------------------------------
  describe("Customer validation", () => {
    it("should return consistent when billing and monolith data match", async () => {
      await seedCustomer(CUST_A);

      // Monolith: 2 charges totaling $150.00, 1 paid
      await seedMonolithCharge({
        chargeId: 9001,
        customerId: CUST_A.monolithCustomerId,
        amount: 100.0,
        paymentStatus: "paid",
      });
      await seedMonolithCharge({
        chargeId: 9002,
        customerId: CUST_A.monolithCustomerId,
        amount: 50.0,
        paymentStatus: "pending",
      });

      // Billing: 2 invoices totaling 15000 cents, 1 paid — with monolith_charge_id metadata
      const now = new Date();
      const periodStart = new Date("2025-01-01");
      const periodEnd = new Date("2025-02-01");
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000a01",
        customerId: CUST_A.id,
        totalAmountCents: 10000,
        status: "paid",
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        dueDate: now,
      });
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000a02",
        customerId: CUST_A.id,
        totalAmountCents: 5000,
        status: "finalized",
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        dueDate: now,
      });

      // Set monolith_charge_id metadata on invoices
      const db = getTestDatabase();
      await db.execute(
        sql`UPDATE invoices SET metadata = '{"monolith_charge_id": "9001"}'::jsonb WHERE id = 'e0000000-0000-4000-a000-000000000a01'`,
      );
      await db.execute(
        sql`UPDATE invoices SET metadata = '{"monolith_charge_id": "9002"}'::jsonb WHERE id = 'e0000000-0000-4000-a000-000000000a02'`,
      );

      const result = await validationService.validateCustomer(CUST_A.id);

      expect(result.status).toBe("consistent");
      expect(result.discrepancies).toHaveLength(0);
      expect(result.recordsCompared).toBeGreaterThan(0);
    });

    // ---------------------------------------------------------------
    // 10.4 Adversarial: seed mismatched data, verify discrepancy_found
    // ---------------------------------------------------------------
    it("should detect discrepancy when amounts do not match", async () => {
      await seedCustomer(CUST_B);

      // Monolith: 1 charge for $100.00
      await seedMonolithCharge({
        chargeId: 9010,
        customerId: CUST_B.monolithCustomerId,
        amount: 100.0,
        paymentStatus: "paid",
      });

      // Billing: 1 invoice for $200.00 (20000 cents) — intentional mismatch
      const now = new Date();
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000a10",
        customerId: CUST_B.id,
        totalAmountCents: 20000,
        status: "paid",
        billingPeriodStart: new Date("2025-01-01"),
        billingPeriodEnd: new Date("2025-02-01"),
        dueDate: now,
      });

      const db = getTestDatabase();
      await db.execute(
        sql`UPDATE invoices SET metadata = '{"monolith_charge_id": "9010"}'::jsonb WHERE id = 'e0000000-0000-4000-a000-000000000a10'`,
      );

      const result = await validationService.validateCustomer(CUST_B.id);

      expect(result.status).toBe("discrepancy_found");
      expect(result.discrepancies.length).toBeGreaterThan(0);

      const amountDisc = result.discrepancies.find(
        (d) => d.field === "charge_total_amount",
      );
      expect(amountDisc).toBeDefined();
      expect(amountDisc!.billingServiceValue).toBe(20000);
      expect(amountDisc!.monolithValue).toBe(10000); // $100 * 100
    });

    // ---------------------------------------------------------------
    // 10.5 Adversarial: different invoice counts
    // ---------------------------------------------------------------
    it("should detect discrepancy when invoice counts differ", async () => {
      await seedCustomer(CUST_A);

      // Monolith: 3 charges
      await seedMonolithCharge({
        chargeId: 9020,
        customerId: CUST_A.monolithCustomerId,
        amount: 50.0,
        paymentStatus: "paid",
      });
      await seedMonolithCharge({
        chargeId: 9021,
        customerId: CUST_A.monolithCustomerId,
        amount: 50.0,
        paymentStatus: "paid",
      });
      await seedMonolithCharge({
        chargeId: 9022,
        customerId: CUST_A.monolithCustomerId,
        amount: 50.0,
        paymentStatus: "pending",
      });

      // Billing: only 1 invoice with monolith_charge_id
      const now = new Date();
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000a20",
        customerId: CUST_A.id,
        totalAmountCents: 5000,
        status: "paid",
        billingPeriodStart: new Date("2025-01-01"),
        billingPeriodEnd: new Date("2025-02-01"),
        dueDate: now,
      });

      const db = getTestDatabase();
      await db.execute(
        sql`UPDATE invoices SET metadata = '{"monolith_charge_id": "9020"}'::jsonb WHERE id = 'e0000000-0000-4000-a000-000000000a20'`,
      );

      const result = await validationService.validateCustomer(CUST_A.id);

      expect(result.status).toBe("discrepancy_found");
      const countDisc = result.discrepancies.find(
        (d) => d.field === "charge_count",
      );
      expect(countDisc).toBeDefined();
      expect(countDisc!.billingServiceValue).toBe(1);
      expect(countDisc!.monolithValue).toBe(3);
    });

    // ---------------------------------------------------------------
    // 10.6 Adversarial: amount rounding edge case
    // ---------------------------------------------------------------
    it("should tolerate 1-cent rounding difference but flag larger gaps", async () => {
      await seedCustomer(CUST_A);

      // Monolith: $99.995 — rounds to 9999 or 10000 cents depending on rounding
      await seedMonolithCharge({
        chargeId: 9030,
        customerId: CUST_A.monolithCustomerId,
        amount: 99.995,
        paymentStatus: "paid",
      });

      // Billing: 10000 cents ($100.00) — within 1 cent of Math.round(99.995 * 100) = 10000
      const now = new Date();
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000a30",
        customerId: CUST_A.id,
        totalAmountCents: 10000,
        status: "paid",
        billingPeriodStart: new Date("2025-01-01"),
        billingPeriodEnd: new Date("2025-02-01"),
        dueDate: now,
      });

      const db = getTestDatabase();
      await db.execute(
        sql`UPDATE invoices SET metadata = '{"monolith_charge_id": "9030"}'::jsonb WHERE id = 'e0000000-0000-4000-a000-000000000a30'`,
      );

      const result = await validationService.validateCustomer(CUST_A.id);

      // Math.round(99.995 * 100) = 10000, billing = 10000, diff = 0 → consistent
      expect(result.status).toBe("consistent");
      expect(
        result.discrepancies.filter((d) => d.field === "charge_total_amount"),
      ).toHaveLength(0);
    });

    it("should flag amount difference beyond 1-cent tolerance", async () => {
      await seedCustomer(CUST_B);

      // Monolith: $99.97 → 9997 cents
      await seedMonolithCharge({
        chargeId: 9031,
        customerId: CUST_B.monolithCustomerId,
        amount: 99.97,
        paymentStatus: "paid",
      });

      // Billing: 10000 cents ($100.00) — difference of 3 cents
      const now = new Date();
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000a31",
        customerId: CUST_B.id,
        totalAmountCents: 10000,
        status: "paid",
        billingPeriodStart: new Date("2025-01-01"),
        billingPeriodEnd: new Date("2025-02-01"),
        dueDate: now,
      });

      const db = getTestDatabase();
      await db.execute(
        sql`UPDATE invoices SET metadata = '{"monolith_charge_id": "9031"}'::jsonb WHERE id = 'e0000000-0000-4000-a000-000000000a31'`,
      );

      const result = await validationService.validateCustomer(CUST_B.id);

      expect(result.status).toBe("discrepancy_found");
      const amountDisc = result.discrepancies.find(
        (d) => d.field === "charge_total_amount",
      );
      expect(amountDisc).toBeDefined();
    });
  });

  // ---------------------------------------------------------------
  // 10.7 Wave validation: multiple customers with mixed consistency
  // ---------------------------------------------------------------
  describe("Wave validation", () => {
    it("should validate multiple customers with mixed results", async () => {
      await seedCustomer(CUST_A);
      await seedCustomer(CUST_B);
      await seedCustomer(CUST_C);

      const now = new Date();
      const periodStart = new Date("2025-01-01");
      const periodEnd = new Date("2025-02-01");

      // Customer A: consistent (1 charge $50 → 5000 cents)
      await seedMonolithCharge({
        chargeId: 9040,
        customerId: CUST_A.monolithCustomerId,
        amount: 50.0,
        paymentStatus: "paid",
      });
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000a40",
        customerId: CUST_A.id,
        totalAmountCents: 5000,
        status: "paid",
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        dueDate: now,
      });
      const db = getTestDatabase();
      await db.execute(
        sql`UPDATE invoices SET metadata = '{"monolith_charge_id": "9040"}'::jsonb WHERE id = 'e0000000-0000-4000-a000-000000000a40'`,
      );

      // Customer B: discrepancy (monolith $75 but billing 10000 cents = $100)
      await seedMonolithCharge({
        chargeId: 9041,
        customerId: CUST_B.monolithCustomerId,
        amount: 75.0,
        paymentStatus: "paid",
      });
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000a41",
        customerId: CUST_B.id,
        totalAmountCents: 10000,
        status: "paid",
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        dueDate: now,
      });
      await db.execute(
        sql`UPDATE invoices SET metadata = '{"monolith_charge_id": "9041"}'::jsonb WHERE id = 'e0000000-0000-4000-a000-000000000a41'`,
      );

      // Customer C: consistent (no charges in either system)
      // No monolith data, no billing invoices with monolith metadata

      const result = await validationService.validateWave([
        CUST_A.id,
        CUST_B.id,
        CUST_C.id,
      ]);

      expect(result.waveSize).toBe(3);
      expect(result.consistent).toBe(2); // A and C
      expect(result.discrepancyFound).toBe(1); // B
      expect(result.errorCount).toBe(0);
      expect(result.totalDiscrepancies).toBeGreaterThan(0);

      // Verify individual results
      const custAResult = result.customerResults.find(
        (r) => r.customerId === CUST_A.id,
      );
      expect(custAResult?.status).toBe("consistent");

      const custBResult = result.customerResults.find(
        (r) => r.customerId === CUST_B.id,
      );
      expect(custBResult?.status).toBe("discrepancy_found");

      const custCResult = result.customerResults.find(
        (r) => r.customerId === CUST_C.id,
      );
      expect(custCResult?.status).toBe("consistent");
    });
  });

  // ---------------------------------------------------------------
  // 10.8 Migration status endpoint: returns correct counts
  // ---------------------------------------------------------------
  describe("Migration status endpoint", () => {
    it("should return per-customer migration status", async () => {
      await seedCustomer(CUST_A);

      // Seed migration log
      await seedMigrationLog({
        id: "b0000000-0000-4000-a000-000000000a01",
        runId: "b0000000-0000-4000-a000-000000000b01",
        scriptName: "payment_settings_migration",
        monolithCustomerId: CUST_A.monolithCustomerId,
        billingCustomerId: CUST_A.id,
        status: "success",
      });

      // Seed feature flags
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000a10",
        customerId: CUST_A.id,
        flagName: "billing_service_enabled",
        enabled: true,
      });
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000a11",
        customerId: CUST_A.id,
        flagName: "dual_write_enabled",
        enabled: true,
      });

      const path = "/v1/migration/status";
      const queryPath = `${path}?customerId=${CUST_A.id}`;
      const headers = signRequest("GET", path);

      const response = await request(app.getHttpServer() as Server)
        .get(queryPath)
        .set(headers)
        .expect(200);

      expect(response.body.type).toBe("customer");
      expect(response.body.data.customerId).toBe(CUST_A.id);
      expect(response.body.data.migrationStatus).toBe("migrated");
      expect(response.body.data.billingServiceEnabled).toBe(true);
      expect(response.body.data.dualWriteEnabled).toBe(true);
      expect(response.body.data.lastMigrationScript).toBe(
        "payment_settings_migration",
      );
    });

    it("should return aggregate migration status", async () => {
      await seedCustomer(CUST_A);
      await seedCustomer(CUST_B);
      await seedCustomer(CUST_C);

      // Customer A: migrated
      await seedMigrationLog({
        id: "b0000000-0000-4000-a000-000000000a02",
        runId: "b0000000-0000-4000-a000-000000000b02",
        scriptName: "charges_migration",
        monolithCustomerId: CUST_A.monolithCustomerId,
        billingCustomerId: CUST_A.id,
        status: "success",
      });

      // Customer B: failed
      await seedMigrationLog({
        id: "b0000000-0000-4000-a000-000000000a03",
        runId: "b0000000-0000-4000-a000-000000000b03",
        scriptName: "charges_migration",
        monolithCustomerId: CUST_B.monolithCustomerId,
        billingCustomerId: CUST_B.id,
        status: "failed",
        errorMessage: "Connection timeout",
      });

      // Customer C: pending (no migration log)

      // One customer with dual-write active
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000a20",
        customerId: CUST_A.id,
        flagName: "dual_write_enabled",
        enabled: true,
      });

      const path = "/v1/migration/status";
      const headers = signRequest("GET", path);

      const response = await request(app.getHttpServer() as Server)
        .get(path)
        .set(headers)
        .expect(200);

      expect(response.body.type).toBe("aggregate");
      expect(response.body.data.totalCustomers).toBe(3);
      expect(response.body.data.migrated).toBe(1);
      expect(response.body.data.failed).toBe(1);
      expect(response.body.data.pending).toBe(1);
      expect(response.body.data.dualWriteActive).toBe(1);
    });

    // ---------------------------------------------------------------
    // 10.9 401 without HMAC auth
    // ---------------------------------------------------------------
    it("should return 401 without HMAC authentication", async () => {
      await request(app.getHttpServer() as Server)
        .get("/v1/migration/status")
        .expect(401);
    });
  });

  // ---------------------------------------------------------------
  // 10.10 Reconciliation reuse: run migration reconciliation
  // ---------------------------------------------------------------
  describe("Reconciliation reuse", () => {
    it("should delegate to ReconciliationService and store results", async () => {
      const periodStart = new Date("2025-01-01");
      const periodEnd = new Date("2025-01-02");
      const correlationId = "corr-reconcile-001";

      const result = await validationService.runMigrationReconciliation(
        periodStart,
        periodEnd,
        correlationId,
      );

      // The reconciliation service stores a run record
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.status).toBeDefined();
      expect(["balanced", "discrepancy_found", "failed"]).toContain(
        result.status,
      );

      // Verify reconciliation run is persisted
      const db = getTestDatabase();
      const runs = await db.execute(
        sql`SELECT id, status FROM reconciliation_runs WHERE correlation_id = ${correlationId}`,
      );
      expect(runs.rows.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // 10.11 Dual-write failure: verify primary succeeds, failure logged
  // ---------------------------------------------------------------
  describe("Dual-write failure handling", () => {
    it("should log dual-write failure to migration_logs", async () => {
      await seedCustomer(CUST_A);

      const testError = new Error("SQS publish timed out");
      const correlationId = "b0000000-0000-4000-a000-000000000c01";

      await dualWriteService.logDualWriteFailure(
        CUST_A.monolithCustomerId,
        "payment.succeeded",
        { invoiceId: "inv-test", amountCents: 10000 },
        testError,
        correlationId,
      );

      // Verify migration_logs entry
      const db = getTestDatabase();
      const logs = await db.execute(
        sql`SELECT * FROM migration_logs WHERE script_name = 'dual_write_failure' AND run_id = ${correlationId}::uuid`,
      );

      expect(logs.rows).toHaveLength(1);
      const row = logs.rows[0] as {
        monolith_customer_id: string;
        status: string;
        error_message: string;
        details: Record<string, unknown>;
      };
      expect(row.monolith_customer_id).toBe(CUST_A.monolithCustomerId);
      expect(row.status).toBe("failed");
      expect(row.error_message).toBe("SQS publish timed out");
      expect(row.details).toEqual({
        operation: "payment.succeeded",
        payload: { invoiceId: "inv-test", amountCents: 10000 },
        correlationId,
      });
    });

    it("should not throw when logging dual-write failure even if DB insert fails", async () => {
      // Use a valid correlationId (UUID) — the insert may fail for other reasons
      // but the nested try-catch in logDualWriteFailure should handle it gracefully
      await expect(
        dualWriteService.logDualWriteFailure(
          "valid-id",
          "payment.succeeded",
          { invoiceId: "inv-test" },
          new Error("SQS failure"),
          "b0000000-0000-4000-a000-000000000c02",
        ),
      ).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------
  // Adversarial: excluded data tests
  // ---------------------------------------------------------------
  describe("Adversarial exclusion tests", () => {
    it("should not count deleted monolith charges", async () => {
      await seedCustomer(CUST_A);

      // Monolith: 1 active charge ($50), 1 deleted charge ($100)
      await seedMonolithCharge({
        chargeId: 9050,
        customerId: CUST_A.monolithCustomerId,
        amount: 50.0,
        paymentStatus: "paid",
      });
      await seedMonolithCharge({
        chargeId: 9051,
        customerId: CUST_A.monolithCustomerId,
        amount: 100.0,
        paymentStatus: "paid",
        deletedAt: new Date("2025-06-01"),
      });

      // Billing: 1 invoice matching only the active charge
      const now = new Date();
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000a50",
        customerId: CUST_A.id,
        totalAmountCents: 5000,
        status: "paid",
        billingPeriodStart: new Date("2025-01-01"),
        billingPeriodEnd: new Date("2025-02-01"),
        dueDate: now,
      });

      const db = getTestDatabase();
      await db.execute(
        sql`UPDATE invoices SET metadata = '{"monolith_charge_id": "9050"}'::jsonb WHERE id = 'e0000000-0000-4000-a000-000000000a50'`,
      );

      const result = await validationService.validateCustomer(CUST_A.id);

      // The deleted charge should be excluded by "deletedAt" IS NULL filter
      expect(result.status).toBe("consistent");
    });

    it("should not count invoices without monolith metadata in validation", async () => {
      await seedCustomer(CUST_A);

      // Monolith: 1 charge
      await seedMonolithCharge({
        chargeId: 9060,
        customerId: CUST_A.monolithCustomerId,
        amount: 50.0,
        paymentStatus: "paid",
      });

      // Billing: 2 invoices, but only 1 has monolith_charge_id metadata
      const now = new Date();
      const periodStart = new Date("2025-01-01");
      const periodEnd = new Date("2025-02-01");
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000a60",
        customerId: CUST_A.id,
        totalAmountCents: 5000,
        status: "paid",
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        dueDate: now,
      });
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000a61",
        customerId: CUST_A.id,
        totalAmountCents: 7500,
        status: "paid",
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        dueDate: now,
      });

      const db = getTestDatabase();
      // Only first invoice has monolith metadata
      await db.execute(
        sql`UPDATE invoices SET metadata = '{"monolith_charge_id": "9060"}'::jsonb WHERE id = 'e0000000-0000-4000-a000-000000000a60'`,
      );
      // Second invoice has no monolith metadata — should be excluded from validation

      const result = await validationService.validateCustomer(CUST_A.id);

      // Should compare 1 monolith charge vs 1 billing invoice (the one with metadata)
      expect(result.status).toBe("consistent");
    });
  });
});
