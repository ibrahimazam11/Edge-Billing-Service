import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "drizzle-orm";
import { createTestApp } from "./helpers/test-app";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  seedLedgerAccounts,
  seedCustomer,
  seedPaymentMethod,
  seedSubscription,
  seedInvoice,
  seedDunningAttempt,
} from "./helpers/database";
import { DunningService } from "../src/dunning/dunning.service";

describe("Dunning Scheduling (e2e)", () => {
  let app: INestApplication;
  let dunningService: DunningService;

  const customerId = "c0000000-0000-4000-a000-000000000001";
  const paymentMethodId = "d0000000-0000-4000-a000-000000000001";
  const subscriptionId = "e0000000-0000-4000-a000-000000000001";
  const invoiceId = "f0000000-0000-4000-a000-000000000001";

  beforeAll(async () => {
    await setupTestDatabase();
    await cleanDatabase();
    await seedLedgerAccounts();
    app = await createTestApp();
    dunningService = app.get(DunningService);
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedLedgerAccounts();
  });

  describe("dunning_attempts table", () => {
    it("should exist with correct columns after migration", async () => {
      const db = getTestDatabase();
      const result = await db.execute(sql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'dunning_attempts'
        ORDER BY ordinal_position
      `);

      const columns = result.rows.map(
        (r: Record<string, unknown>) => r.column_name,
      );
      expect(columns).toEqual(
        expect.arrayContaining([
          "id",
          "invoice_id",
          "charge_id",
          "attempt_number",
          "scheduled_date",
          "executed_at",
          "status",
          "failure_reason",
          "created_at",
        ]),
      );
    });

    it("should have idx_dunning_attempts_invoice_id index", async () => {
      const db = getTestDatabase();
      const result = await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'dunning_attempts'
        AND indexname = 'idx_dunning_attempts_invoice_id'
      `);
      expect(result.rows).toHaveLength(1);
    });

    it("should have idx_dunning_attempts_status_scheduled_date index", async () => {
      const db = getTestDatabase();
      const result = await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'dunning_attempts'
        AND indexname = 'idx_dunning_attempts_status_scheduled_date'
      `);
      expect(result.rows).toHaveLength(1);
    });
  });

  describe("charges.stripe_payment_intent_id index", () => {
    it("should have idx_charges_stripe_payment_intent_id index", async () => {
      const db = getTestDatabase();
      const result = await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'charges'
        AND indexname = 'idx_charges_stripe_payment_intent_id'
      `);
      expect(result.rows).toHaveLength(1);
    });
  });

  describe("DunningService.scheduleDunningAttempt", () => {
    beforeEach(async () => {
      await seedCustomer({
        id: customerId,
        monolithCustomerId: "mono-1",
        stripeCustomerId: "cus_stripe_1",
        name: "Test Customer",
        email: "test@example.com",
      });
      await seedPaymentMethod({
        id: paymentMethodId,
        customerId,
        stripePaymentMethodId: "pm_stripe_1",
        type: "card",
        isDefault: true,
      });
      await seedSubscription({
        id: subscriptionId,
        customerId,
        planName: "Pro",
        amountCents: 5000,
        billingPeriodStart: new Date("2026-01-01"),
        billingPeriodEnd: new Date("2026-02-01"),
        nextBillingDate: new Date("2026-02-01"),
        status: "active",
      });
      await seedInvoice({
        id: invoiceId,
        customerId,
        subscriptionId,
        status: "finalized",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-01-01"),
        billingPeriodEnd: new Date("2026-02-01"),
        dueDate: new Date("2026-02-01"),
      });
    });

    it("should create a dunning attempt record in the database", async () => {
      await dunningService.scheduleDunningAttempt(invoiceId, "corr-e2e-1");

      const db = getTestDatabase();
      const result = await db.execute(sql`
        SELECT * FROM dunning_attempts WHERE invoice_id = ${invoiceId}
      `);

      expect(result.rows).toHaveLength(1);
      const attempt = result.rows[0];
      expect(attempt.invoice_id).toBe(invoiceId);
      expect(attempt.attempt_number).toBe(1);
      expect(attempt.status).toBe("scheduled");
      expect(attempt.charge_id).toBeNull();
      expect(attempt.executed_at).toBeNull();
      expect(attempt.failure_reason).toBeNull();
    });

    it("should calculate scheduled_date based on config schedule day 1", async () => {
      const beforeSchedule = new Date();

      await dunningService.scheduleDunningAttempt(invoiceId, "corr-e2e-2");

      const db = getTestDatabase();
      const result = await db.execute(sql`
        SELECT scheduled_date FROM dunning_attempts WHERE invoice_id = ${invoiceId}
      `);

      const scheduledDate = new Date(result.rows[0].scheduled_date as string);
      const expectedDate = new Date(beforeSchedule);
      expectedDate.setDate(expectedDate.getDate() + 1); // default schedule[0] = 1

      // Allow 10 second tolerance
      expect(
        Math.abs(scheduledDate.getTime() - expectedDate.getTime()),
      ).toBeLessThan(10000);
    });

    it("should not create duplicate dunning attempts for same invoice", async () => {
      await dunningService.scheduleDunningAttempt(invoiceId, "corr-e2e-3");
      await dunningService.scheduleDunningAttempt(invoiceId, "corr-e2e-4");

      const db = getTestDatabase();
      const result = await db.execute(sql`
        SELECT * FROM dunning_attempts WHERE invoice_id = ${invoiceId}
      `);

      expect(result.rows).toHaveLength(1);
    });
  });

  describe("DunningService.getScheduledDunningAttempts", () => {
    beforeEach(async () => {
      await seedCustomer({
        id: customerId,
        monolithCustomerId: "mono-1",
        stripeCustomerId: "cus_stripe_1",
        name: "Test Customer",
        email: "test@example.com",
      });
      await seedInvoice({
        id: invoiceId,
        customerId,
        status: "finalized",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-01-01"),
        billingPeriodEnd: new Date("2026-02-01"),
        dueDate: new Date("2026-02-01"),
      });
    });

    it("should return due attempts from real database", async () => {
      // Seed a past-dated scheduled attempt
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000001",
        invoiceId,
        attemptNumber: 1,
        scheduledDate: new Date("2025-01-01"), // past
        status: "scheduled",
      });

      const results = await dunningService.getScheduledDunningAttempts();

      expect(results).toHaveLength(1);
      expect(results[0].invoiceId).toBe(invoiceId);
      expect(results[0].status).toBe("scheduled");
    });

    it("should not return future-dated attempts", async () => {
      // Seed a future-dated scheduled attempt
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000002",
        invoiceId,
        attemptNumber: 1,
        scheduledDate: new Date("2099-12-31"), // far future
        status: "scheduled",
      });

      const results = await dunningService.getScheduledDunningAttempts();

      expect(results).toHaveLength(0);
    });

    it("should not return non-scheduled status attempts", async () => {
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000003",
        invoiceId,
        attemptNumber: 1,
        scheduledDate: new Date("2025-01-01"), // past
        status: "failed",
      });

      const results = await dunningService.getScheduledDunningAttempts();

      expect(results).toHaveLength(0);
    });

    it("should return empty array when no attempts are due", async () => {
      const results = await dunningService.getScheduledDunningAttempts();

      expect(results).toHaveLength(0);
    });
  });

  describe("DunningService.getDunningAttemptsForInvoice", () => {
    beforeEach(async () => {
      await seedCustomer({
        id: customerId,
        monolithCustomerId: "mono-1",
        stripeCustomerId: "cus_stripe_1",
        name: "Test Customer",
        email: "test@example.com",
      });
      await seedInvoice({
        id: invoiceId,
        customerId,
        status: "finalized",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-01-01"),
        billingPeriodEnd: new Date("2026-02-01"),
        dueDate: new Date("2026-02-01"),
      });
    });

    it("should return all attempts for a given invoice", async () => {
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000004",
        invoiceId,
        attemptNumber: 1,
        scheduledDate: new Date("2026-02-02"),
        status: "failed",
        failureReason: "Card declined",
      });
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000005",
        invoiceId,
        attemptNumber: 2,
        scheduledDate: new Date("2026-02-04"),
        status: "scheduled",
      });

      const results =
        await dunningService.getDunningAttemptsForInvoice(invoiceId);

      expect(results).toHaveLength(2);
      expect(results[0].attemptNumber).toBe(1);
      expect(results[1].attemptNumber).toBe(2);
    });
  });

  describe("Dunning config", () => {
    it("should load with correct default schedule via ConfigService", () => {
      const configService = app.get(ConfigService);
      const schedule = configService.get<number[]>("dunning.retryScheduleDays");
      const maxAttempts = configService.get<number>("dunning.maxRetryAttempts");

      expect(schedule).toEqual([1, 3, 5, 7]);
      expect(maxAttempts).toBe(4);
    });
  });
});
