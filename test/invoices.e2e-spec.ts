import { INestApplication } from "@nestjs/common";
import request from "supertest";
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
} from "./helpers/database";
import { signRequest } from "./helpers/hmac-signer";
import { InvoicesService } from "../src/invoices/invoices.service";
import { LedgerService } from "../src/ledger/ledger.service";
import type { App } from "supertest/types";

const CUSTOMER_1 = {
  id: "c0000000-0000-4000-a000-000000000001",
  monolithCustomerId: "mono-inv-001",
  name: "Invoice Test Customer",
  email: "invoice-test@example.com",
};

const PAYMENT_METHOD_1 = {
  id: "b0000000-0000-4000-a000-000000000001",
  customerId: CUSTOMER_1.id,
  stripePaymentMethodId: "spm_inv_001",
  type: "card",
};

const SUBSCRIPTION_1 = {
  id: "d0000000-0000-4000-a000-000000000001",
  customerId: CUSTOMER_1.id,
  planName: "standard-monthly",
  amountCents: 5000,
  billingPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
  nextBillingDate: new Date("2026-03-01T00:00:00.000Z"),
  status: "active",
};

const INVOICE_1 = {
  id: "e0000000-0000-4000-a000-000000000001",
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
      id: "f0000000-0000-4000-a000-000000000001",
      type: "base_fee",
      description: "standard-monthly - monthly subscription",
      amountCents: 5000,
      quantity: 1,
    },
  ],
};

describe("Invoices API (e2e)", () => {
  let app: INestApplication<App>;
  let invoicesService: InvoicesService;
  let ledgerService: LedgerService;

  beforeAll(async () => {
    await setupTestDatabase();
    app = await createTestApp();
    invoicesService = app.get(InvoicesService);
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
  });

  describe("GET /v1/invoices/:id", () => {
    it("should return seeded invoice with line items (200)", async () => {
      await seedSubscription(SUBSCRIPTION_1);
      await seedInvoice(INVOICE_1);

      const headers = signRequest("GET", `/v1/invoices/${INVOICE_1.id}`);

      const response = await request(app.getHttpServer())
        .get(`/v1/invoices/${INVOICE_1.id}`)
        .set(headers)
        .expect(200);

      expect(response.body).toMatchObject({
        id: INVOICE_1.id,
        customerId: CUSTOMER_1.id,
        subscriptionId: SUBSCRIPTION_1.id,
        status: "finalized",
        totalAmountCents: 5000,
        currency: "usd",
      });
      expect(response.body.lineItems).toHaveLength(1);
      expect(response.body.lineItems[0]).toMatchObject({
        type: "base_fee",
        amountCents: 5000,
      });
    });

    it("should return 404 when invoice not found", async () => {
      const fakeId = "a0000000-0000-4000-a000-000000000099";
      const headers = signRequest("GET", `/v1/invoices/${fakeId}`);

      await request(app.getHttpServer())
        .get(`/v1/invoices/${fakeId}`)
        .set(headers)
        .expect(404);
    });
  });

  describe("GET /v1/invoices", () => {
    it("should return paginated list filtered by customerId", async () => {
      await seedSubscription(SUBSCRIPTION_1);
      await seedInvoice(INVOICE_1);

      const headers = signRequest("GET", "/v1/invoices");

      const response = await request(app.getHttpServer())
        .get("/v1/invoices")
        .query({ customerId: CUSTOMER_1.id })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].customerId).toBe(CUSTOMER_1.id);
      expect(response.body.hasMore).toBe(false);
    });

    it("should return paginated list filtered by status", async () => {
      await seedSubscription(SUBSCRIPTION_1);
      await seedInvoice(INVOICE_1);

      const headers = signRequest("GET", "/v1/invoices");

      const response = await request(app.getHttpServer())
        .get("/v1/invoices")
        .query({ status: "finalized" })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].status).toBe("finalized");
    });

    it("should return empty list when no invoices match", async () => {
      const headers = signRequest("GET", "/v1/invoices");

      const response = await request(app.getHttpServer())
        .get("/v1/invoices")
        .query({ status: "paid" })
        .set(headers)
        .expect(200);

      expect(response.body.data).toEqual([]);
      expect(response.body.hasMore).toBe(false);
    });
  });

  describe("Invoice Generation", () => {
    it("should create invoice + line items + ledger entry for active subscription with due billing date", async () => {
      await seedSubscription(SUBSCRIPTION_1);

      const result = await invoicesService.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "e2e-corr-001",
      );

      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);

      // Verify invoice in DB
      const db = getTestDatabase();
      const invoiceRows = await db.execute(
        sql`SELECT * FROM invoices WHERE subscription_id = ${SUBSCRIPTION_1.id}`,
      );
      expect(invoiceRows.rows).toHaveLength(1);
      const invoice = invoiceRows.rows[0];
      expect(invoice.status).toBe("finalized");
      expect(invoice.total_amount_cents).toBe(5000);
      expect(invoice.currency).toBe("usd");

      // Verify line items in DB
      const lineItemRows = await db.execute(
        sql`SELECT * FROM invoice_line_items WHERE invoice_id = ${invoice.id as string}`,
      );
      expect(lineItemRows.rows).toHaveLength(1);
      const lineItem = lineItemRows.rows[0];
      expect(lineItem.type).toBe("base_fee");
      expect(lineItem.amount_cents).toBe(5000);

      // Verify ledger entry in DB
      const ledgerRows = await db.execute(
        sql`SELECT * FROM ledger_entries WHERE reference_id = ${invoice.id as string}`,
      );
      expect(ledgerRows.rows).toHaveLength(1);
      const ledgerEntry = ledgerRows.rows[0];
      expect(ledgerEntry.reference_type).toBe("invoice");
      expect(ledgerEntry.amount_cents).toBe(5000);
    });

    it("should skip subscriptions not yet due (nextBillingDate > today)", async () => {
      const futureSubscription = {
        ...SUBSCRIPTION_1,
        id: "d0000000-0000-4000-a000-000000000002",
        nextBillingDate: new Date("2026-04-01T00:00:00.000Z"),
      };
      await seedSubscription(futureSubscription);

      const result = await invoicesService.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "e2e-corr-002",
      );

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(0);

      const db = getTestDatabase();
      const invoiceRows = await db.execute(
        sql`SELECT * FROM invoices WHERE subscription_id = ${futureSubscription.id}`,
      );
      expect(invoiceRows.rows).toHaveLength(0);
    });

    it("should be idempotent — re-running for same period creates no duplicates", async () => {
      await seedSubscription(SUBSCRIPTION_1);

      // First run
      const result1 = await invoicesService.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "e2e-corr-003a",
      );
      expect(result1.created).toBe(1);

      // Second run — same period
      const result2 = await invoicesService.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "e2e-corr-003b",
      );
      expect(result2.created).toBe(0);
      expect(result2.skipped).toBe(1);

      // Verify only one invoice exists
      const db = getTestDatabase();
      const invoiceRows = await db.execute(
        sql`SELECT * FROM invoices WHERE subscription_id = ${SUBSCRIPTION_1.id}`,
      );
      expect(invoiceRows.rows).toHaveLength(1);
    });
  });
});
