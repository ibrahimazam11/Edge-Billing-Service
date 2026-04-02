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
  seedLedgerAccounts,
  seedInvoice,
} from "./helpers/database";
import { signRequest } from "./helpers/hmac-signer";
import { LedgerService } from "../src/ledger/ledger.service";
import { InvoicesService } from "../src/invoices/invoices.service";
import type { App } from "supertest/types";

const CUSTOMER_1 = {
  id: "c0000000-0000-4000-a000-000000000050",
  monolithCustomerId: "mono-otc-001",
  stripeCustomerId: "cus_test_otc_001",
  name: "One-Time Charge Customer",
  email: "otc-test@example.com",
};

const PAYMENT_METHOD_1 = {
  id: "b0000000-0000-4000-a000-000000000050",
  customerId: CUSTOMER_1.id,
  stripePaymentMethodId: "pm_test_otc_001",
  type: "card",
  isDefault: true,
  lastFour: "4242",
  brand: "visa",
};

const PAYMENT_METHOD_2 = {
  id: "b0000000-0000-4000-a000-000000000051",
  customerId: CUSTOMER_1.id,
  stripePaymentMethodId: "pm_test_otc_002",
  type: "card",
  isDefault: false,
  lastFour: "1234",
  brand: "mastercard",
};

describe("One-Time & Onboarding Charges (e2e)", () => {
  let app: INestApplication<App>;
  let ledgerService: LedgerService;

  beforeAll(async () => {
    await setupTestDatabase();
    app = await createTestApp();
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
    await seedPaymentMethod(PAYMENT_METHOD_2);
  });

  describe("POST /v1/charges", () => {
    const chargeBody = {
      customerId: CUSTOMER_1.id,
      amountCents: 5000,
      description: "Setup fee",
    };

    it("should create invoice, finalize, charge, and return 201", async () => {
      const path = "/v1/charges";
      const headers = signRequest("POST", path, chargeBody);

      const response = await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .set("x-idempotency-key", "e2e-idem-otc-001")
        .send(chargeBody)
        .expect(201);

      expect(response.body.charge).toBeDefined();
      expect(response.body.invoice).toBeDefined();
      expect(response.body.invoice.subscriptionId).toBeNull();
      expect(response.body.invoice.totalAmountCents).toBe(5000);
      expect(response.body.invoice.lineItems).toHaveLength(1);
      expect(response.body.invoice.lineItems[0].type).toBe("one_time_charge");
      expect(response.body.invoice.lineItems[0].description).toBe("Setup fee");
      expect(response.body.charge.amountCents).toBe(5000);
      expect(response.body.charge.idempotencyKey).toBe("e2e-idem-otc-001");

      // Verify DB state
      const db = getTestDatabase();
      const invoiceRows = await db.execute(
        sql`SELECT * FROM invoices WHERE customer_id = ${CUSTOMER_1.id} AND subscription_id IS NULL`,
      );
      expect(invoiceRows.rows.length).toBeGreaterThanOrEqual(1);

      const chargeRows = await db.execute(
        sql`SELECT * FROM charges WHERE idempotency_key = ${"e2e-idem-otc-001"}`,
      );
      expect(chargeRows.rows).toHaveLength(1);
    });

    it("should return 404 for non-existent customer", async () => {
      const path = "/v1/charges";
      const body = {
        customerId: "a0000000-0000-4000-a000-000000000099",
        amountCents: 5000,
        description: "Setup fee",
      };
      const headers = signRequest("POST", path, body);

      await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .set("x-idempotency-key", "e2e-idem-otc-002")
        .send(body)
        .expect(404);
    });

    it("should return 400 when x-idempotency-key header is missing", async () => {
      const path = "/v1/charges";
      const headers = signRequest("POST", path, chargeBody);

      await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .send(chargeBody)
        .expect(400);
    });

    it("should return same result on duplicate idempotency key", async () => {
      const path = "/v1/charges";
      const headers1 = signRequest("POST", path, chargeBody);

      const response1 = await request(app.getHttpServer())
        .post(path)
        .set(headers1)
        .set("x-idempotency-key", "e2e-idem-otc-dup")
        .send(chargeBody)
        .expect(201);

      const headers2 = signRequest("POST", path, chargeBody);

      const response2 = await request(app.getHttpServer())
        .post(path)
        .set(headers2)
        .set("x-idempotency-key", "e2e-idem-otc-dup")
        .send(chargeBody)
        .expect(201);

      // Same charge ID returned — no duplicate
      expect(response2.body.charge.id).toBe(response1.body.charge.id);
      expect(response2.body.invoice.id).toBe(response1.body.invoice.id);

      // Verify only one invoice and one charge were created
      const db = getTestDatabase();
      const chargeRows = await db.execute(
        sql`SELECT * FROM charges WHERE idempotency_key = ${"e2e-idem-otc-dup"}`,
      );
      expect(chargeRows.rows).toHaveLength(1);
    });

    it("should use explicit paymentMethodId when provided", async () => {
      const path = "/v1/charges";
      const body = {
        ...chargeBody,
        paymentMethodId: PAYMENT_METHOD_2.id,
      };
      const headers = signRequest("POST", path, body);

      const response = await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .set("x-idempotency-key", "e2e-idem-otc-pm2")
        .send(body)
        .expect(201);

      // The charge should be created with the specified payment method
      expect(response.body.charge.paymentMethodId).toBe(PAYMENT_METHOD_2.id);
    });

    it("should validate request body (400 on invalid)", async () => {
      const path = "/v1/charges";
      const body = {
        customerId: "not-a-uuid",
        amountCents: -100,
        description: "",
      };
      const headers = signRequest("POST", path, body);

      await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .set("x-idempotency-key", "e2e-idem-otc-invalid")
        .send(body)
        .expect(400);
    });

    it("should create ledger entries for finalized invoice", async () => {
      const path = "/v1/charges";
      const headers = signRequest("POST", path, chargeBody);

      await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .set("x-idempotency-key", "e2e-idem-otc-ledger")
        .send(chargeBody)
        .expect(201);

      // Verify invoice finalization ledger entry (debit AR, credit Revenue)
      const db = getTestDatabase();
      const ledgerRows = await db.execute(
        sql`SELECT * FROM ledger_entries WHERE reference_type = 'invoice'`,
      );
      expect(ledgerRows.rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("POST /v1/onboarding-charges", () => {
    const onboardingBody = {
      customerId: CUSTOMER_1.id,
      amountCents: 15000,
      description: "Onboarding implementation fee",
      scheduledDate: "2026-03-01",
    };

    it("should create draft invoice and return 201", async () => {
      const path = "/v1/onboarding-charges";
      const headers = signRequest("POST", path, onboardingBody);

      const response = await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .send(onboardingBody)
        .expect(201);

      expect(response.body.invoice).toBeDefined();
      expect(response.body.invoice.status).toBe("draft");
      expect(response.body.invoice.subscriptionId).toBeNull();
      expect(response.body.invoice.totalAmountCents).toBe(15000);
      expect(response.body.invoice.lineItems).toHaveLength(1);
      expect(response.body.invoice.lineItems[0].type).toBe("onboarding_fee");
      expect(response.body.invoice.lineItems[0].description).toBe(
        "Onboarding implementation fee",
      );
      // dueDate should be the scheduled date
      expect(response.body.invoice.dueDate).toContain("2026-03-01");

      // Verify NO charge was created
      const db = getTestDatabase();
      const chargeRows = await db.execute(
        sql`SELECT * FROM charges WHERE customer_id = ${CUSTOMER_1.id}`,
      );
      expect(chargeRows.rows).toHaveLength(0);

      // Verify NO ledger entries were created
      const ledgerRows = await db.execute(sql`SELECT * FROM ledger_entries`);
      expect(ledgerRows.rows).toHaveLength(0);
    });

    it("should return 404 for non-existent customer", async () => {
      const path = "/v1/onboarding-charges";
      const body = {
        customerId: "a0000000-0000-4000-a000-000000000099",
        amountCents: 15000,
        description: "Onboarding fee",
        scheduledDate: "2026-03-01",
      };
      const headers = signRequest("POST", path, body);

      await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .send(body)
        .expect(404);
    });

    it("should return 422 when scheduledDate is in the past", async () => {
      const path = "/v1/onboarding-charges";
      const body = {
        customerId: CUSTOMER_1.id,
        amountCents: 15000,
        description: "Onboarding fee",
        scheduledDate: "2020-01-01",
      };
      const headers = signRequest("POST", path, body);

      await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .send(body)
        .expect(422);
    });

    it("should validate request body (400 on missing scheduledDate)", async () => {
      const path = "/v1/onboarding-charges";
      const body = {
        customerId: CUSTOMER_1.id,
        amountCents: 15000,
        description: "Onboarding fee",
      };
      const headers = signRequest("POST", path, body);

      await request(app.getHttpServer())
        .post(path)
        .set(headers)
        .send(body)
        .expect(400);
    });
  });

  describe("Onboarding invoice finalization (batch)", () => {
    it("should finalize onboarding invoice when due date is reached", async () => {
      // Seed a draft onboarding invoice with past due date
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000060",
        customerId: CUSTOMER_1.id,
        subscriptionId: undefined,
        status: "draft",
        totalAmountCents: 15000,
        billingPeriodStart: new Date("2026-02-28T00:00:00.000Z"),
        billingPeriodEnd: new Date("2026-02-28T00:00:00.000Z"),
        dueDate: new Date("2026-02-28T00:00:00.000Z"),
        lineItems: [
          {
            id: "f0000000-0000-4000-a000-000000000060",
            type: "onboarding_fee",
            description: "Onboarding fee",
            amountCents: 15000,
          },
        ],
      });

      // Run the batch job via the service
      const invoicesService = app.get(InvoicesService);
      const result = await invoicesService.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "e2e-corr-batch-001",
      );

      // Onboarding invoice should have been finalized
      expect(result.finalized).toBeGreaterThanOrEqual(1);

      // Verify invoice is now finalized (or paid if charge succeeded)
      const db = getTestDatabase();
      const invoiceRows = await db.execute(
        sql`SELECT * FROM invoices WHERE id = ${"e0000000-0000-4000-a000-000000000060"}`,
      );
      const invoice = invoiceRows.rows[0] as { status: string };
      // Status should be "finalized" or "paid" (if payment went through)
      expect(["finalized", "paid"]).toContain(invoice.status);

      // Verify ledger entry was created for finalization
      const ledgerRows = await db.execute(
        sql`SELECT * FROM ledger_entries WHERE reference_type = 'invoice' AND reference_id = ${"e0000000-0000-4000-a000-000000000060"}`,
      );
      expect(ledgerRows.rows).toHaveLength(1);
    });

    it("should NOT finalize onboarding invoice with future due date", async () => {
      // Seed a draft onboarding invoice with future due date
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000061",
        customerId: CUSTOMER_1.id,
        subscriptionId: undefined,
        status: "draft",
        totalAmountCents: 10000,
        billingPeriodStart: new Date("2026-06-01T00:00:00.000Z"),
        billingPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
        dueDate: new Date("2026-06-01T00:00:00.000Z"),
        lineItems: [
          {
            id: "f0000000-0000-4000-a000-000000000061",
            type: "onboarding_fee",
            description: "Future onboarding fee",
            amountCents: 10000,
          },
        ],
      });

      const invoicesService = app.get(InvoicesService);
      await invoicesService.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "e2e-corr-batch-002",
      );

      // Verify invoice is still draft
      const db = getTestDatabase();
      const invoiceRows = await db.execute(
        sql`SELECT * FROM invoices WHERE id = ${"e0000000-0000-4000-a000-000000000061"}`,
      );
      const invoice = invoiceRows.rows[0] as { status: string };
      expect(invoice.status).toBe("draft");
    });
  });
});
