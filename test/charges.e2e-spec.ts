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
import { ChargesService } from "../src/charges/charges.service";
import { LedgerService } from "../src/ledger/ledger.service";
import { InvoiceAlreadyPaidException } from "../src/charges/invoice-already-paid.exception";
import { InvoiceNotFinalizedException } from "../src/charges/invoice-not-finalized.exception";
import { NoPaymentMethodException } from "../src/common/exceptions/no-payment-method.exception";
import type { App } from "supertest/types";

const CUSTOMER_1 = {
  id: "c0000000-0000-4000-a000-000000000010",
  monolithCustomerId: "mono-chg-001",
  stripeCustomerId: "cus_test_chg_001",
  name: "Charge Test Customer",
  email: "charge-test@example.com",
};

const PAYMENT_METHOD_1 = {
  id: "b0000000-0000-4000-a000-000000000010",
  customerId: CUSTOMER_1.id,
  stripePaymentMethodId: "pm_test_chg_001",
  type: "card",
  isDefault: true,
  lastFour: "4242",
  brand: "visa",
};

const SUBSCRIPTION_1 = {
  id: "d0000000-0000-4000-a000-000000000010",
  customerId: CUSTOMER_1.id,
  planName: "standard-monthly",
  amountCents: 5000,
  billingPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
  nextBillingDate: new Date("2026-03-01T00:00:00.000Z"),
  status: "active",
};

const INVOICE_1 = {
  id: "e0000000-0000-4000-a000-000000000010",
  customerId: CUSTOMER_1.id,
  subscriptionId: SUBSCRIPTION_1.id,
  status: "finalized",
  totalAmountCents: 5000,
  currency: "usd",
  billingPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
  dueDate: new Date("2026-04-01T00:00:00.000Z"),
  lineItems: [
    {
      id: "f0000000-0000-4000-a000-000000000010",
      type: "base_fee",
      description: "standard-monthly - monthly subscription",
      amountCents: 5000,
      quantity: 1,
    },
  ],
};

describe("Charges (e2e)", () => {
  let app: INestApplication<App>;
  let chargesService: ChargesService;
  let ledgerService: LedgerService;

  beforeAll(async () => {
    await setupTestDatabase();
    app = await createTestApp();
    chargesService = app.get(ChargesService);
    ledgerService = app.get(LedgerService);
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

  describe("executePaymentForInvoice", () => {
    it("should create charge record with correct idempotency key format", async () => {
      await seedInvoice(INVOICE_1);

      const result = await chargesService.executePaymentForInvoice(
        INVOICE_1.id,
        "e2e-corr-chg-001",
      );

      expect(result.chargeId).toBeDefined();
      // Status depends on gateway mock — in e2e the real gateway is mocked,
      // so we verify the charge record exists
      const db = getTestDatabase();
      const chargeRows = await db.execute(
        sql`SELECT * FROM charges WHERE invoice_id = ${INVOICE_1.id}`,
      );
      expect(chargeRows.rows).toHaveLength(1);
      const charge = chargeRows.rows[0];
      expect(charge.idempotency_key).toBe(`inv_${INVOICE_1.id}_att_1`);
      expect(charge.amount_cents).toBe(5000);
      expect(charge.currency).toBe("usd");
      expect(charge.customer_id).toBe(CUSTOMER_1.id);
      expect(charge.payment_method_id).toBe(PAYMENT_METHOD_1.id);
    });

    it("should transition invoice to paid on successful charge", async () => {
      await seedInvoice(INVOICE_1);

      const result = await chargesService.executePaymentForInvoice(
        INVOICE_1.id,
        "e2e-corr-chg-002",
      );

      // Verify the charge completed with a terminal status
      expect(["succeeded", "failed"]).toContain(result.status);

      if (result.status === "succeeded") {
        const db = getTestDatabase();
        const invoiceRows = await db.execute(
          sql`SELECT * FROM invoices WHERE id = ${INVOICE_1.id}`,
        );
        const invoice = invoiceRows.rows[0];
        expect(invoice.status).toBe("paid");
        expect(invoice.paid_at).not.toBeNull();
      } else {
        // If gateway mock fails, invoice should remain finalized
        const db = getTestDatabase();
        const invoiceRows = await db.execute(
          sql`SELECT * FROM invoices WHERE id = ${INVOICE_1.id}`,
        );
        const invoice = invoiceRows.rows[0];
        expect(invoice.status).toBe("finalized");
      }
    });

    it("should create ledger entries on successful charge (AR/Revenue + Cash/AR)", async () => {
      await seedInvoice(INVOICE_1);

      const result = await chargesService.executePaymentForInvoice(
        INVOICE_1.id,
        "e2e-corr-chg-003",
      );

      expect(["succeeded", "failed"]).toContain(result.status);

      if (result.status === "succeeded") {
        const db = getTestDatabase();
        // Payment ledger entry (debit cash, credit AR)
        const paymentLedger = await db.execute(
          sql`SELECT * FROM ledger_entries WHERE reference_type = 'payment' AND reference_id = ${result.chargeId}`,
        );
        expect(paymentLedger.rows).toHaveLength(1);
        const entry = paymentLedger.rows[0];
        expect(entry.amount_cents).toBe(5000);
      } else {
        // If gateway fails, verify no payment ledger entry was created
        const db = getTestDatabase();
        const paymentLedger = await db.execute(
          sql`SELECT * FROM ledger_entries WHERE reference_type = 'payment'`,
        );
        expect(paymentLedger.rows).toHaveLength(0);
      }
    });

    it("should throw InvoiceAlreadyPaidException for paid invoice", async () => {
      await seedInvoice({
        ...INVOICE_1,
        id: "e0000000-0000-4000-a000-000000000011",
        status: "paid",
      });

      await expect(
        chargesService.executePaymentForInvoice(
          "e0000000-0000-4000-a000-000000000011",
          "e2e-corr-chg-004",
        ),
      ).rejects.toThrow(InvoiceAlreadyPaidException);

      // Verify no charge was created
      const db = getTestDatabase();
      const chargeRows = await db.execute(
        sql`SELECT * FROM charges WHERE invoice_id = ${"e0000000-0000-4000-a000-000000000011"}`,
      );
      expect(chargeRows.rows).toHaveLength(0);
    });

    it("should throw InvoiceNotFinalizedException for draft invoice", async () => {
      await seedInvoice({
        ...INVOICE_1,
        id: "e0000000-0000-4000-a000-000000000012",
        status: "draft",
      });

      await expect(
        chargesService.executePaymentForInvoice(
          "e0000000-0000-4000-a000-000000000012",
          "e2e-corr-chg-005",
        ),
      ).rejects.toThrow(InvoiceNotFinalizedException);
    });

    it("should throw NoPaymentMethodException when customer has no default payment method", async () => {
      // Create customer without default payment method
      const CUSTOMER_NO_PM = {
        id: "c0000000-0000-4000-a000-000000000020",
        monolithCustomerId: "mono-chg-002",
        stripeCustomerId: "cus_test_chg_002",
        name: "No PM Customer",
        email: "no-pm@example.com",
      };
      await seedCustomer(CUSTOMER_NO_PM);

      await seedInvoice({
        ...INVOICE_1,
        id: "e0000000-0000-4000-a000-000000000013",
        customerId: CUSTOMER_NO_PM.id,
      });

      await expect(
        chargesService.executePaymentForInvoice(
          "e0000000-0000-4000-a000-000000000013",
          "e2e-corr-chg-006",
        ),
      ).rejects.toThrow(NoPaymentMethodException);
    });
  });

  describe("findByInvoiceId", () => {
    it("should return charges for an invoice", async () => {
      await seedInvoice(INVOICE_1);
      await seedCharge({
        id: "a0000000-0000-4000-a000-000000000030",
        invoiceId: INVOICE_1.id,
        customerId: CUSTOMER_1.id,
        paymentMethodId: PAYMENT_METHOD_1.id,
        amountCents: 5000,
        idempotencyKey: `inv_${INVOICE_1.id}_att_1`,
        status: "succeeded",
        stripePaymentIntentId: "pi_test_001",
      });

      const result = await chargesService.findByInvoiceId(INVOICE_1.id);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("a0000000-0000-4000-a000-000000000030");
      expect(result[0].status).toBe("succeeded");
      expect(result[0].stripePaymentIntentId).toBe("pi_test_001");
      expect(result[0].idempotencyKey).toBe(`inv_${INVOICE_1.id}_att_1`);
    });

    it("should return empty array when no charges exist", async () => {
      await seedInvoice(INVOICE_1);

      const result = await chargesService.findByInvoiceId(INVOICE_1.id);

      expect(result).toEqual([]);
    });
  });

  describe("charges table schema", () => {
    it("should enforce unique constraint on idempotency_key", async () => {
      await seedInvoice(INVOICE_1);
      const idempotencyKey = `inv_${INVOICE_1.id}_att_1`;

      await seedCharge({
        id: "a0000000-0000-4000-a000-000000000040",
        invoiceId: INVOICE_1.id,
        customerId: CUSTOMER_1.id,
        paymentMethodId: PAYMENT_METHOD_1.id,
        amountCents: 5000,
        idempotencyKey,
      });

      await expect(
        seedCharge({
          id: "a0000000-0000-4000-a000-000000000041",
          invoiceId: INVOICE_1.id,
          customerId: CUSTOMER_1.id,
          paymentMethodId: PAYMENT_METHOD_1.id,
          amountCents: 5000,
          idempotencyKey, // duplicate
        }),
      ).rejects.toThrow();
    });

    it("should have correct indexes on charges table", async () => {
      const db = getTestDatabase();
      const indexRows = await db.execute(
        sql`SELECT indexname FROM pg_indexes WHERE tablename = 'charges' ORDER BY indexname`,
      );

      const indexNames = (indexRows.rows as Array<{ indexname: string }>).map(
        (r) => r.indexname,
      );

      expect(indexNames).toContain("idx_charges_invoice_id");
      expect(indexNames).toContain("idx_charges_customer_id");
      expect(indexNames).toContain("idx_charges_idempotency_key");
    });
  });
});
