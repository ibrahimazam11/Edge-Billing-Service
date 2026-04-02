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
  seedSubscription,
  seedLedgerAccounts,
  seedInvoice,
} from "./helpers/database";
import { signRequest } from "./helpers/hmac-signer";
import type { App } from "supertest/types";

const CUSTOMER_1 = {
  id: "c0000000-0000-4000-a000-000000000001",
  monolithCustomerId: "mono-credit-001",
  name: "Credit Test Customer",
  email: "credit-test@example.com",
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
  id: "a0000000-0000-4000-a000-000000000010",
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
      description: "standard-monthly subscription",
      amountCents: 5000,
      quantity: 1,
    },
  ],
};

describe("Credits API (e2e)", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    await setupTestDatabase();
    await cleanDatabase();
    await seedLedgerAccounts();
    app = await createTestApp();
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedLedgerAccounts();
    await seedCustomer(CUSTOMER_1);
    await seedSubscription(SUBSCRIPTION_1);
    await seedInvoice(INVOICE_1);
  });

  describe("POST /v1/credit-notes", () => {
    it("should create a credit note and return 201", async () => {
      const body = {
        customerId: CUSTOMER_1.id,
        invoiceId: INVOICE_1.id,
        amountCents: 2000,
        reason: "Billing adjustment",
        createdBy: "admin-user",
      };

      const headers = signRequest("POST", "/v1/credit-notes", body);
      const response = await request(app.getHttpServer())
        .post("/v1/credit-notes")
        .set(headers)
        .send(body);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        customerId: CUSTOMER_1.id,
        invoiceId: INVOICE_1.id,
        amountCents: 2000,
        currency: "usd",
        reason: "Billing adjustment",
        status: "issued",
        createdBy: "admin-user",
      });
      expect(response.body.id).toBeDefined();
      expect(response.body.createdAt).toBeDefined();
    });

    it("should create credit note and verify DB state", async () => {
      const body = {
        customerId: CUSTOMER_1.id,
        invoiceId: INVOICE_1.id,
        amountCents: 2000,
        reason: "DB state verification",
      };

      const headers = signRequest("POST", "/v1/credit-notes", body);
      const response = await request(app.getHttpServer())
        .post("/v1/credit-notes")
        .set(headers)
        .send(body);

      expect(response.status).toBe(201);

      // Verify credit_notes table
      const testDb = getTestDatabase();
      const creditNoteRows = await testDb.execute(
        sql`SELECT * FROM credit_notes WHERE id = ${response.body.id}`,
      );
      expect(creditNoteRows.rows).toHaveLength(1);
      expect(creditNoteRows.rows[0].amount_cents).toBe(2000);

      // Verify credit_balances table
      const balanceRows = await testDb.execute(
        sql`SELECT * FROM credit_balances WHERE customer_id = ${CUSTOMER_1.id}`,
      );
      expect(balanceRows.rows).toHaveLength(1);
      expect(balanceRows.rows[0].balance_cents).toBe(2000);

      // Verify ledger_entries table
      const ledgerRows = await testDb.execute(
        sql`SELECT * FROM ledger_entries WHERE reference_id = ${response.body.id} AND reference_type = 'credit_note'`,
      );
      expect(ledgerRows.rows).toHaveLength(1);
      expect(ledgerRows.rows[0].amount_cents).toBe(2000);
    });

    it("should return 404 when customer does not exist", async () => {
      const body = {
        customerId: "c0000000-0000-4000-a000-000000000099",
        invoiceId: INVOICE_1.id,
        amountCents: 2000,
        reason: "Non-existent customer",
      };

      const headers = signRequest("POST", "/v1/credit-notes", body);
      const response = await request(app.getHttpServer())
        .post("/v1/credit-notes")
        .set(headers)
        .send(body);

      expect(response.status).toBe(404);
    });

    it("should return 404 when invoice belongs to a different customer", async () => {
      // Seed a second customer
      await seedCustomer({
        id: "c0000000-0000-4000-a000-000000000002",
        monolithCustomerId: "mono-credit-002",
        name: "Other Customer",
        email: "other@example.com",
      });

      const body = {
        customerId: "c0000000-0000-4000-a000-000000000002",
        invoiceId: INVOICE_1.id, // belongs to CUSTOMER_1, not customer 002
        amountCents: 2000,
        reason: "Cross-customer credit attempt",
      };

      const headers = signRequest("POST", "/v1/credit-notes", body);
      const response = await request(app.getHttpServer())
        .post("/v1/credit-notes")
        .set(headers)
        .send(body);

      expect(response.status).toBe(404);
    });

    it("should return 422 when credit amount exceeds invoice total", async () => {
      const body = {
        customerId: CUSTOMER_1.id,
        invoiceId: INVOICE_1.id,
        amountCents: 10000,
        reason: "Excessive credit",
      };

      const headers = signRequest("POST", "/v1/credit-notes", body);
      const response = await request(app.getHttpServer())
        .post("/v1/credit-notes")
        .set(headers)
        .send(body);

      expect(response.status).toBe(422);
      expect(response.body.details).toMatchObject({
        errorCode: "CREDIT_EXCEEDS_INVOICE",
      });
    });

    it("should accumulate balance with multiple credits", async () => {
      const body1 = {
        customerId: CUSTOMER_1.id,
        invoiceId: INVOICE_1.id,
        amountCents: 2000,
        reason: "First credit",
      };
      const body2 = {
        customerId: CUSTOMER_1.id,
        invoiceId: INVOICE_1.id,
        amountCents: 1000,
        reason: "Second credit",
      };

      const headers1 = signRequest("POST", "/v1/credit-notes", body1);
      await request(app.getHttpServer())
        .post("/v1/credit-notes")
        .set(headers1)
        .send(body1);

      const headers2 = signRequest("POST", "/v1/credit-notes", body2);
      await request(app.getHttpServer())
        .post("/v1/credit-notes")
        .set(headers2)
        .send(body2);

      // Verify accumulated balance
      const testDb = getTestDatabase();
      const balanceRows = await testDb.execute(
        sql`SELECT * FROM credit_balances WHERE customer_id = ${CUSTOMER_1.id}`,
      );
      expect(balanceRows.rows).toHaveLength(1);
      expect(balanceRows.rows[0].balance_cents).toBe(3000);
    });

    it("should verify ledger entries have correct debit/credit accounts", async () => {
      const body = {
        customerId: CUSTOMER_1.id,
        invoiceId: INVOICE_1.id,
        amountCents: 2000,
        reason: "Ledger verification",
      };

      const headers = signRequest("POST", "/v1/credit-notes", body);
      const response = await request(app.getHttpServer())
        .post("/v1/credit-notes")
        .set(headers)
        .send(body);

      expect(response.status).toBe(201);

      // Verify ledger entries: debit credits account, credit accounts_receivable account
      const testDb = getTestDatabase();
      const ledgerRows = await testDb.execute(
        sql`SELECT le.*, da.name as debit_name, ca.name as credit_name
            FROM ledger_entries le
            JOIN ledger_accounts da ON le.debit_account_id = da.id
            JOIN ledger_accounts ca ON le.credit_account_id = ca.id
            WHERE le.reference_id = ${response.body.id}`,
      );
      expect(ledgerRows.rows).toHaveLength(1);
      const entry = ledgerRows.rows[0];
      expect(entry.debit_name).toBe("credits");
      expect(entry.credit_name).toBe("accounts_receivable");
    });
  });

  describe("GET /v1/customers/:id/credit-balance", () => {
    it("should return balance for customer with credits", async () => {
      // Issue a credit first
      const body = {
        customerId: CUSTOMER_1.id,
        invoiceId: INVOICE_1.id,
        amountCents: 3000,
        reason: "Balance query test",
      };
      const postHeaders = signRequest("POST", "/v1/credit-notes", body);
      await request(app.getHttpServer())
        .post("/v1/credit-notes")
        .set(postHeaders)
        .send(body);

      // Query balance
      const getHeaders = signRequest(
        "GET",
        `/v1/customers/${CUSTOMER_1.id}/credit-balance`,
      );
      const response = await request(app.getHttpServer())
        .get(`/v1/customers/${CUSTOMER_1.id}/credit-balance`)
        .set(getHeaders);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        customerId: CUSTOMER_1.id,
        balanceCents: 3000,
        currency: "usd",
      });
      expect(response.body.updatedAt).toBeDefined();
    });

    it("should return zero balance when no credits exist", async () => {
      const headers = signRequest(
        "GET",
        `/v1/customers/${CUSTOMER_1.id}/credit-balance`,
      );
      const response = await request(app.getHttpServer())
        .get(`/v1/customers/${CUSTOMER_1.id}/credit-balance`)
        .set(headers);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        customerId: CUSTOMER_1.id,
        balanceCents: 0,
        currency: "usd",
        updatedAt: null,
      });
    });

    it("should return 404 when customer does not exist", async () => {
      const customerId = "c0000000-0000-4000-a000-000000000099";
      const headers = signRequest(
        "GET",
        `/v1/customers/${customerId}/credit-balance`,
      );
      const response = await request(app.getHttpServer())
        .get(`/v1/customers/${customerId}/credit-balance`)
        .set(headers);

      expect(response.status).toBe(404);
    });
  });

  describe("Credit balance atomicity", () => {
    it("should atomically create credit note and update balance (both or neither)", async () => {
      const body = {
        customerId: CUSTOMER_1.id,
        invoiceId: INVOICE_1.id,
        amountCents: 2500,
        reason: "Atomicity test",
      };

      const headers = signRequest("POST", "/v1/credit-notes", body);
      const response = await request(app.getHttpServer())
        .post("/v1/credit-notes")
        .set(headers)
        .send(body);

      expect(response.status).toBe(201);

      // Verify all 3 records exist (credit note, balance, ledger entry)
      const testDb = getTestDatabase();

      const noteRows = await testDb.execute(
        sql`SELECT * FROM credit_notes WHERE id = ${response.body.id}`,
      );
      expect(noteRows.rows).toHaveLength(1);

      const balanceRows = await testDb.execute(
        sql`SELECT * FROM credit_balances WHERE customer_id = ${CUSTOMER_1.id}`,
      );
      expect(balanceRows.rows).toHaveLength(1);
      expect(balanceRows.rows[0].balance_cents).toBe(2500);

      const ledgerRows = await testDb.execute(
        sql`SELECT * FROM ledger_entries WHERE reference_id = ${response.body.id}`,
      );
      expect(ledgerRows.rows).toHaveLength(1);
    });
  });
});
