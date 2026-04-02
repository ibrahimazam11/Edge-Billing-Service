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
import { ChargesMigrationService } from "../src/migration/charges-migration.service";
import * as schema from "../src/database/schema";
import type { MigrationOptions } from "../src/migration/dto/migration-options.dto";

const CUSTOMER_ID = "c0000000-0000-4000-a000-000000000e01";
const CUSTOMER_ID_2 = "c0000000-0000-4000-a000-000000000e02";
const PM_ID = "d0000000-0000-4000-a000-000000000e01";
const PM_ID_2 = "d0000000-0000-4000-a000-000000000e02";
const MONOLITH_CUST_1 = "MONO-CHG-001";
const MONOLITH_CUST_2 = "MONO-CHG-002";

const defaultOptions: MigrationOptions = {
  dryRun: false,
  batchSize: 50,
  batchDelayMs: 0,
};

// --- Monolith table helpers (Task 7) ---

async function createMonolithChargeTables(): Promise<void> {
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
    CREATE TABLE IF NOT EXISTS "One_Time_Charge_Invoice_Items" (
      "id" serial PRIMARY KEY,
      "Charge_ID" integer REFERENCES "Customer_Charge"("Charge_ID"),
      "Fee" numeric(10,2),
      "Implementation_Fee" numeric(10,2),
      "Discount" numeric(10,2),
      "Total" numeric(10,2),
      "Employee_Name" varchar(255),
      "Notes" text,
      "Type" varchar(255)
    )
  `);
}

async function seedMonolithCharge(data: {
  chargeId: number;
  customerId: string;
  amount: number | null;
  paymentStatus: string;
  paymentDate?: Date | null;
  failureReason?: string | null;
  scheduledAt?: Date | null;
  surcharge?: number | null;
  deletedAt?: Date | null;
}): Promise<void> {
  const db = getTestDatabase();
  await db.execute(sql`
    INSERT INTO "Customer_Charge" (
      "Charge_ID", "Customer_ID", "Amount", "Payment_Status",
      "Payment_Date", "Failure_Reason", "Scheduled_At",
      "Credit_Card_Surcharge", "deletedAt"
    ) VALUES (
      ${data.chargeId}, ${data.customerId},
      ${data.amount}, ${data.paymentStatus},
      ${data.paymentDate ?? null}, ${data.failureReason ?? null},
      ${data.scheduledAt ?? new Date("2025-06-01")},
      ${data.surcharge ?? null}, ${data.deletedAt ?? null}
    )
  `);
}

async function seedMonolithLineItem(data: {
  chargeId: number;
  fee: number;
  implementationFee?: number | null;
  discount?: number;
  total: number;
  employeeName?: string;
  notes?: string;
  type?: string;
}): Promise<void> {
  const db = getTestDatabase();
  await db.execute(sql`
    INSERT INTO "One_Time_Charge_Invoice_Items" (
      "Charge_ID", "Fee", "Implementation_Fee", "Discount",
      "Total", "Employee_Name", "Notes", "Type"
    ) VALUES (
      ${data.chargeId}, ${data.fee}, ${data.implementationFee ?? null},
      ${data.discount ?? 0}, ${data.total},
      ${data.employeeName ?? "Employee"}, ${data.notes ?? null},
      ${data.type ?? "onboarding"}
    )
  `);
}

async function cleanMonolithTables(): Promise<void> {
  const db = getTestDatabase();
  await db.execute(sql`DELETE FROM "One_Time_Charge_Invoice_Items"`);
  await db.execute(sql`DELETE FROM "Customer_Charge"`);
}

// --- Test suite ---

describe("Charges Migration (e2e)", () => {
  let app: INestApplication;
  let migrationService: ChargesMigrationService;

  beforeAll(async () => {
    await setupTestDatabase();
    await seedLedgerAccounts();
    await createMonolithChargeTables();
    app = await createTestApp();
    migrationService = app.get(ChargesMigrationService);
  });

  afterAll(async () => {
    const db = getTestDatabase();
    await db.execute(sql`DROP TABLE IF EXISTS "One_Time_Charge_Invoice_Items"`);
    await db.execute(sql`DROP TABLE IF EXISTS "Customer_Charge"`);
    await app.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedLedgerAccounts();
    await cleanMonolithTables();

    // Seed billing customers + payment methods (simulating Story 7.2 output)
    await seedCustomer({
      id: CUSTOMER_ID,
      monolithCustomerId: MONOLITH_CUST_1,
      stripeCustomerId: "cus_e2e_chg_1",
      name: "Charge Test Customer 1",
      email: "chg1@example.com",
    });
    await seedPaymentMethod({
      id: PM_ID,
      customerId: CUSTOMER_ID,
      stripePaymentMethodId: "pm_e2e_chg_1",
      type: "card",
      isDefault: true,
      lastFour: "4242",
    });
  });

  describe("8.1: paid charge with line items", () => {
    it("should create invoice, charge, line items, and 2 ledger pairs", async () => {
      await seedMonolithCharge({
        chargeId: 1001,
        customerId: MONOLITH_CUST_1,
        amount: 175.0,
        paymentStatus: "paid",
        paymentDate: new Date("2025-06-15"),
      });
      await seedMonolithLineItem({
        chargeId: 1001,
        fee: 150.0,
        implementationFee: 50.0,
        discount: 25.0,
        total: 175.0,
        employeeName: "John Doe",
        notes: "Setup fee",
      });

      const summary = await migrationService.migrateAll(defaultOptions);

      expect(summary.totalCharges).toBe(1);
      expect(summary.succeeded).toBe(1);
      expect(summary.failed).toBe(0);

      const db = getTestDatabase();

      // Verify invoice created
      const invoiceRows = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, CUSTOMER_ID));
      expect(invoiceRows).toHaveLength(1);
      expect(invoiceRows[0].status).toBe("paid");
      expect(invoiceRows[0].totalAmountCents).toBe(17500);
      expect(
        (invoiceRows[0].metadata as Record<string, unknown>).monolith_charge_id,
      ).toBe(1001);

      // Verify charge created
      const chargeRows = await db
        .select()
        .from(schema.charges)
        .where(eq(schema.charges.customerId, CUSTOMER_ID));
      expect(chargeRows).toHaveLength(1);
      expect(chargeRows[0].status).toBe("succeeded");
      expect(chargeRows[0].amountCents).toBe(17500);
      expect(chargeRows[0].idempotencyKey).toBe("mig_charge_1001");

      // Verify 3 line items (fee + impl_fee + discount)
      const lineItemRows = await db
        .select()
        .from(schema.invoiceLineItems)
        .where(eq(schema.invoiceLineItems.invoiceId, invoiceRows[0].id));
      expect(lineItemRows).toHaveLength(3);

      const types = lineItemRows.map((li) => li.type).sort();
      expect(types).toEqual(["base_fee", "discount", "implementation_fee"]);

      const baseFee = lineItemRows.find((li) => li.type === "base_fee");
      expect(baseFee!.amountCents).toBe(15000);

      const implFee = lineItemRows.find(
        (li) => li.type === "implementation_fee",
      );
      expect(implFee!.amountCents).toBe(5000);

      const discount = lineItemRows.find((li) => li.type === "discount");
      expect(discount!.amountCents).toBe(-2500);

      // Verify 2 ledger pairs (finalize + payment)
      const ledgerRows = await db
        .select()
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.referenceId, invoiceRows[0].id));
      expect(ledgerRows).toHaveLength(2);

      const migrationEntries = ledgerRows.filter(
        (le) => le.referenceType === "migration",
      );
      expect(migrationEntries).toHaveLength(2);
    });
  });

  describe("8.2: failed charge", () => {
    it("should create invoice (finalized), charge (failed), and 1 ledger pair", async () => {
      await seedMonolithCharge({
        chargeId: 1002,
        customerId: MONOLITH_CUST_1,
        amount: 100.0,
        paymentStatus: "failed",
        failureReason: "Card declined",
      });

      const summary = await migrationService.migrateAll(defaultOptions);

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

  describe("8.3: voided charge", () => {
    it("should create invoice (void), no charge, and 2 ledger pairs", async () => {
      await seedMonolithCharge({
        chargeId: 1003,
        customerId: MONOLITH_CUST_1,
        amount: 200.0,
        paymentStatus: "voided",
      });

      const summary = await migrationService.migrateAll(defaultOptions);

      expect(summary.succeeded).toBe(1);

      const db = getTestDatabase();

      const invoiceRows = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, CUSTOMER_ID));
      expect(invoiceRows).toHaveLength(1);
      expect(invoiceRows[0].status).toBe("void");

      // No charge record for voided
      const chargeRows = await db
        .select()
        .from(schema.charges)
        .where(eq(schema.charges.customerId, CUSTOMER_ID));
      expect(chargeRows).toHaveLength(0);

      // 2 ledger pairs (finalize + reversal)
      const ledgerRows = await db
        .select()
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.referenceId, invoiceRows[0].id));
      expect(ledgerRows).toHaveLength(2);
    });
  });

  describe("8.4: adversarial — charge for non-migrated customer", () => {
    it("should not migrate charges for customer not in billing DB", async () => {
      // Seed charge for a customer NOT in the billing DB
      await seedMonolithCharge({
        chargeId: 1004,
        customerId: "MONO-NONEXISTENT",
        amount: 50.0,
        paymentStatus: "paid",
      });

      const summary = await migrationService.migrateByIds(
        ["MONO-NONEXISTENT"],
        defaultOptions,
      );

      // Customer not found → migratedCustomers is empty → 0 charges processed
      expect(summary.totalCharges).toBe(0);

      const db = getTestDatabase();
      const invoiceRows = await db.select().from(schema.invoices);
      expect(invoiceRows).toHaveLength(0);
    });
  });

  describe("8.5: adversarial — soft-deleted charge", () => {
    it("should skip charges with deletedAt set", async () => {
      // Seed a soft-deleted charge (deletedAt IS NOT NULL)
      await seedMonolithCharge({
        chargeId: 1005,
        customerId: MONOLITH_CUST_1,
        amount: 75.0,
        paymentStatus: "paid",
        deletedAt: new Date("2025-07-01"),
      });

      // Also seed a valid charge to ensure it IS migrated
      await seedMonolithCharge({
        chargeId: 1006,
        customerId: MONOLITH_CUST_1,
        amount: 100.0,
        paymentStatus: "paid",
        paymentDate: new Date("2025-06-15"),
      });

      const summary = await migrationService.migrateAll(defaultOptions);

      // Soft-deleted charge is now fetched but skipped; valid charge migrated
      expect(summary.totalCharges).toBe(2);
      expect(summary.succeeded).toBe(1);
      expect(summary.softDeletedSkipped).toBe(1);

      const db = getTestDatabase();
      const invoiceRows = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, CUSTOMER_ID));
      expect(invoiceRows).toHaveLength(1);
      expect(invoiceRows[0].totalAmountCents).toBe(10000); // $100 charge, not $75
    });
  });

  describe("8.6: adversarial — already-migrated charge (idempotency)", () => {
    it("should skip charge that was already migrated", async () => {
      await seedMonolithCharge({
        chargeId: 1007,
        customerId: MONOLITH_CUST_1,
        amount: 150.0,
        paymentStatus: "paid",
        paymentDate: new Date("2025-06-15"),
      });

      // First migration run
      const summary1 = await migrationService.migrateAll(defaultOptions);
      expect(summary1.succeeded).toBe(1);

      // Second migration run — should skip
      const summary2 = await migrationService.migrateAll(defaultOptions);
      expect(summary2.totalCharges).toBe(1);
      expect(summary2.skipped).toBe(1);
      expect(summary2.succeeded).toBe(0);

      // Verify only 1 invoice exists (not duplicated)
      const db = getTestDatabase();
      const invoiceRows = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, CUSTOMER_ID));
      expect(invoiceRows).toHaveLength(1);
    });
  });

  describe("8.7: adversarial — line item total mismatch", () => {
    it("should warn but still migrate when line items don't add up", async () => {
      await seedMonolithCharge({
        chargeId: 1008,
        customerId: MONOLITH_CUST_1,
        amount: 200.0,
        paymentStatus: "paid",
        paymentDate: new Date("2025-06-15"),
      });
      // Mismatch: fee=100 + impl=50 - discount=10 = 140, but Total=150
      await seedMonolithLineItem({
        chargeId: 1008,
        fee: 100.0,
        implementationFee: 50.0,
        discount: 10.0,
        total: 150.0,
      });

      const summary = await migrationService.migrateAll(defaultOptions);

      // Should still succeed despite mismatch
      expect(summary.succeeded).toBe(1);

      const db = getTestDatabase();
      const invoiceRows = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, CUSTOMER_ID));
      expect(invoiceRows).toHaveLength(1);
    });
  });

  describe("8.8: dry-run mode", () => {
    it("should not create billing DB records in dry-run", async () => {
      await seedMonolithCharge({
        chargeId: 1009,
        customerId: MONOLITH_CUST_1,
        amount: 250.0,
        paymentStatus: "paid",
      });

      const summary = await migrationService.migrateAll({
        ...defaultOptions,
        dryRun: true,
      });

      expect(summary.totalCharges).toBe(1);
      expect(summary.succeeded).toBe(1);
      expect(summary.scriptName).toBe("migrate-customer-charges-dry-run");

      // No invoices created
      const db = getTestDatabase();
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

  describe("8.9: ledger balance verification", () => {
    it("should have balanced AR debits and credits for paid charges", async () => {
      await seedMonolithCharge({
        chargeId: 1010,
        customerId: MONOLITH_CUST_1,
        amount: 300.0,
        paymentStatus: "paid",
        paymentDate: new Date("2025-06-15"),
      });

      await migrationService.migrateAll(defaultOptions);

      const db = getTestDatabase();

      // For paid charges: AR is debited during finalization, then credited during payment
      // So total AR debits should equal total AR credits
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
      expect(Number(row.ar_debits)).toBe(30000); // $300 = 30000 cents
    });
  });

  describe("8.10: mixed batch — multiple customers, multiple statuses", () => {
    it("should handle different statuses correctly per customer", async () => {
      // Seed second customer
      await seedCustomer({
        id: CUSTOMER_ID_2,
        monolithCustomerId: MONOLITH_CUST_2,
        stripeCustomerId: "cus_e2e_chg_2",
        name: "Charge Test Customer 2",
        email: "chg2@example.com",
      });
      await seedPaymentMethod({
        id: PM_ID_2,
        customerId: CUSTOMER_ID_2,
        stripePaymentMethodId: "pm_e2e_chg_2",
        type: "card",
        isDefault: true,
      });

      // Customer 1: paid charge
      await seedMonolithCharge({
        chargeId: 1011,
        customerId: MONOLITH_CUST_1,
        amount: 100.0,
        paymentStatus: "paid",
        paymentDate: new Date("2025-06-15"),
      });

      // Customer 1: failed charge
      await seedMonolithCharge({
        chargeId: 1012,
        customerId: MONOLITH_CUST_1,
        amount: 50.0,
        paymentStatus: "failed",
        failureReason: "Insufficient funds",
      });

      // Customer 2: voided charge
      await seedMonolithCharge({
        chargeId: 1013,
        customerId: MONOLITH_CUST_2,
        amount: 200.0,
        paymentStatus: "voided",
      });

      // Customer 2: charge with null amount (should skip)
      await seedMonolithCharge({
        chargeId: 1014,
        customerId: MONOLITH_CUST_2,
        amount: null,
        paymentStatus: "paid",
      });

      const summary = await migrationService.migrateAll(defaultOptions);

      expect(summary.totalCharges).toBe(4);
      expect(summary.succeeded).toBe(3); // paid + failed + voided
      expect(summary.skipped).toBe(1); // null amount

      const db = getTestDatabase();

      // Customer 1: 2 invoices (paid + finalized)
      const cust1Invoices = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, CUSTOMER_ID));
      expect(cust1Invoices).toHaveLength(2);
      const cust1Statuses = cust1Invoices.map((i) => i.status).sort();
      expect(cust1Statuses).toEqual(["finalized", "paid"]);

      // Customer 1: 2 charges (succeeded + failed)
      const cust1Charges = await db
        .select()
        .from(schema.charges)
        .where(eq(schema.charges.customerId, CUSTOMER_ID));
      expect(cust1Charges).toHaveLength(2);

      // Customer 2: 1 invoice (void), 0 charges
      const cust2Invoices = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, CUSTOMER_ID_2));
      expect(cust2Invoices).toHaveLength(1);
      expect(cust2Invoices[0].status).toBe("void");

      const cust2Charges = await db
        .select()
        .from(schema.charges)
        .where(eq(schema.charges.customerId, CUSTOMER_ID_2));
      expect(cust2Charges).toHaveLength(0);
    });
  });
});
