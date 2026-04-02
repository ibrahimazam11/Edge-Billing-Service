import { INestApplication } from "@nestjs/common";
import { createTestApp } from "./helpers/test-app";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  seedCustomer,
  seedPaymentMethod,
  seedLedgerAccounts,
} from "./helpers/database";
import { sql, eq } from "drizzle-orm";
import { PayrollBillingMigrationService } from "../src/migration/payroll-billing-migration.service";
import { SurchargeConfigMigrationService } from "../src/migration/surcharge-config-migration.service";
import * as schema from "../src/database/schema";
import type { MigrationOptions } from "../src/migration/dto/migration-options.dto";

const CUSTOMER_ID = "c0000000-0000-4000-a000-000000000f01";
const CUSTOMER_ID_2 = "c0000000-0000-4000-a000-000000000f02";
const PM_ID = "d0000000-0000-4000-a000-000000000f01";
const PM_ID_2 = "d0000000-0000-4000-a000-000000000f02";
const MONOLITH_CUST_1 = "MONO-PAY-001";
const MONOLITH_CUST_2 = "MONO-PAY-002";

const defaultOptions: MigrationOptions = {
  dryRun: false,
  batchSize: 50,
  batchDelayMs: 0,
};

// --- Monolith table helpers (Task 8) ---

async function createMonolithPayrollTables(): Promise<void> {
  const db = getTestDatabase();
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
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "Customer_Credit_Card_Settings" (
      "id" serial PRIMARY KEY,
      "Customer_ID" varchar(255) UNIQUE NOT NULL,
      "Allow_Credit_Card" boolean DEFAULT false,
      "Surcharge_Type" varchar(255),
      "Surcharge_Value" numeric(10,2),
      "Reason" varchar(255),
      "Notes" text,
      "Enabled_By_User_ID" varchar(255),
      "createdAt" timestamptz DEFAULT now(),
      "updatedAt" timestamptz DEFAULT now()
    )
  `);
}

async function seedMonolithPayroll(data: {
  payrollId: string;
  customerId: string | null;
  totalAmount: number | null;
  totalBonus?: number | null;
  paymentDate?: Date | null;
  paidOn?: Date | null;
  status: string;
  payrollMonth: Date;
  surcharge?: number | null;
  failure?: boolean;
  failureReason?: string | null;
  paymentMethod?: string | null;
  referenceNumber?: string | null;
}): Promise<void> {
  const db = getTestDatabase();
  await db.execute(sql`
    INSERT INTO "Customer_Payroll" (
      "Customer_Payroll_ID", "Customer_ID", "Total_Amount", "Total_Bonus",
      "Payment_Date", "Paid_On", "Status", "Payroll_Month",
      "Credit_Card_Surcharge", "Failure", "Failure_Reason",
      "Payment_Method", "Reference_Number"
    ) VALUES (
      ${data.payrollId}, ${data.customerId},
      ${data.totalAmount}, ${data.totalBonus ?? null},
      ${data.paymentDate ?? null}, ${data.paidOn ?? null},
      ${data.status}, ${data.payrollMonth.toISOString().slice(0, 10)},
      ${data.surcharge ?? null}, ${data.failure ?? false},
      ${data.failureReason ?? null},
      ${data.paymentMethod ?? "ACH"}, ${data.referenceNumber ?? null}
    )
  `);
}

async function seedMonolithCreditCardSettings(data: {
  customerId: string;
  allowCreditCard: boolean;
  surchargeType?: string | null;
  surchargeValue?: number | null;
  reason?: string | null;
  notes?: string | null;
  enabledByUserId?: string | null;
}): Promise<void> {
  const db = getTestDatabase();
  await db.execute(sql`
    INSERT INTO "Customer_Credit_Card_Settings" (
      "Customer_ID", "Allow_Credit_Card", "Surcharge_Type",
      "Surcharge_Value", "Reason", "Notes", "Enabled_By_User_ID"
    ) VALUES (
      ${data.customerId}, ${data.allowCreditCard},
      ${data.surchargeType ?? null}, ${data.surchargeValue ?? null},
      ${data.reason ?? null}, ${data.notes ?? null},
      ${data.enabledByUserId ?? null}
    )
  `);
}

async function cleanMonolithTables(): Promise<void> {
  const db = getTestDatabase();
  await db.execute(sql`DELETE FROM "Customer_Credit_Card_Settings"`);
  await db.execute(sql`DELETE FROM "Customer_Payroll"`);
}

// --- Test suite ---

describe("Payroll Billing & Surcharge Config Migration (E2E)", () => {
  let app: INestApplication;
  let payrollService: PayrollBillingMigrationService;
  let surchargeService: SurchargeConfigMigrationService;

  beforeAll(async () => {
    await setupTestDatabase();
    await seedLedgerAccounts();
    app = await createTestApp();
    await createMonolithPayrollTables();

    payrollService = app.get(PayrollBillingMigrationService);
    surchargeService = app.get(SurchargeConfigMigrationService);
  });

  afterAll(async () => {
    const db = getTestDatabase();
    await db.execute(sql`DROP TABLE IF EXISTS "Customer_Credit_Card_Settings"`);
    await db.execute(sql`DROP TABLE IF EXISTS "Customer_Payroll"`);
    await app.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await cleanMonolithTables();
    await seedLedgerAccounts();

    // Seed billing customers (simulating 7.2 output)
    await seedCustomer({
      id: CUSTOMER_ID,
      monolithCustomerId: MONOLITH_CUST_1,
      stripeCustomerId: "cus_e2e_pay_1",
      name: "Payroll Test Customer 1",
      email: "pay1@example.com",
    });
    await seedPaymentMethod({
      id: PM_ID,
      customerId: CUSTOMER_ID,
      stripePaymentMethodId: "pm_e2e_pay_1",
      type: "bank_account",
      isDefault: true,
    });
  });

  // --- 9.1: Happy path paid payroll ---

  describe("9.1: paid payroll with bonus + surcharge", () => {
    it("should create invoice, charge, 3 line items, 2 ledger pairs", async () => {
      await seedMonolithPayroll({
        payrollId: "PAY-E2E-001",
        customerId: MONOLITH_CUST_1,
        totalAmount: 500.0,
        totalBonus: 100.0,
        status: "paid",
        payrollMonth: new Date("2025-06-01"),
        surcharge: 15.0,
        paidOn: new Date("2025-06-16"),
        paymentDate: new Date("2025-06-15"),
      });

      const summary = await payrollService.migrateAll(defaultOptions);

      expect(summary.succeeded).toBe(1);

      const db = getTestDatabase();

      // Verify invoice
      const invoiceRows = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, CUSTOMER_ID));
      expect(invoiceRows).toHaveLength(1);
      expect(invoiceRows[0].status).toBe("paid");
      // M4: totalAmountCents from line item sum = 38500 + 10000 + 1500 = 50000
      expect(invoiceRows[0].totalAmountCents).toBe(50000);
      expect(invoiceRows[0].paidAt).not.toBeNull();

      // Verify 3 line items
      const lineItemRows = await db
        .select()
        .from(schema.invoiceLineItems)
        .where(eq(schema.invoiceLineItems.invoiceId, invoiceRows[0].id));
      expect(lineItemRows).toHaveLength(3);
      const types = lineItemRows.map((li) => li.type).sort();
      expect(types).toEqual(["base_fee", "base_fee", "surcharge"]);

      // Verify charge
      const chargeRows = await db
        .select()
        .from(schema.charges)
        .where(eq(schema.charges.customerId, CUSTOMER_ID));
      expect(chargeRows).toHaveLength(1);
      expect(chargeRows[0].status).toBe("succeeded");
      expect(chargeRows[0].amountCents).toBe(50000);

      // Verify 2 ledger pairs (migration type)
      const ledgerRows = await db
        .select()
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.referenceId, invoiceRows[0].id));
      expect(ledgerRows).toHaveLength(2);
    });
  });

  // --- 9.2: Failed payroll ---

  describe("9.2: failed payroll", () => {
    it("should create invoice (finalized), charge (failed), 1 ledger pair", async () => {
      await seedMonolithPayroll({
        payrollId: "PAY-E2E-002",
        customerId: MONOLITH_CUST_1,
        totalAmount: 300.0,
        status: "failed",
        payrollMonth: new Date("2025-07-01"),
        failure: true,
        failureReason: "Card declined",
      });

      const summary = await payrollService.migrateAll(defaultOptions);
      expect(summary.succeeded).toBe(1);

      const db = getTestDatabase();

      const invoiceRows = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, CUSTOMER_ID));
      expect(invoiceRows).toHaveLength(1);
      expect(invoiceRows[0].status).toBe("finalized");

      const chargeRows = await db
        .select()
        .from(schema.charges)
        .where(eq(schema.charges.customerId, CUSTOMER_ID));
      expect(chargeRows).toHaveLength(1);
      expect(chargeRows[0].status).toBe("failed");
      expect(chargeRows[0].failureReason).toBe("Card declined");

      // Only 1 ledger pair (finalize, no payment)
      const ledgerRows = await db
        .select()
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.referenceId, invoiceRows[0].id));
      expect(ledgerRows).toHaveLength(1);
    });
  });

  // --- 9.3: Adversarial — null Customer_ID ---

  describe("9.3: adversarial — payroll with null Customer_ID", () => {
    it("should skip with orphaned_no_customer_id", async () => {
      await seedMonolithPayroll({
        payrollId: "PAY-E2E-003",
        customerId: null,
        totalAmount: 200.0,
        status: "paid",
        payrollMonth: new Date("2025-08-01"),
      });

      const summary = await payrollService.migrateAll(defaultOptions);

      // Orphaned records are counted from the monolith query for null Customer_IDs
      expect(summary.orphanedSkipped).toBeGreaterThanOrEqual(1);

      // No invoices should be created
      const db = getTestDatabase();
      const invoiceRows = await db.select().from(schema.invoices);
      expect(invoiceRows).toHaveLength(0);
    });
  });

  // --- 9.4: Adversarial — null Total_Amount ---

  describe("9.4: adversarial — payroll with null Total_Amount", () => {
    it("should skip with null_amount", async () => {
      await seedMonolithPayroll({
        payrollId: "PAY-E2E-004",
        customerId: MONOLITH_CUST_1,
        totalAmount: null,
        status: "paid",
        payrollMonth: new Date("2025-08-01"),
      });

      const summary = await payrollService.migrateAll(defaultOptions);

      expect(summary.nullAmountSkipped).toBe(1);

      const db = getTestDatabase();
      const invoiceRows = await db.select().from(schema.invoices);
      expect(invoiceRows).toHaveLength(0);
    });
  });

  // --- 9.5: Adversarial — non-migrated customer ---

  describe("9.5: adversarial — payroll for non-migrated customer", () => {
    it("should not migrate payrolls for unknown customers", async () => {
      await seedMonolithPayroll({
        payrollId: "PAY-E2E-005",
        customerId: "MONO-NONEXISTENT",
        totalAmount: 100.0,
        status: "paid",
        payrollMonth: new Date("2025-09-01"),
      });

      const summary = await payrollService.migrateByIds(
        ["MONO-NONEXISTENT"],
        defaultOptions,
      );

      // Customer not found → 0 payrolls processed
      expect(summary.totalPayrolls).toBe(0);
    });
  });

  // --- 9.6: Adversarial — already migrated (idempotency) ---

  describe("9.6: adversarial — already-migrated payroll", () => {
    it("should skip on second run (idempotency)", async () => {
      await seedMonolithPayroll({
        payrollId: "PAY-E2E-006",
        customerId: MONOLITH_CUST_1,
        totalAmount: 250.0,
        status: "paid",
        payrollMonth: new Date("2025-10-01"),
        paidOn: new Date("2025-10-15"),
      });

      // First run
      const summary1 = await payrollService.migrateAll(defaultOptions);
      expect(summary1.succeeded).toBe(1);

      // Second run — should skip
      const summary2 = await payrollService.migrateAll(defaultOptions);
      expect(summary2.totalPayrolls).toBe(1);
      expect(summary2.skipped).toBe(1);
      expect(summary2.succeeded).toBe(0);

      // Only 1 invoice exists (not duplicated)
      const db = getTestDatabase();
      const invoiceRows = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, CUSTOMER_ID));
      expect(invoiceRows).toHaveLength(1);
    });
  });

  // --- 9.7: Surcharge config — percentage type ---

  describe("9.7: surcharge config percentage type", () => {
    it("should convert 3.50 to 350 basis points in DB", async () => {
      await seedMonolithCreditCardSettings({
        customerId: MONOLITH_CUST_1,
        allowCreditCard: true,
        surchargeType: "percentage",
        surchargeValue: 3.5,
        reason: "Processing fee",
      });

      const summary = await surchargeService.migrateAll(defaultOptions);

      expect(summary.succeeded).toBe(1);
      expect(summary.percentageType).toBe(1);

      // Verify DB value
      const db = getTestDatabase();
      const [config] = await db
        .select()
        .from(schema.surchargeConfigs)
        .where(eq(schema.surchargeConfigs.customerId, CUSTOMER_ID));
      expect(config).toBeDefined();
      expect(config.surchargeType).toBe("percentage");
      expect(config.surchargeValue).toBe(350);
      expect(config.allowCreditCard).toBe(true);
    });
  });

  // --- 9.8: Surcharge config — flat_fee type ---

  describe("9.8: surcharge config flat_fee type", () => {
    it("should convert 5.00 to 500 cents in DB", async () => {
      await seedMonolithCreditCardSettings({
        customerId: MONOLITH_CUST_1,
        allowCreditCard: false,
        surchargeType: "flat",
        surchargeValue: 5.0,
      });

      const summary = await surchargeService.migrateAll(defaultOptions);

      expect(summary.succeeded).toBe(1);
      expect(summary.flatFeeType).toBe(1);

      const db = getTestDatabase();
      const [config] = await db
        .select()
        .from(schema.surchargeConfigs)
        .where(eq(schema.surchargeConfigs.customerId, CUSTOMER_ID));
      expect(config).toBeDefined();
      expect(config.surchargeType).toBe("flat_fee");
      expect(config.surchargeValue).toBe(500);
      expect(config.allowCreditCard).toBe(false);
    });
  });

  // --- 9.9: Surcharge config — idempotency ---

  describe("9.9: surcharge config already exists", () => {
    it("should skip on second run (idempotency)", async () => {
      await seedMonolithCreditCardSettings({
        customerId: MONOLITH_CUST_1,
        allowCreditCard: true,
        surchargeType: "percentage",
        surchargeValue: 2.5,
      });

      // First run
      const summary1 = await surchargeService.migrateAll(defaultOptions);
      expect(summary1.succeeded).toBe(1);

      // Second run — should skip
      const summary2 = await surchargeService.migrateAll(defaultOptions);
      expect(summary2.totalConfigs).toBe(1);
      expect(summary2.skipped).toBe(1);
      expect(summary2.succeeded).toBe(0);
    });
  });

  // --- 9.10: Ledger balance verification ---

  describe("9.10: ledger balance verification", () => {
    it("should have balanced AR debits and credits for paid payrolls", async () => {
      await seedMonolithPayroll({
        payrollId: "PAY-E2E-010",
        customerId: MONOLITH_CUST_1,
        totalAmount: 400.0,
        status: "paid",
        payrollMonth: new Date("2025-11-01"),
        paidOn: new Date("2025-11-15"),
      });

      await payrollService.migrateAll(defaultOptions);

      const db = getTestDatabase();

      // For paid payrolls: AR debited during finalization, then credited during payment
      const arAccountId = "a0000000-0000-4000-a000-000000000001"; // accounts_receivable

      const result = await db.execute(sql`
        SELECT
          COALESCE(SUM(CASE WHEN debit_account_id = ${arAccountId} THEN amount_cents ELSE 0 END), 0) as ar_debits,
          COALESCE(SUM(CASE WHEN credit_account_id = ${arAccountId} THEN amount_cents ELSE 0 END), 0) as ar_credits
        FROM ledger_entries
        WHERE reference_type = 'migration'
      `);

      const row = result.rows[0] as {
        ar_debits: string;
        ar_credits: string;
      };
      expect(Number(row.ar_debits)).toBe(Number(row.ar_credits));
      expect(Number(row.ar_debits)).toBe(40000); // $400 = 40000 cents
    });
  });

  // --- 9.11: Mixed batch ---

  describe("9.11: mixed batch — multiple customers, statuses", () => {
    it("should handle different statuses correctly", async () => {
      // Seed second customer
      await seedCustomer({
        id: CUSTOMER_ID_2,
        monolithCustomerId: MONOLITH_CUST_2,
        stripeCustomerId: "cus_e2e_pay_2",
        name: "Payroll Test Customer 2",
        email: "pay2@example.com",
      });
      await seedPaymentMethod({
        id: PM_ID_2,
        customerId: CUSTOMER_ID_2,
        stripePaymentMethodId: "pm_e2e_pay_2",
        type: "card",
        isDefault: true,
      });

      // Customer 1: paid payroll
      await seedMonolithPayroll({
        payrollId: "PAY-E2E-011A",
        customerId: MONOLITH_CUST_1,
        totalAmount: 100.0,
        status: "paid",
        payrollMonth: new Date("2025-06-01"),
        paidOn: new Date("2025-06-15"),
      });

      // Customer 1: failed payroll
      await seedMonolithPayroll({
        payrollId: "PAY-E2E-011B",
        customerId: MONOLITH_CUST_1,
        totalAmount: 50.0,
        status: "failed",
        payrollMonth: new Date("2025-07-01"),
        failure: true,
        failureReason: "Insufficient funds",
      });

      // Customer 2: paid payroll
      await seedMonolithPayroll({
        payrollId: "PAY-E2E-011C",
        customerId: MONOLITH_CUST_2,
        totalAmount: 200.0,
        status: "paid",
        payrollMonth: new Date("2025-06-01"),
        paidOn: new Date("2025-06-16"),
      });

      // Customer 2: null amount (should skip)
      await seedMonolithPayroll({
        payrollId: "PAY-E2E-011D",
        customerId: MONOLITH_CUST_2,
        totalAmount: null,
        status: "paid",
        payrollMonth: new Date("2025-08-01"),
      });

      const summary = await payrollService.migrateAll(defaultOptions);

      expect(summary.totalPayrolls).toBe(4);
      expect(summary.succeeded).toBe(3); // paid + failed + paid
      expect(summary.nullAmountSkipped).toBe(1);

      const db = getTestDatabase();

      // Customer 1: 2 invoices
      const cust1Invoices = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, CUSTOMER_ID));
      expect(cust1Invoices).toHaveLength(2);

      // Customer 2: 1 invoice (paid only, null-amount skipped)
      const cust2Invoices = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, CUSTOMER_ID_2));
      expect(cust2Invoices).toHaveLength(1);
      expect(cust2Invoices[0].status).toBe("paid");
    });
  });

  // --- 9.12: Dry-run ---

  describe("9.12: dry-run mode", () => {
    it("should not create billing DB records in dry-run", async () => {
      await seedMonolithPayroll({
        payrollId: "PAY-E2E-012",
        customerId: MONOLITH_CUST_1,
        totalAmount: 350.0,
        status: "paid",
        payrollMonth: new Date("2025-12-01"),
      });

      const summary = await payrollService.migrateAll({
        ...defaultOptions,
        dryRun: true,
      });

      expect(summary.totalPayrolls).toBe(1);
      expect(summary.succeeded).toBe(1);
      expect(summary.scriptName).toBe("migrate-payroll-billing-dry-run");

      const db = getTestDatabase();

      // No invoices created
      const invoiceRows = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, CUSTOMER_ID));
      expect(invoiceRows).toHaveLength(0);

      // No charges created
      const chargeRows = await db
        .select()
        .from(schema.charges)
        .where(eq(schema.charges.customerId, CUSTOMER_ID));
      expect(chargeRows).toHaveLength(0);

      // Migration logs WERE created
      const logRows = await db
        .select()
        .from(schema.migrationLogs)
        .where(eq(schema.migrationLogs.monolithCustomerId, MONOLITH_CUST_1));
      expect(logRows.length).toBeGreaterThanOrEqual(1);
    });
  });
});
