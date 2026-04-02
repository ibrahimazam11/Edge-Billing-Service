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
  seedLedgerAccounts,
  seedInvoice,
  seedCharge,
} from "./helpers/database";
import { WebhookProcessingService } from "../src/webhooks/webhook-processing.service";
import { LedgerService } from "../src/ledger/ledger.service";
import { IdempotencyService } from "../src/integration/sqs/idempotency.service";
import type { StripeWebhookReceivedPayload } from "../src/integration/sqs/contracts/inbound-events";
import type { App } from "supertest/types";

const CUSTOMER_1 = {
  id: "c0000000-0000-4000-a000-000000000050",
  monolithCustomerId: "mono-wh-001",
  stripeCustomerId: "cus_test_wh_001",
  name: "Webhook Test Customer",
  email: "webhook-test@example.com",
};

const PAYMENT_METHOD_1 = {
  id: "b0000000-0000-4000-a000-000000000050",
  customerId: CUSTOMER_1.id,
  stripePaymentMethodId: "pm_test_wh_001",
  type: "card",
  isDefault: true,
  lastFour: "4242",
  brand: "visa",
};

const SUBSCRIPTION_1 = {
  id: "d0000000-0000-4000-a000-000000000050",
  customerId: CUSTOMER_1.id,
  planName: "standard-monthly",
  amountCents: 7500,
  billingPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
  nextBillingDate: new Date("2026-03-01T00:00:00.000Z"),
  status: "active",
};

const INVOICE_1 = {
  id: "e0000000-0000-4000-a000-000000000050",
  customerId: CUSTOMER_1.id,
  subscriptionId: SUBSCRIPTION_1.id,
  status: "finalized",
  totalAmountCents: 7500,
  currency: "usd",
  billingPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
  dueDate: new Date("2026-04-01T00:00:00.000Z"),
  lineItems: [
    {
      id: "f0000000-0000-4000-a000-000000000050",
      type: "base_fee",
      description: "standard-monthly - monthly subscription",
      amountCents: 7500,
      quantity: 1,
    },
  ],
};

const CHARGE_1 = {
  id: "a0000000-0000-4000-a000-000000000050",
  invoiceId: INVOICE_1.id,
  customerId: CUSTOMER_1.id,
  paymentMethodId: PAYMENT_METHOD_1.id,
  amountCents: 7500,
  currency: "usd",
  status: "pending",
  stripePaymentIntentId: "pi_wh_test_001",
  idempotencyKey: `inv_${INVOICE_1.id}_att_1`,
  attemptNumber: 1,
};

function createWebhookPayload(
  type: string,
  data: Record<string, unknown>,
  stripeEventId: string,
  signature = "sig_test",
): StripeWebhookReceivedPayload {
  return { stripeEventId, type, data, signature };
}

describe("Webhooks (e2e)", () => {
  let app: INestApplication<App>;
  let webhookService: WebhookProcessingService;
  let ledgerService: LedgerService;
  let idempotencyService: IdempotencyService;

  beforeAll(async () => {
    await setupTestDatabase();
    app = await createTestApp();
    webhookService = app.get(WebhookProcessingService);
    ledgerService = app.get(LedgerService);
    idempotencyService = app.get(IdempotencyService);
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedLedgerAccounts();
    await ledgerService.onModuleInit();
    await seedCustomer(CUSTOMER_1);
    await seedPaymentMethod(PAYMENT_METHOD_1);
    await seedSubscription(SUBSCRIPTION_1);
  });

  describe("payment_intent.succeeded", () => {
    it("should update invoice to paid and create ledger entries on successful webhook", async () => {
      await seedInvoice(INVOICE_1);
      await seedCharge(CHARGE_1);

      const payload = createWebhookPayload(
        "payment_intent.succeeded",
        { id: "pi_wh_test_001", status: "succeeded", last_payment_error: null },
        "evt_wh_success_001",
      );

      await webhookService.processWebhookEvent(payload, "e2e-corr-wh-001");

      const db = getTestDatabase();

      // Verify invoice status = paid
      const invoiceRows = await db.execute(
        sql`SELECT * FROM invoices WHERE id = ${INVOICE_1.id}`,
      );
      expect(invoiceRows.rows[0].status).toBe("paid");
      expect(invoiceRows.rows[0].paid_at).not.toBeNull();

      // Verify charge status = succeeded
      const chargeRows = await db.execute(
        sql`SELECT * FROM charges WHERE id = ${CHARGE_1.id}`,
      );
      expect(chargeRows.rows[0].status).toBe("succeeded");

      // Verify ledger entry (debit cash, credit AR)
      const ledgerRows = await db.execute(
        sql`SELECT * FROM ledger_entries WHERE reference_type = 'payment' AND reference_id = ${CHARGE_1.id}`,
      );
      expect(ledgerRows.rows).toHaveLength(1);
      expect(ledgerRows.rows[0].amount_cents).toBe(7500);
    });

    it("should be a no-op when invoice is already paid", async () => {
      await seedInvoice({ ...INVOICE_1, status: "paid" });
      await seedCharge({
        ...CHARGE_1,
        status: "succeeded",
      });

      const payload = createWebhookPayload(
        "payment_intent.succeeded",
        { id: "pi_wh_test_001", status: "succeeded", last_payment_error: null },
        "evt_wh_noop_001",
      );

      // Should not throw
      await webhookService.processWebhookEvent(payload, "e2e-corr-wh-002");

      const db = getTestDatabase();

      // Verify no new ledger entries were created
      const ledgerRows = await db.execute(
        sql`SELECT * FROM ledger_entries WHERE reference_type = 'payment' AND reference_id = ${CHARGE_1.id}`,
      );
      expect(ledgerRows.rows).toHaveLength(0);
    });
  });

  describe("payment_intent.payment_failed", () => {
    it("should update charge to failed with failure reason", async () => {
      await seedInvoice(INVOICE_1);
      await seedCharge(CHARGE_1);

      const payload = createWebhookPayload(
        "payment_intent.payment_failed",
        {
          id: "pi_wh_test_001",
          status: "requires_payment_method",
          last_payment_error: {
            code: "card_declined",
            message: "Your card was declined.",
            type: "card_error",
          },
        },
        "evt_wh_fail_001",
      );

      await webhookService.processWebhookEvent(payload, "e2e-corr-wh-003");

      const db = getTestDatabase();

      // Verify charge updated to failed
      const chargeRows = await db.execute(
        sql`SELECT * FROM charges WHERE id = ${CHARGE_1.id}`,
      );
      expect(chargeRows.rows[0].status).toBe("failed");
      expect(chargeRows.rows[0].failure_reason).toBe("Your card was declined.");

      // Invoice should remain finalized (no state change on failure)
      const invoiceRows = await db.execute(
        sql`SELECT * FROM invoices WHERE id = ${INVOICE_1.id}`,
      );
      expect(invoiceRows.rows[0].status).toBe("finalized");
    });
  });

  describe("unknown event types", () => {
    it("should acknowledge unknown event type without error", async () => {
      const payload = createWebhookPayload(
        "charge.dispute.created",
        { id: "dp_test_001" },
        "evt_wh_unknown_001",
      );

      // Should not throw
      await webhookService.processWebhookEvent(payload, "e2e-corr-wh-004");

      // Verify it was marked as processed
      const isProcessed = await idempotencyService.isProcessed(
        "evt_wh_unknown_001",
        "stripe.webhook",
      );
      expect(isProcessed).toBe(true);
    });
  });

  describe("Stripe event ID idempotency", () => {
    it("should process same Stripe event only once", async () => {
      await seedInvoice(INVOICE_1);
      await seedCharge(CHARGE_1);

      const payload = createWebhookPayload(
        "payment_intent.succeeded",
        { id: "pi_wh_test_001", status: "succeeded", last_payment_error: null },
        "evt_wh_idemp_001",
      );

      // First call — should process
      await webhookService.processWebhookEvent(payload, "e2e-corr-wh-005a");

      const db = getTestDatabase();

      // Verify invoice paid
      const firstCheck = await db.execute(
        sql`SELECT * FROM invoices WHERE id = ${INVOICE_1.id}`,
      );
      expect(firstCheck.rows[0].status).toBe("paid");

      // Count ledger entries
      const ledgerBefore = await db.execute(
        sql`SELECT COUNT(*) AS cnt FROM ledger_entries WHERE reference_type = 'payment' AND reference_id = ${CHARGE_1.id}`,
      );
      const countBefore = parseInt(
        (ledgerBefore.rows[0] as { cnt: string }).cnt,
        10,
      );
      expect(countBefore).toBe(1);

      // Second call with same stripeEventId — should be skipped
      await webhookService.processWebhookEvent(payload, "e2e-corr-wh-005b");

      // Verify no additional ledger entries
      const ledgerAfter = await db.execute(
        sql`SELECT COUNT(*) AS cnt FROM ledger_entries WHERE reference_type = 'payment' AND reference_id = ${CHARGE_1.id}`,
      );
      const countAfter = parseInt(
        (ledgerAfter.rows[0] as { cnt: string }).cnt,
        10,
      );
      expect(countAfter).toBe(1);
    });
  });

  describe("no matching charge", () => {
    it("should handle payment_intent.succeeded with no matching charge gracefully", async () => {
      // No charge seeded — only invoice
      await seedInvoice(INVOICE_1);

      const payload = createWebhookPayload(
        "payment_intent.succeeded",
        {
          id: "pi_nonexistent_001",
          status: "succeeded",
          last_payment_error: null,
        },
        "evt_wh_nochg_001",
      );

      // Should not throw
      await webhookService.processWebhookEvent(payload, "e2e-corr-wh-006");

      const db = getTestDatabase();

      // Invoice should remain finalized (no state change since no charge found)
      const invoiceRows = await db.execute(
        sql`SELECT * FROM invoices WHERE id = ${INVOICE_1.id}`,
      );
      expect(invoiceRows.rows[0].status).toBe("finalized");

      // Verify event was still marked as processed
      const isProcessed = await idempotencyService.isProcessed(
        "evt_wh_nochg_001",
        "stripe.webhook",
      );
      expect(isProcessed).toBe(true);
    });

    it("should handle payment_intent.payment_failed with no matching charge gracefully", async () => {
      const payload = createWebhookPayload(
        "payment_intent.payment_failed",
        {
          id: "pi_nonexistent_002",
          status: "requires_payment_method",
          last_payment_error: { message: "Card declined" },
        },
        "evt_wh_nochg_002",
      );

      // Should not throw
      await webhookService.processWebhookEvent(payload, "e2e-corr-wh-007");

      // Verify event was still marked as processed
      const isProcessed = await idempotencyService.isProcessed(
        "evt_wh_nochg_002",
        "stripe.webhook",
      );
      expect(isProcessed).toBe(true);
    });
  });
});
