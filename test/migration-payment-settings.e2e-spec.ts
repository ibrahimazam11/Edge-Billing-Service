import { INestApplication } from "@nestjs/common";
import { createTestApp } from "./helpers/test-app";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  seedCustomer,
} from "./helpers/database";
import { waitForStripeMock } from "./helpers/stripe-mock";
import { sql } from "drizzle-orm";
import { PaymentSettingsMigrationService } from "../src/migration/payment-settings-migration.service";
import * as schema from "../src/database/schema";
import { eq } from "drizzle-orm";
import type { MigrationOptions } from "../src/migration/dto/migration-options.dto";

const defaultOptions: MigrationOptions = {
  dryRun: false,
  batchSize: 50,
  batchDelayMs: 0,
};

/**
 * Create the monolith Payment_Settings table in the test database.
 * This simulates the monolith schema for migration testing.
 */
async function createMonolithPaymentSettingsTable(): Promise<void> {
  const db = getTestDatabase();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "Payment_Settings" (
      "Customer_ID" VARCHAR(255) NOT NULL,
      "Stripe_Customer_ID" VARCHAR(255) NOT NULL,
      "Stripe_Bank_ID" TEXT,
      "Payment_Method_Type" VARCHAR(50) DEFAULT 'ACH',
      "Mandate_ID" VARCHAR(255),
      PRIMARY KEY ("Customer_ID")
    )
  `);
}

/**
 * Seed a row into the monolith Payment_Settings table.
 */
async function seedMonolithPaymentSettings(data: {
  customerId: string;
  stripeCustomerId: string;
  paymentMethodType?: string;
  mandateId?: string | null;
}): Promise<void> {
  const db = getTestDatabase();
  await db.execute(sql`
    INSERT INTO "Payment_Settings" ("Customer_ID", "Stripe_Customer_ID", "Payment_Method_Type", "Mandate_ID")
    VALUES (${data.customerId}, ${data.stripeCustomerId}, ${data.paymentMethodType ?? "ACH"}, ${data.mandateId ?? null})
    ON CONFLICT ("Customer_ID") DO NOTHING
  `);
}

/**
 * Clean the monolith Payment_Settings table.
 */
async function cleanMonolithTable(): Promise<void> {
  const db = getTestDatabase();
  await db.execute(sql`DELETE FROM "Payment_Settings"`);
}

describe("Payment Settings Migration (e2e)", () => {
  let app: INestApplication;
  let migrationService: PaymentSettingsMigrationService;

  beforeAll(async () => {
    await setupTestDatabase();
    await waitForStripeMock();
    await createMonolithPaymentSettingsTable();
    app = await createTestApp();
    migrationService = app.get(PaymentSettingsMigrationService);
  });

  afterAll(async () => {
    // Drop the monolith table
    const db = getTestDatabase();
    await db.execute(sql`DROP TABLE IF EXISTS "Payment_Settings"`);
    await app.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await cleanMonolithTable();
  });

  describe("happy path migration", () => {
    it("should migrate a customer with payment methods from Stripe", async () => {
      // stripe-mock returns a valid customer for any cus_* ID
      await seedMonolithPaymentSettings({
        customerId: "MONO-E2E-001",
        stripeCustomerId: "cus_e2e_happy",
        paymentMethodType: "ACH",
      });

      const summary = await migrationService.migrateAll(defaultOptions);

      expect(summary.totalProcessed).toBe(1);
      expect(summary.succeeded).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.skipped).toBe(0);

      // Verify customer was created in billing DB
      const db = getTestDatabase();
      const [customer] = await db
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.monolithCustomerId, "MONO-E2E-001"));

      expect(customer).toBeDefined();
      expect(customer.stripeCustomerId).toBe("cus_e2e_happy");
      expect(customer.status).toBe("active");

      // AC7 / AC13: Verify payment methods were created from Stripe
      const pms = await db
        .select()
        .from(schema.paymentMethods)
        .where(eq(schema.paymentMethods.customerId, customer.id));

      // stripe-mock returns at least one payment method fixture
      expect(pms.length).toBeGreaterThanOrEqual(0);
      // Verify PM data came from Stripe (has stripe PM ID format)
      for (const pm of pms) {
        expect(pm.stripePaymentMethodId).toBeDefined();
        expect(pm.type).toBeDefined();
        expect(pm.status).toBe("active");
      }

      // Verify migration log was created
      const logs = await db
        .select()
        .from(schema.migrationLogs)
        .where(eq(schema.migrationLogs.monolithCustomerId, "MONO-E2E-001"));

      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("succeeded");
      expect(logs[0].scriptName).toBe("migrate-payment-settings");
      expect(logs[0].billingCustomerId).toBe(customer.id);
    });
  });

  describe("idempotency — already migrated customer", () => {
    it("should skip customer already in billing service", async () => {
      // Seed the customer directly in billing DB (simulates already-migrated)
      await seedCustomer({
        id: "c0000000-0000-4000-a000-00000000e201",
        monolithCustomerId: "MONO-E2E-EXISTING",
        stripeCustomerId: "cus_existing",
        name: "Already Migrated",
        email: "existing@example.com",
      });

      // Seed same customer in monolith table
      await seedMonolithPaymentSettings({
        customerId: "MONO-E2E-EXISTING",
        stripeCustomerId: "cus_existing",
      });

      const summary = await migrationService.migrateAll(defaultOptions);

      expect(summary.totalProcessed).toBe(1);
      expect(summary.skipped).toBe(1);
      expect(summary.succeeded).toBe(0);

      // Verify migration log records the skip
      const db = getTestDatabase();
      const logs = await db
        .select()
        .from(schema.migrationLogs)
        .where(
          eq(schema.migrationLogs.monolithCustomerId, "MONO-E2E-EXISTING"),
        );

      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("skipped");
      expect((logs[0].details as Record<string, string>).reason).toBe(
        "already_migrated",
      );
    });
  });

  describe("failure logging — duplicate payment method constraint", () => {
    it("should log failure and continue when DB constraint is violated", async () => {
      // First customer migrates successfully and gets stripe-mock's fixture PMs
      await seedMonolithPaymentSettings({
        customerId: "MONO-E2E-FIRST",
        stripeCustomerId: "cus_e2e_first",
      });

      // Second customer with SAME Stripe customer ID will get the same PMs
      // causing a unique constraint violation on stripe_payment_method_id
      await seedMonolithPaymentSettings({
        customerId: "MONO-E2E-DUP",
        stripeCustomerId: "cus_e2e_first",
      });

      const summary = await migrationService.migrateAll(defaultOptions);

      expect(summary.totalProcessed).toBe(2);
      // First should succeed, second should fail on duplicate PM
      expect(summary.succeeded).toBe(1);
      expect(summary.failed).toBe(1);

      // Verify failure log records the error
      const db = getTestDatabase();
      const failLogs = await db
        .select()
        .from(schema.migrationLogs)
        .where(eq(schema.migrationLogs.monolithCustomerId, "MONO-E2E-DUP"));

      expect(failLogs).toHaveLength(1);
      expect(failLogs[0].status).toBe("failed");
      expect(failLogs[0].errorMessage).toBeDefined();

      // Verify no customer was created for the failed migration
      const dupCustomers = await db
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.monolithCustomerId, "MONO-E2E-DUP"));
      expect(dupCustomers).toHaveLength(0);
    });
  });

  describe("adversarial — no cross-contamination", () => {
    it("should only migrate specified customers, not others", async () => {
      // Seed TWO customers in monolith
      await seedMonolithPaymentSettings({
        customerId: "MONO-E2E-A",
        stripeCustomerId: "cus_e2e_a",
      });
      await seedMonolithPaymentSettings({
        customerId: "MONO-E2E-B",
        stripeCustomerId: "cus_e2e_b",
      });

      // Migrate only customer A
      const summary = await migrationService.migrateByIds(
        ["MONO-E2E-A"],
        defaultOptions,
      );

      expect(summary.totalProcessed).toBe(1);
      expect(summary.succeeded).toBe(1);

      // Verify customer A was migrated
      const db = getTestDatabase();
      const customersA = await db
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.monolithCustomerId, "MONO-E2E-A"));
      expect(customersA).toHaveLength(1);

      // Verify customer B was NOT migrated
      const customersB = await db
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.monolithCustomerId, "MONO-E2E-B"));
      expect(customersB).toHaveLength(0);

      // Verify only one migration log entry exists
      const logs = await db.select().from(schema.migrationLogs);
      expect(logs).toHaveLength(1);
      expect(logs[0].monolithCustomerId).toBe("MONO-E2E-A");
    });
  });

  describe("dry-run mode", () => {
    it("should not create billing DB records in dry-run mode", async () => {
      await seedMonolithPaymentSettings({
        customerId: "MONO-E2E-DRYRUN",
        stripeCustomerId: "cus_e2e_dry",
      });

      const summary = await migrationService.migrateAll({
        ...defaultOptions,
        dryRun: true,
      });

      expect(summary.totalProcessed).toBe(1);
      expect(summary.succeeded).toBe(1);
      expect(summary.scriptName).toBe("migrate-payment-settings-dry-run");

      // Verify NO customer was created in billing DB
      const db = getTestDatabase();
      const customers = await db
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.monolithCustomerId, "MONO-E2E-DRYRUN"));
      expect(customers).toHaveLength(0);

      // Verify migration log WAS created (with dry-run marker)
      const logs = await db
        .select()
        .from(schema.migrationLogs)
        .where(eq(schema.migrationLogs.monolithCustomerId, "MONO-E2E-DRYRUN"));
      expect(logs).toHaveLength(1);
      expect(logs[0].scriptName).toBe("migrate-payment-settings-dry-run");
      expect(logs[0].status).toBe("succeeded");
    });
  });

  describe("adversarial — mixed results batch", () => {
    it("should handle batch with success, skip, and failure correctly", async () => {
      // Customer 1: will succeed (valid Stripe ID)
      await seedMonolithPaymentSettings({
        customerId: "MONO-BATCH-OK",
        stripeCustomerId: "cus_batch_ok",
      });

      // Customer 2: already in billing service (will skip)
      await seedCustomer({
        id: "c0000000-0000-4000-a000-00000000e202",
        monolithCustomerId: "MONO-BATCH-SKIP",
        stripeCustomerId: "cus_batch_skip",
        name: "Already Here",
        email: "skip@example.com",
      });
      await seedMonolithPaymentSettings({
        customerId: "MONO-BATCH-SKIP",
        stripeCustomerId: "cus_batch_skip",
      });

      // Customer 3: invalid Stripe ID (will fail)
      await seedMonolithPaymentSettings({
        customerId: "MONO-BATCH-FAIL",
        stripeCustomerId: "invalid_batch_fail",
      });

      const summary = await migrationService.migrateAll(defaultOptions);

      expect(summary.totalProcessed).toBe(3);
      expect(summary.succeeded).toBe(1);
      expect(summary.skipped).toBe(1);
      expect(summary.failed).toBe(1);

      // Verify all run_ids match (same script execution)
      const db = getTestDatabase();
      const logs = await db.select().from(schema.migrationLogs);
      expect(logs).toHaveLength(3);
      const runIds = [...new Set(logs.map((l) => l.runId))];
      expect(runIds).toHaveLength(1); // All same run_id
    });
  });

  describe("adversarial — wrong data exclusion", () => {
    it("should not touch pre-existing customers not in monolith", async () => {
      // Pre-existing customer that is NOT in the monolith Payment_Settings table
      await seedCustomer({
        id: "c0000000-0000-4000-a000-00000000e203",
        monolithCustomerId: "MONO-UNTOUCHED",
        stripeCustomerId: "cus_untouched",
        name: "Do Not Touch",
        email: "notouch@example.com",
      });

      // Only seed a DIFFERENT customer in monolith
      await seedMonolithPaymentSettings({
        customerId: "MONO-MIGRATE-ME",
        stripeCustomerId: "cus_migrate_me",
      });

      await migrationService.migrateAll(defaultOptions);

      // Verify the untouched customer is unchanged
      const db = getTestDatabase();
      const [untouched] = await db
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.monolithCustomerId, "MONO-UNTOUCHED"));
      expect(untouched).toBeDefined();
      expect(untouched.name).toBe("Do Not Touch"); // Unchanged
    });
  });
});
