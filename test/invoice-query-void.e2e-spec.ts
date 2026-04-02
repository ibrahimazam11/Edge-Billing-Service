import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { App } from "supertest/types";
import { sql } from "drizzle-orm";
import { createTestApp } from "./helpers/test-app";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  seedCustomer,
  seedLedgerAccounts,
  seedInvoice,
  seedSubscription,
} from "./helpers/database";
import { signRequest } from "./helpers/hmac-signer";

const CUSTOMER_ID = "c0000000-0000-4000-a000-000000000036";
const CUSTOMER_ID_2 = "c0000000-0000-4000-a000-000000000037";
const SUBSCRIPTION_ID = "d0000000-0000-4000-a000-000000000036";
const INVOICE_FINALIZED_ID = "e0000000-0000-4000-a000-000000000036";
const INVOICE_PAID_ID = "e0000000-0000-4000-a000-000000000037";
const INVOICE_DRAFT_ID = "e0000000-0000-4000-a000-000000000038";
const INVOICE_VOID_ID = "e0000000-0000-4000-a000-000000000039";
const INVOICE_CUST2_ID = "e0000000-0000-4000-a000-000000000040";
const LINE_ITEM_1_ID = "f0000000-0000-4000-a000-000000000036";
const LINE_ITEM_2_ID = "f0000000-0000-4000-a000-000000000037";

describe("Invoice Query & Void (e2e)", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    await setupTestDatabase();
    await seedLedgerAccounts();
    app = await createTestApp();
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedLedgerAccounts();

    await seedCustomer({
      id: CUSTOMER_ID,
      monolithCustomerId: "mono-036",
      name: "Query Void Test Customer",
      email: "queryvoid@test.com",
    });

    await seedCustomer({
      id: CUSTOMER_ID_2,
      monolithCustomerId: "mono-037",
      name: "Second Customer",
      email: "second@test.com",
    });

    await seedSubscription({
      id: SUBSCRIPTION_ID,
      customerId: CUSTOMER_ID,
      planName: "standard-monthly",
      amountCents: 5000,
      billingPeriodStart: new Date("2026-03-01"),
      billingPeriodEnd: new Date("2026-04-01"),
      nextBillingDate: new Date("2026-04-01"),
      status: "active",
    });
  });

  describe("GET /v1/invoices/:id", () => {
    it("should return invoice with line items (200)", async () => {
      await seedInvoice({
        id: INVOICE_FINALIZED_ID,
        customerId: CUSTOMER_ID,
        subscriptionId: SUBSCRIPTION_ID,
        status: "finalized",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-03-01"),
        billingPeriodEnd: new Date("2026-04-01"),
        dueDate: new Date("2026-04-01"),
        lineItems: [
          {
            id: LINE_ITEM_1_ID,
            type: "base_fee",
            description: "standard-monthly - monthly subscription",
            amountCents: 5000,
          },
        ],
      });

      const headers = signRequest(
        "GET",
        `/v1/invoices/${INVOICE_FINALIZED_ID}`,
      );
      const response = await request(app.getHttpServer())
        .get(`/v1/invoices/${INVOICE_FINALIZED_ID}`)
        .set(headers)
        .expect(200);

      expect(response.body).toMatchObject({
        id: INVOICE_FINALIZED_ID,
        customerId: CUSTOMER_ID,
        subscriptionId: SUBSCRIPTION_ID,
        status: "finalized",
        totalAmountCents: 5000,
        currency: "usd",
      });
      expect(response.body.lineItems).toHaveLength(1);
      expect(response.body.lineItems[0]).toMatchObject({
        id: LINE_ITEM_1_ID,
        type: "base_fee",
        amountCents: 5000,
        quantity: 1,
      });
      expect(response.body.createdAt).toBeDefined();
      expect(response.body.updatedAt).toBeDefined();
    });

    it("should return 404 for non-existent invoice", async () => {
      const nonExistentId = "e0000000-0000-4000-a000-000000000099";
      const headers = signRequest("GET", `/v1/invoices/${nonExistentId}`);
      await request(app.getHttpServer())
        .get(`/v1/invoices/${nonExistentId}`)
        .set(headers)
        .expect(404);
    });
  });

  describe("POST /v1/invoices/:id/void", () => {
    it("should void a finalized invoice, verify DB state and ledger entries", async () => {
      await seedInvoice({
        id: INVOICE_FINALIZED_ID,
        customerId: CUSTOMER_ID,
        subscriptionId: SUBSCRIPTION_ID,
        status: "finalized",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-03-01"),
        billingPeriodEnd: new Date("2026-04-01"),
        dueDate: new Date("2026-04-01"),
        lineItems: [
          {
            id: LINE_ITEM_1_ID,
            type: "base_fee",
            description: "standard-monthly - monthly subscription",
            amountCents: 5000,
          },
        ],
      });

      const path = `/v1/invoices/${INVOICE_FINALIZED_ID}/void`;
      const headers = signRequest("POST", path);
      const response = await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .set("x-correlation-id", "e2e-void-corr")
        .expect(200);

      expect(response.body).toMatchObject({
        id: INVOICE_FINALIZED_ID,
        status: "void",
      });
      expect(response.body.voidedAt).toBeDefined();
      expect(response.body.lineItems).toHaveLength(1);

      // Verify DB state
      const db = getTestDatabase();
      const dbInvoice = await db.execute(
        sql`SELECT status, voided_at FROM invoices WHERE id = ${INVOICE_FINALIZED_ID}`,
      );
      expect((dbInvoice.rows[0] as { status: string }).status).toBe("void");
      expect(
        (dbInvoice.rows[0] as { voided_at: Date | null }).voided_at,
      ).not.toBeNull();

      // Verify ledger entries created
      const ledger = await db.execute(
        sql`SELECT reference_type, amount_cents, debit_account_id, credit_account_id
            FROM ledger_entries
            WHERE reference_id = ${INVOICE_FINALIZED_ID} AND reference_type = 'invoice_void'`,
      );
      expect(ledger.rows).toHaveLength(1);
      const entry = ledger.rows[0] as {
        reference_type: string;
        amount_cents: number;
        debit_account_id: string;
        credit_account_id: string;
      };
      expect(entry.reference_type).toBe("invoice_void");
      expect(entry.amount_cents).toBe(5000);
      // Revenue = a0000000-0000-4000-a000-000000000002 (debit)
      // AR = a0000000-0000-4000-a000-000000000001 (credit)
      expect(entry.debit_account_id).toBe(
        "a0000000-0000-4000-a000-000000000002",
      );
      expect(entry.credit_account_id).toBe(
        "a0000000-0000-4000-a000-000000000001",
      );
    });

    it("should return 409 when voiding a paid invoice", async () => {
      await seedInvoice({
        id: INVOICE_PAID_ID,
        customerId: CUSTOMER_ID,
        status: "paid",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-03-01"),
        billingPeriodEnd: new Date("2026-04-01"),
        dueDate: new Date("2026-04-01"),
      });
      // Set paidAt
      const db = getTestDatabase();
      await db.execute(
        sql`UPDATE invoices SET paid_at = NOW() WHERE id = ${INVOICE_PAID_ID}`,
      );

      const path = `/v1/invoices/${INVOICE_PAID_ID}/void`;
      const headers = signRequest("POST", path);
      const response = await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .set("x-correlation-id", "e2e-void-paid")
        .expect(409);

      expect(response.body.details).toMatchObject({
        errorCode: "INVOICE_ALREADY_PAID",
      });
    });

    it("should return 409 when voiding a draft invoice", async () => {
      await seedInvoice({
        id: INVOICE_DRAFT_ID,
        customerId: CUSTOMER_ID,
        status: "draft",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-03-01"),
        billingPeriodEnd: new Date("2026-04-01"),
        dueDate: new Date("2026-04-01"),
      });

      const path = `/v1/invoices/${INVOICE_DRAFT_ID}/void`;
      const headers = signRequest("POST", path);
      const response = await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .set("x-correlation-id", "e2e-void-draft")
        .expect(409);

      expect(response.body.details).toMatchObject({
        errorCode: "INVOICE_NOT_FINALIZED",
      });
    });

    it("should return 409 when voiding an already voided invoice", async () => {
      await seedInvoice({
        id: INVOICE_VOID_ID,
        customerId: CUSTOMER_ID,
        status: "void",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-03-01"),
        billingPeriodEnd: new Date("2026-04-01"),
        dueDate: new Date("2026-04-01"),
      });
      const db = getTestDatabase();
      await db.execute(
        sql`UPDATE invoices SET voided_at = NOW() WHERE id = ${INVOICE_VOID_ID}`,
      );

      const path = `/v1/invoices/${INVOICE_VOID_ID}/void`;
      const headers = signRequest("POST", path);
      const response = await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .set("x-correlation-id", "e2e-void-void")
        .expect(409);

      expect(response.body.details).toMatchObject({
        errorCode: "INVOICE_ALREADY_VOIDED",
      });
    });

    it("should return 404 when voiding a non-existent invoice", async () => {
      const nonExistentId = "e0000000-0000-4000-a000-000000000099";
      const path = `/v1/invoices/${nonExistentId}/void`;
      const headers = signRequest("POST", path);
      await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .set("x-correlation-id", "e2e-void-404")
        .expect(404);
    });
  });

  describe("GET /v1/invoices", () => {
    beforeEach(async () => {
      // Seed multiple invoices for list/filter tests
      await seedInvoice({
        id: INVOICE_FINALIZED_ID,
        customerId: CUSTOMER_ID,
        subscriptionId: SUBSCRIPTION_ID,
        status: "finalized",
        totalAmountCents: 5000,
        billingPeriodStart: new Date("2026-03-01"),
        billingPeriodEnd: new Date("2026-04-01"),
        dueDate: new Date("2026-04-01"),
        lineItems: [
          {
            id: LINE_ITEM_1_ID,
            type: "base_fee",
            description: "standard-monthly - monthly subscription",
            amountCents: 5000,
          },
        ],
      });

      await seedInvoice({
        id: INVOICE_PAID_ID,
        customerId: CUSTOMER_ID,
        status: "paid",
        totalAmountCents: 3000,
        billingPeriodStart: new Date("2026-02-01"),
        billingPeriodEnd: new Date("2026-03-01"),
        dueDate: new Date("2026-03-01"),
        lineItems: [
          {
            id: LINE_ITEM_2_ID,
            type: "base_fee",
            description: "standard-monthly - monthly subscription",
            amountCents: 3000,
          },
        ],
      });

      await seedInvoice({
        id: INVOICE_CUST2_ID,
        customerId: CUSTOMER_ID_2,
        status: "finalized",
        totalAmountCents: 7500,
        billingPeriodStart: new Date("2026-03-01"),
        billingPeriodEnd: new Date("2026-04-01"),
        dueDate: new Date("2026-04-01"),
      });
    });

    it("should return paginated list", async () => {
      const headers = signRequest("GET", "/v1/invoices");
      const response = await request(app.getHttpServer())
        .get("/v1/invoices")
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(3);
      expect(response.body.hasMore).toBe(false);
    });

    it("should filter by customerId", async () => {
      const headers = signRequest("GET", "/v1/invoices");
      const response = await request(app.getHttpServer())
        .get(`/v1/invoices?customerId=${CUSTOMER_ID}`)
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      for (const inv of response.body.data as Array<{ customerId: string }>) {
        expect(inv.customerId).toBe(CUSTOMER_ID);
      }
    });

    it("should filter by status", async () => {
      const headers = signRequest("GET", "/v1/invoices");
      const response = await request(app.getHttpServer())
        .get("/v1/invoices?status=finalized")
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      for (const inv of response.body.data as Array<{ status: string }>) {
        expect(inv.status).toBe("finalized");
      }
    });

    it("should filter by date range using createdAt", async () => {
      // All invoices were created "now" during beforeEach.
      // Use a range that includes today.
      const today = new Date();
      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - 1);
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 1);

      const headers = signRequest("GET", "/v1/invoices");
      const response = await request(app.getHttpServer())
        .get(
          `/v1/invoices?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`,
        )
        .set(headers)
        .expect(200);

      expect(response.body.data.length).toBeGreaterThanOrEqual(3);
    });

    it("should return next page with cursor", async () => {
      const headers = signRequest("GET", "/v1/invoices");
      const response1 = await request(app.getHttpServer())
        .get("/v1/invoices?limit=1")
        .set(headers)
        .expect(200);

      expect(response1.body.data).toHaveLength(1);
      expect(response1.body.hasMore).toBe(true);
      expect(response1.body.cursor).toBeDefined();

      const cursor = response1.body.cursor as string;
      const response2 = await request(app.getHttpServer())
        .get(`/v1/invoices?limit=1&cursor=${cursor}`)
        .set(headers)
        .expect(200);

      expect(response2.body.data).toHaveLength(1);
      expect((response2.body.data[0] as { id: string }).id).not.toBe(
        (response1.body.data[0] as { id: string }).id,
      );
    });

    it("should return 400 for invalid status", async () => {
      const headers = signRequest("GET", "/v1/invoices");
      await request(app.getHttpServer())
        .get("/v1/invoices?status=invalid")
        .set(headers)
        .expect(400);
    });
  });
});
