import { INestApplication } from "@nestjs/common";
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
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from "../src/gateway/gateway.interface";
import type { ChargeResult } from "../src/gateway/gateway.types";

describe("Dunning Execution (e2e)", () => {
  let app: INestApplication;
  let dunningService: DunningService;
  let gateway: PaymentGateway;

  const customerId = "c0000000-0000-4000-a000-000000000001";
  const paymentMethodId = "d0000000-0000-4000-a000-000000000001";
  const subscriptionId = "e0000000-0000-4000-a000-000000000001";
  const invoiceId = "f0000000-0000-4000-a000-000000000001";
  const attemptId = "da000000-0000-4000-a000-000000000001";

  beforeAll(async () => {
    await setupTestDatabase();
    await cleanDatabase();
    await seedLedgerAccounts();
    app = await createTestApp();
    dunningService = app.get(DunningService);
    gateway = app.get<PaymentGateway>(PAYMENT_GATEWAY);
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedLedgerAccounts();
    jest.restoreAllMocks();
  });

  function mockChargeResult(
    overrides: Partial<ChargeResult> = {},
  ): ChargeResult {
    return {
      id: "pi_test_default",
      status: "succeeded",
      amount: 5000,
      currency: "usd",
      customerId: "cus_stripe_1",
      paymentMethodId: "pm_stripe_1",
      failureCode: null,
      failureMessage: null,
      metadata: {},
      createdAt: new Date(),
      ...overrides,
    };
  }

  async function seedBaseData() {
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
  }

  describe("executeDunningAttempt — success", () => {
    it("should execute charge, update attempt to succeeded, and mark invoice as paid", async () => {
      await seedBaseData();
      await seedInvoice({
        id: invoiceId,
        customerId,
        subscriptionId,
        status: "finalized",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-01-01"),
        billingPeriodEnd: new Date("2026-02-01"),
        dueDate: new Date("2026-02-01"),
        lineItems: [
          {
            id: "b0000000-0000-4000-a000-000000000001",
            type: "subscription",
            description: "Pro subscription",
            amountCents: 5000,
          },
        ],
      });
      await seedDunningAttempt({
        id: attemptId,
        invoiceId,
        attemptNumber: 2,
        scheduledDate: new Date("2025-01-01"), // past — due
        status: "scheduled",
      });

      // Mock gateway to succeed
      jest
        .spyOn(gateway, "createCharge")
        .mockResolvedValue(mockChargeResult({ id: "pi_test_success" }));

      const result = await dunningService.executeDunningAttempt(
        attemptId,
        "corr-e2e-exec-1",
      );

      expect(result.status).toBe("succeeded");
      expect(result.chargeId).toBeDefined();

      // Verify dunning attempt updated
      const db = getTestDatabase();
      const attempts = await db.execute(
        sql`SELECT * FROM dunning_attempts WHERE id = ${attemptId}`,
      );
      const attempt = attempts.rows[0];
      expect(attempt.status).toBe("succeeded");
      expect(attempt.executed_at).not.toBeNull();
      expect(attempt.charge_id).not.toBeNull();

      // Verify invoice is now paid
      const inv = await db.execute(
        sql`SELECT status FROM invoices WHERE id = ${invoiceId}`,
      );
      expect(inv.rows[0].status).toBe("paid");

      // Verify charge was created
      const charges = await db.execute(
        sql`SELECT * FROM charges WHERE invoice_id = ${invoiceId}`,
      );
      expect(charges.rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("executeDunningAttempt — failure with remaining retries", () => {
    it("should update attempt to failed and schedule next attempt", async () => {
      await seedBaseData();
      await seedInvoice({
        id: invoiceId,
        customerId,
        subscriptionId,
        status: "finalized",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-01-01"),
        billingPeriodEnd: new Date("2026-02-01"),
        dueDate: new Date("2026-02-01"),
        lineItems: [
          {
            id: "b0000000-0000-4000-a000-000000000002",
            type: "subscription",
            description: "Pro subscription",
            amountCents: 5000,
          },
        ],
      });
      await seedDunningAttempt({
        id: attemptId,
        invoiceId,
        attemptNumber: 2,
        scheduledDate: new Date("2025-01-01"),
        status: "scheduled",
      });

      // Mock gateway to fail
      jest
        .spyOn(gateway, "createCharge")
        .mockRejectedValue(new Error("Card declined"));

      const result = await dunningService.executeDunningAttempt(
        attemptId,
        "corr-e2e-exec-2",
      );

      expect(result.status).toBe("failed");

      const db = getTestDatabase();

      // Verify current attempt is failed
      const attempts = await db.execute(
        sql`SELECT * FROM dunning_attempts WHERE id = ${attemptId}`,
      );
      expect(attempts.rows[0].status).toBe("failed");

      // Verify next attempt was scheduled (attemptNumber = 3)
      const nextAttempts = await db.execute(
        sql`SELECT * FROM dunning_attempts WHERE invoice_id = ${invoiceId} AND attempt_number = 3`,
      );
      expect(nextAttempts.rows).toHaveLength(1);
      expect(nextAttempts.rows[0].status).toBe("scheduled");
    });
  });

  describe("executeDunningAttempt — exhausted retries (escalation)", () => {
    it("should escalate when all retries are exhausted", async () => {
      await seedBaseData();
      await seedInvoice({
        id: invoiceId,
        customerId,
        subscriptionId,
        status: "finalized",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-01-01"),
        billingPeriodEnd: new Date("2026-02-01"),
        dueDate: new Date("2026-02-01"),
        lineItems: [
          {
            id: "b0000000-0000-4000-a000-000000000003",
            type: "subscription",
            description: "Pro subscription",
            amountCents: 5000,
          },
        ],
      });

      // Seed previous failed attempts (1-3)
      for (let i = 1; i <= 3; i++) {
        await seedDunningAttempt({
          id: `da00000${i}-0000-4000-a000-000000000001`,
          invoiceId,
          attemptNumber: i,
          scheduledDate: new Date(`2026-02-0${i}`),
          executedAt: new Date(`2026-02-0${i}`),
          status: "failed",
          failureReason: "Card declined",
        });
      }

      // Final attempt (attempt 4 = maxRetryAttempts)
      const finalAttemptId = "da000004-0000-4000-a000-000000000001";
      await seedDunningAttempt({
        id: finalAttemptId,
        invoiceId,
        attemptNumber: 4,
        scheduledDate: new Date("2025-01-01"),
        status: "scheduled",
      });

      // Mock gateway to fail
      jest
        .spyOn(gateway, "createCharge")
        .mockRejectedValue(new Error("Card declined"));

      const result = await dunningService.executeDunningAttempt(
        finalAttemptId,
        "corr-e2e-escalate",
      );

      expect(result.status).toBe("failed");

      const db = getTestDatabase();

      // Verify subscription moved to past_due
      const sub = await db.execute(
        sql`SELECT status FROM subscriptions WHERE id = ${subscriptionId}`,
      );
      expect(sub.rows[0].status).toBe("past_due");

      // Verify NO additional attempt was scheduled (attempt 5 should not exist)
      const nextAttempts = await db.execute(
        sql`SELECT * FROM dunning_attempts WHERE invoice_id = ${invoiceId} AND attempt_number = 5`,
      );
      expect(nextAttempts.rows).toHaveLength(0);
    });
  });

  describe("executeDunningAttempt — skip already-paid invoice", () => {
    it("should skip execution when invoice is already paid", async () => {
      await seedBaseData();
      await seedInvoice({
        id: invoiceId,
        customerId,
        subscriptionId,
        status: "paid", // already paid
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-01-01"),
        billingPeriodEnd: new Date("2026-02-01"),
        dueDate: new Date("2026-02-01"),
      });
      await seedDunningAttempt({
        id: attemptId,
        invoiceId,
        attemptNumber: 2,
        scheduledDate: new Date("2025-01-01"),
        status: "scheduled",
      });

      // Seed another scheduled attempt to verify it gets skipped too
      const attempt2Id = "da000000-0000-4000-a000-000000000002";
      await seedDunningAttempt({
        id: attempt2Id,
        invoiceId,
        attemptNumber: 3,
        scheduledDate: new Date("2025-01-03"),
        status: "scheduled",
      });

      const result = await dunningService.executeDunningAttempt(
        attemptId,
        "corr-e2e-skip",
      );

      expect(result.status).toBe("skipped");

      // Verify no charge was created
      const db = getTestDatabase();
      const charges = await db.execute(
        sql`SELECT * FROM charges WHERE invoice_id = ${invoiceId}`,
      );
      expect(charges.rows).toHaveLength(0);

      // Verify remaining scheduled attempt was also marked as skipped
      const remainingAttempt = await db.execute(
        sql`SELECT status FROM dunning_attempts WHERE id = ${attempt2Id}`,
      );
      expect(remainingAttempt.rows[0].status).toBe("skipped");
    });
  });

  describe("getDunningAttemptsForInvoice — full history", () => {
    it("should return full attempt history with all statuses", async () => {
      await seedBaseData();
      await seedInvoice({
        id: invoiceId,
        customerId,
        status: "finalized",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-01-01"),
        billingPeriodEnd: new Date("2026-02-01"),
        dueDate: new Date("2026-02-01"),
      });

      // Seed multiple attempts with different statuses
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000010",
        invoiceId,
        attemptNumber: 1,
        scheduledDate: new Date("2026-02-02"),
        executedAt: new Date("2026-02-02"),
        status: "failed",
        failureReason: "Card declined",
      });
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000011",
        invoiceId,
        attemptNumber: 2,
        scheduledDate: new Date("2026-02-04"),
        executedAt: new Date("2026-02-04"),
        status: "succeeded",
      });
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000012",
        invoiceId,
        attemptNumber: 3,
        scheduledDate: new Date("2026-02-06"),
        status: "skipped",
      });

      const history =
        await dunningService.getDunningAttemptsForInvoice(invoiceId);

      expect(history).toHaveLength(3);
      expect(history[0].attemptNumber).toBe(1);
      expect(history[0].status).toBe("failed");
      expect(history[0].failureReason).toBe("Card declined");
      expect(history[1].attemptNumber).toBe(2);
      expect(history[1].status).toBe("succeeded");
      expect(history[2].attemptNumber).toBe(3);
      expect(history[2].status).toBe("skipped");
    });
  });

  describe("markRemainingAsSkipped — via success path", () => {
    it("should mark all remaining scheduled attempts as skipped on success", async () => {
      await seedBaseData();
      await seedInvoice({
        id: invoiceId,
        customerId,
        subscriptionId,
        status: "finalized",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-01-01"),
        billingPeriodEnd: new Date("2026-02-01"),
        dueDate: new Date("2026-02-01"),
        lineItems: [
          {
            id: "b0000000-0000-4000-a000-000000000004",
            type: "subscription",
            description: "Pro subscription",
            amountCents: 5000,
          },
        ],
      });

      // Seed current attempt + future scheduled attempts
      await seedDunningAttempt({
        id: attemptId,
        invoiceId,
        attemptNumber: 1,
        scheduledDate: new Date("2025-01-01"),
        status: "scheduled",
      });
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000020",
        invoiceId,
        attemptNumber: 2,
        scheduledDate: new Date("2026-02-05"),
        status: "scheduled",
      });
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000021",
        invoiceId,
        attemptNumber: 3,
        scheduledDate: new Date("2026-02-10"),
        status: "scheduled",
      });

      // Mock gateway to succeed
      jest
        .spyOn(gateway, "createCharge")
        .mockResolvedValue(mockChargeResult({ id: "pi_test_skip" }));

      const result = await dunningService.executeDunningAttempt(
        attemptId,
        "corr-e2e-skip-remaining",
      );

      expect(result.status).toBe("succeeded");

      // Verify remaining attempts are skipped
      const db = getTestDatabase();
      const remaining = await db.execute(
        sql`SELECT id, status FROM dunning_attempts WHERE invoice_id = ${invoiceId} AND status = 'scheduled'`,
      );
      expect(remaining.rows).toHaveLength(0); // No scheduled attempts left

      const skipped = await db.execute(
        sql`SELECT id, status FROM dunning_attempts WHERE invoice_id = ${invoiceId} AND status = 'skipped'`,
      );
      expect(skipped.rows.length).toBeGreaterThanOrEqual(2); // At least attempt 2 and 3 are skipped
    });
  });

  describe("Full dunning lifecycle", () => {
    it("should execute fail → schedule next → fail again → escalate", async () => {
      await seedBaseData();
      await seedInvoice({
        id: invoiceId,
        customerId,
        subscriptionId,
        status: "finalized",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-01-01"),
        billingPeriodEnd: new Date("2026-02-01"),
        dueDate: new Date("2026-02-01"),
        lineItems: [
          {
            id: "b0000000-0000-4000-a000-000000000005",
            type: "subscription",
            description: "Pro subscription",
            amountCents: 5000,
          },
        ],
      });

      // Mock gateway to always fail
      jest
        .spyOn(gateway, "createCharge")
        .mockRejectedValue(new Error("Card declined"));

      // Seed first scheduled attempt
      await seedDunningAttempt({
        id: "da000000-0000-4000-a000-000000000030",
        invoiceId,
        attemptNumber: 1,
        scheduledDate: new Date("2025-01-01"),
        status: "scheduled",
      });

      // Execute attempt 1 — should fail and schedule attempt 2
      const result1 = await dunningService.executeDunningAttempt(
        "da000000-0000-4000-a000-000000000030",
        "corr-lifecycle-1",
      );
      expect(result1.status).toBe("failed");

      // Find the scheduled attempt 2
      const db = getTestDatabase();
      let nextAttempts = await db.execute(
        sql`SELECT id FROM dunning_attempts WHERE invoice_id = ${invoiceId} AND attempt_number = 2 AND status = 'scheduled'`,
      );
      expect(nextAttempts.rows).toHaveLength(1);
      const attempt2Id = nextAttempts.rows[0].id as string;

      // Execute attempt 2 — should fail and schedule attempt 3
      const result2 = await dunningService.executeDunningAttempt(
        attempt2Id,
        "corr-lifecycle-2",
      );
      expect(result2.status).toBe("failed");

      nextAttempts = await db.execute(
        sql`SELECT id FROM dunning_attempts WHERE invoice_id = ${invoiceId} AND attempt_number = 3 AND status = 'scheduled'`,
      );
      expect(nextAttempts.rows).toHaveLength(1);
      const attempt3Id = nextAttempts.rows[0].id as string;

      // Execute attempt 3 — should fail and schedule attempt 4
      const result3 = await dunningService.executeDunningAttempt(
        attempt3Id,
        "corr-lifecycle-3",
      );
      expect(result3.status).toBe("failed");

      nextAttempts = await db.execute(
        sql`SELECT id FROM dunning_attempts WHERE invoice_id = ${invoiceId} AND attempt_number = 4 AND status = 'scheduled'`,
      );
      expect(nextAttempts.rows).toHaveLength(1);
      const attempt4Id = nextAttempts.rows[0].id as string;

      // Execute attempt 4 (final) — should fail and escalate
      const result4 = await dunningService.executeDunningAttempt(
        attempt4Id,
        "corr-lifecycle-4",
      );
      expect(result4.status).toBe("failed");

      // Verify subscription is past_due
      const sub = await db.execute(
        sql`SELECT status FROM subscriptions WHERE id = ${subscriptionId}`,
      );
      expect(sub.rows[0].status).toBe("past_due");

      // Verify NO attempt 5 was scheduled
      const noMore = await db.execute(
        sql`SELECT * FROM dunning_attempts WHERE invoice_id = ${invoiceId} AND attempt_number = 5`,
      );
      expect(noMore.rows).toHaveLength(0);

      // Verify full history
      const history =
        await dunningService.getDunningAttemptsForInvoice(invoiceId);
      expect(history).toHaveLength(4);
      expect(history.every((a) => a.status === "failed")).toBe(true);
    });
  });
});
