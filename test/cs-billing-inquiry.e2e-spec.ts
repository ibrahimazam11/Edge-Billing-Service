import { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { App } from "supertest/types";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  seedCustomer,
  seedPaymentMethod,
  seedInvoice,
  seedCharge,
  seedDunningAttempt,
} from "./helpers/database";
import { createTestApp } from "./helpers/test-app";
import { signRequest } from "./helpers/hmac-signer";

// ──────────────────────────────────────────────
// Seed Data IDs (UUIDv4, variant=a)
// ──────────────────────────────────────────────
const customerAId = "e0000000-0000-4000-a000-000000000001";
const customerBId = "e0000000-0000-4000-a000-000000000002";
const customerCId = "e0000000-0000-4000-a000-000000000003";

const pm1Id = "e0000000-0000-4000-a000-000000000010";
const pm2Id = "e0000000-0000-4000-a000-000000000011";
const pm3Id = "e0000000-0000-4000-a000-000000000012";

const invoice1Id = "e0000000-0000-4000-a000-000000000020";
const invoice2Id = "e0000000-0000-4000-a000-000000000021";
const invoice3Id = "e0000000-0000-4000-a000-000000000022";
const invoice4Id = "e0000000-0000-4000-a000-000000000023";

const charge1Id = "e0000000-0000-4000-a000-000000000040";
const charge2Id = "e0000000-0000-4000-a000-000000000041";
const charge3Id = "e0000000-0000-4000-a000-000000000042";

const da1Id = "e0000000-0000-4000-a000-000000000050";
const da2Id = "e0000000-0000-4000-a000-000000000051";
const da3Id = "e0000000-0000-4000-a000-000000000052";

const NON_EXISTENT_UUID = "e0000000-0000-4000-a000-ffffffffffff";

// ──────────────────────────────────────────────
// Helper: sign with CS role (default for inquiry)
// ──────────────────────────────────────────────
function csHeaders(method: string, path: string) {
  return signRequest(method, path, undefined, {
    adminRole: "cs",
    adminUserId: "cs-user-1",
  });
}

// ──────────────────────────────────────────────
// Seed all test data
// ──────────────────────────────────────────────
async function seedAllData(): Promise<void> {
  // Customers
  await seedCustomer({
    id: customerAId,
    monolithCustomerId: "MON-001",
    name: "Acme Corp",
    email: "billing@acme.test",
    status: "active",
  });
  await seedCustomer({
    id: customerBId,
    monolithCustomerId: "MON-002",
    name: "Beta LLC",
    email: "billing@beta.test",
    status: "active",
  });
  await seedCustomer({
    id: customerCId,
    monolithCustomerId: "MON-003",
    name: "Gamma Inc",
    email: "billing@gamma.test",
    status: "inactive",
  });

  // Payment Methods
  await seedPaymentMethod({
    id: pm1Id,
    customerId: customerAId,
    stripePaymentMethodId: "pm_stripe_001",
    type: "card",
    isDefault: true,
    lastFour: "4242",
    brand: "visa",
    gatewayProvider: "stripe",
  });
  await seedPaymentMethod({
    id: pm2Id,
    customerId: customerAId,
    stripePaymentMethodId: "pm_adyen_001",
    type: "card",
    isDefault: false,
    lastFour: "1234",
    brand: "mastercard",
    fallbackOrder: 2,
    gatewayProvider: "adyen",
  });
  await seedPaymentMethod({
    id: pm3Id,
    customerId: customerBId,
    stripePaymentMethodId: "pm_stripe_002",
    type: "card",
    isDefault: true,
    lastFour: "5678",
    brand: "visa",
    gatewayProvider: "stripe",
  });

  // Invoices with line items
  await seedInvoice({
    id: invoice1Id,
    customerId: customerAId,
    status: "finalized",
    totalAmountCents: 15000,
    billingPeriodStart: new Date("2026-01-01"),
    billingPeriodEnd: new Date("2026-02-01"),
    dueDate: new Date("2026-01-15"),
    lineItems: [
      {
        id: "e0000000-0000-4000-a000-000000000030",
        type: "base_fee",
        description: "Monthly subscription",
        amountCents: 10000,
      },
      {
        id: "e0000000-0000-4000-a000-000000000031",
        type: "surcharge",
        description: "Credit card surcharge",
        amountCents: 3000,
      },
      {
        id: "e0000000-0000-4000-a000-000000000032",
        type: "credit",
        description: "Applied credit",
        amountCents: -2000,
      },
    ],
  });
  await seedInvoice({
    id: invoice2Id,
    customerId: customerAId,
    status: "paid",
    totalAmountCents: 20000,
    billingPeriodStart: new Date("2026-02-01"),
    billingPeriodEnd: new Date("2026-03-01"),
    dueDate: new Date("2026-02-15"),
    lineItems: [
      {
        id: "e0000000-0000-4000-a000-000000000033",
        type: "base_fee",
        description: "Monthly subscription",
        amountCents: 20000,
      },
    ],
  });
  await seedInvoice({
    id: invoice3Id,
    customerId: customerAId,
    status: "void",
    totalAmountCents: 5000,
    billingPeriodStart: new Date("2025-12-01"),
    billingPeriodEnd: new Date("2026-01-01"),
    dueDate: new Date("2025-12-15"),
    lineItems: [
      {
        id: "e0000000-0000-4000-a000-000000000034",
        type: "base_fee",
        description: "Monthly subscription",
        amountCents: 5000,
      },
    ],
  });
  await seedInvoice({
    id: invoice4Id,
    customerId: customerBId,
    status: "finalized",
    totalAmountCents: 10000,
    billingPeriodStart: new Date("2026-01-01"),
    billingPeriodEnd: new Date("2026-02-01"),
    dueDate: new Date("2026-01-15"),
    lineItems: [
      {
        id: "e0000000-0000-4000-a000-000000000035",
        type: "base_fee",
        description: "Monthly subscription",
        amountCents: 10000,
      },
    ],
  });

  // Charges
  await seedCharge({
    id: charge1Id,
    invoiceId: invoice1Id,
    customerId: customerAId,
    paymentMethodId: pm1Id,
    amountCents: 15000,
    status: "succeeded",
    stripePaymentIntentId: "pi_stripe_001",
    idempotencyKey: "idem-charge-1",
  });
  await seedCharge({
    id: charge2Id,
    invoiceId: invoice2Id,
    customerId: customerAId,
    paymentMethodId: pm2Id,
    amountCents: 20000,
    status: "succeeded",
    stripePaymentIntentId: "pi_adyen_001",
    idempotencyKey: "idem-charge-2",
  });
  await seedCharge({
    id: charge3Id,
    invoiceId: invoice3Id,
    customerId: customerAId,
    paymentMethodId: pm1Id,
    amountCents: 5000,
    status: "failed",
    stripePaymentIntentId: "pi_stripe_002",
    idempotencyKey: "idem-charge-3",
    failureReason: "card_declined",
  });

  // Dunning attempts
  await seedDunningAttempt({
    id: da1Id,
    invoiceId: invoice1Id,
    paymentMethodId: pm1Id,
    attemptNumber: 1,
    scheduledDate: new Date("2026-01-16"),
    status: "scheduled",
  });
  await seedDunningAttempt({
    id: da2Id,
    invoiceId: invoice1Id,
    paymentMethodId: pm2Id,
    attemptNumber: 2,
    scheduledDate: new Date("2026-01-19"),
    executedAt: new Date("2026-01-19"),
    status: "failed",
    failureReason: "insufficient_funds",
  });
  await seedDunningAttempt({
    id: da3Id,
    invoiceId: invoice2Id,
    paymentMethodId: pm1Id,
    attemptNumber: 1,
    scheduledDate: new Date("2026-02-16"),
    executedAt: new Date("2026-02-16"),
    status: "succeeded",
  });
}

describe("CS Billing Inquiry (e2e)", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    await setupTestDatabase();
    app = await createTestApp();
    await cleanDatabase();
    await seedAllData();
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
    await closeDatabase();
  });

  // ══════════════════════════════════════════════
  // Task 2: Customer Search E2E Tests
  // ══════════════════════════════════════════════
  describe("GET /v1/admin/customers/search", () => {
    const searchPath = "/v1/admin/customers/search";

    it("should search by name ILIKE and return matching customer", async () => {
      const headers = csHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ name: "acme" })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        id: customerAId,
        name: "Acme Corp",
        email: "billing@acme.test",
        monolithCustomerId: "MON-001",
        status: "active",
      });
      expect(response.body.cursor).toBeNull();
      expect(response.body.hasMore).toBe(false);
    });

    it("should search by email ILIKE and return matching customer", async () => {
      const headers = csHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ email: "acme" })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe(customerAId);
      expect(response.body.data[0].email).toBe("billing@acme.test");
    });

    it("should search by externalId exact match", async () => {
      const headers = csHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ externalId: "MON-001" })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe(customerAId);
      expect(response.body.data[0].monolithCustomerId).toBe("MON-001");
    });

    it("should search by status=inactive and return only inactive customers", async () => {
      const headers = csHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ status: "inactive" })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe(customerCId);
      expect(response.body.data[0].name).toBe("Gamma Inc");
      expect(response.body.data[0].status).toBe("inactive");
    });

    it("should combine filters with AND logic", async () => {
      const headers = csHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ name: "acme", status: "active" })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe(customerAId);
    });

    it("should return empty results for non-matching search", async () => {
      const headers = csHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ name: "nonexistent" })
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });

    it("should support cursor pagination", async () => {
      const headers = csHeaders("GET", searchPath);
      // Page 1: limit=1
      const page1 = await request(app.getHttpServer())
        .get(searchPath)
        .query({ status: "active", limit: 1 })
        .set(headers)
        .expect(200);

      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.hasMore).toBe(true);
      expect(page1.body.cursor).toBe(customerAId);

      // Page 2: use cursor
      const page2 = await request(app.getHttpServer())
        .get(searchPath)
        .query({ status: "active", limit: 1, cursor: page1.body.cursor })
        .set(headers)
        .expect(200);

      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.hasMore).toBe(false);
      expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    });

    it("should return empty results for non-existent cursor (adversarial)", async () => {
      const headers = csHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ cursor: NON_EXISTENT_UUID })
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });

    it("should treat empty string filter as no filter (adversarial)", async () => {
      const headers = csHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ name: "" })
        .set(headers)
        .expect(200);

      // Empty name treated as no filter → returns all 3 customers
      expect(response.body.data.length).toBe(3);
    });
  });

  // ══════════════════════════════════════════════
  // Task 3: Payment History E2E Tests
  // ══════════════════════════════════════════════
  describe("GET /v1/admin/customers/:id/payments", () => {
    const paymentsPath = (id: string) => `/v1/admin/customers/${id}/payments`;

    it("should return all charges for customer A with correct fields", async () => {
      const path = paymentsPath(customerAId);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(3);
      // Descending by id — charge3 > charge2 > charge1
      const [c3, c2, c1] = response.body.data;

      expect(c1).toMatchObject({
        id: charge1Id,
        invoiceId: invoice1Id,
        amountCents: 15000,
        status: "succeeded",
        paymentMethodType: "card",
        gatewayProvider: "stripe",
        gatewayChargeId: "pi_stripe_001",
        failureReason: null,
        attemptNumber: 1,
        currency: "usd",
      });

      expect(c2).toMatchObject({
        id: charge2Id,
        invoiceId: invoice2Id,
        amountCents: 20000,
        status: "succeeded",
        paymentMethodType: "card",
        gatewayProvider: "adyen",
        gatewayChargeId: "pi_adyen_001",
        failureReason: null,
        attemptNumber: 1,
        currency: "usd",
      });

      expect(c3).toMatchObject({
        id: charge3Id,
        invoiceId: invoice3Id,
        amountCents: 5000,
        status: "failed",
        paymentMethodType: "card",
        gatewayProvider: "stripe",
        gatewayChargeId: "pi_stripe_002",
        failureReason: "card_declined",
        attemptNumber: 1,
        currency: "usd",
      });
    });

    it("should filter by dateFrom", async () => {
      const path = paymentsPath(customerAId);
      const headers = csHeaders("GET", path);
      // All charges created at ~now, so dateFrom=tomorrow should return none
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const response = await request(app.getHttpServer())
        .get(path)
        .query({ dateFrom: tomorrow.toISOString() })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(0);
    });

    it("should include charges within date range (positive case)", async () => {
      const path = paymentsPath(customerAId);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .query({
          dateFrom: "2020-01-01T00:00:00.000Z",
          dateTo: "2030-01-01T00:00:00.000Z",
        })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(3);
      const ids = response.body.data.map((c: { id: string }) => c.id);
      expect(ids).toContain(charge1Id);
      expect(ids).toContain(charge2Id);
      expect(ids).toContain(charge3Id);
    });

    it("should filter by dateTo (half-open interval)", async () => {
      const path = paymentsPath(customerAId);
      const headers = csHeaders("GET", path);
      // dateTo=yesterday should return none since charges are created now
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const response = await request(app.getHttpServer())
        .get(path)
        .query({ dateTo: yesterday.toISOString() })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(0);
    });

    it("should support cursor pagination descending", async () => {
      const path = paymentsPath(customerAId);
      const headers = csHeaders("GET", path);
      const page1 = await request(app.getHttpServer())
        .get(path)
        .query({ limit: 2 })
        .set(headers)
        .expect(200);

      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.hasMore).toBe(true);

      const page2 = await request(app.getHttpServer())
        .get(path)
        .query({ limit: 2, cursor: page1.body.cursor })
        .set(headers)
        .expect(200);

      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.hasMore).toBe(false);
      // Verify descending order — page2 item has smallest ID
      expect(page2.body.data[0].id).toBe(charge1Id);
    });

    it("should return 404 for non-existent customer", async () => {
      const path = paymentsPath(NON_EXISTENT_UUID);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(404);

      expect(response.body).toMatchObject({
        statusCode: 404,
        message: `Customer ${NON_EXISTENT_UUID} not found`,
      });
    });

    it("should return empty results for customer with no charges", async () => {
      const path = paymentsPath(customerCId);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });
  });

  // ══════════════════════════════════════════════
  // Task 4: Invoice Search E2E Tests
  // ══════════════════════════════════════════════
  describe("GET /v1/admin/invoices/search", () => {
    const invoicePath = "/v1/admin/invoices/search";

    it("should search by customerId and return only that customer's invoices", async () => {
      const headers = csHeaders("GET", invoicePath);
      const response = await request(app.getHttpServer())
        .get(invoicePath)
        .query({ customerId: customerAId })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(3);
      // All belong to customer A
      for (const inv of response.body.data) {
        expect(inv.customerId).toBe(customerAId);
      }
    });

    it("should search by status=finalized", async () => {
      const headers = csHeaders("GET", invoicePath);
      const response = await request(app.getHttpServer())
        .get(invoicePath)
        .query({ status: "finalized" })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      const ids = response.body.data.map((i: { id: string }) => i.id);
      expect(ids).toContain(invoice1Id);
      expect(ids).toContain(invoice4Id);
      for (const inv of response.body.data) {
        expect(inv.status).toBe("finalized");
      }
    });

    it("should combine customerId + status with AND logic", async () => {
      const headers = csHeaders("GET", invoicePath);
      const response = await request(app.getHttpServer())
        .get(invoicePath)
        .query({ customerId: customerAId, status: "paid" })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        id: invoice2Id,
        customerId: customerAId,
        status: "paid",
        totalAmountCents: 20000,
      });
    });

    it("should filter by dateFrom and dateTo range", async () => {
      const headers = csHeaders("GET", invoicePath);
      // dateTo=yesterday → no invoices (created today)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const response = await request(app.getHttpServer())
        .get(invoicePath)
        .query({ dateTo: yesterday.toISOString() })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(0);
    });

    it("should filter by amountMin and amountMax", async () => {
      const headers = csHeaders("GET", invoicePath);
      const response = await request(app.getHttpServer())
        .get(invoicePath)
        .query({ amountMin: 10000, amountMax: 15000 })
        .set(headers)
        .expect(200);

      // Invoice1 (15000), Invoice4 (10000) match; Invoice2 (20000) too high, Invoice3 (5000) too low
      expect(response.body.data).toHaveLength(2);
      const ids = response.body.data.map((i: { id: string }) => i.id);
      expect(ids).toContain(invoice1Id);
      expect(ids).toContain(invoice4Id);
      for (const inv of response.body.data) {
        expect(inv.totalAmountCents).toBeGreaterThanOrEqual(10000);
        expect(inv.totalAmountCents).toBeLessThanOrEqual(15000);
      }
    });

    it("should combine all filters with AND logic", async () => {
      const headers = csHeaders("GET", invoicePath);
      const response = await request(app.getHttpServer())
        .get(invoicePath)
        .query({
          customerId: customerAId,
          status: "finalized",
          amountMin: 10000,
          amountMax: 20000,
        })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe(invoice1Id);
      expect(response.body.data[0].totalAmountCents).toBe(15000);
    });

    it("should return empty for non-matching status", async () => {
      const headers = csHeaders("GET", invoicePath);
      const response = await request(app.getHttpServer())
        .get(invoicePath)
        .query({ status: "draft" })
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });

    it("should support cursor pagination descending", async () => {
      const headers = csHeaders("GET", invoicePath);
      const page1 = await request(app.getHttpServer())
        .get(invoicePath)
        .query({ customerId: customerAId, limit: 2 })
        .set(headers)
        .expect(200);

      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.hasMore).toBe(true);

      const page2 = await request(app.getHttpServer())
        .get(invoicePath)
        .query({
          customerId: customerAId,
          limit: 2,
          cursor: page1.body.cursor,
        })
        .set(headers)
        .expect(200);

      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.hasMore).toBe(false);
    });

    it("should return empty for amountMin > amountMax (adversarial)", async () => {
      const headers = csHeaders("GET", invoicePath);
      const response = await request(app.getHttpServer())
        .get(invoicePath)
        .query({ amountMin: 99999, amountMax: 1 })
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });

    it("should return empty for dateFrom > dateTo (adversarial)", async () => {
      const headers = csHeaders("GET", invoicePath);
      const response = await request(app.getHttpServer())
        .get(invoicePath)
        .query({
          dateFrom: "2026-12-01T00:00:00.000Z",
          dateTo: "2026-01-01T00:00:00.000Z",
        })
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });
  });

  // ══════════════════════════════════════════════
  // Task 5: Invoice Line Item Detail E2E Tests
  // ══════════════════════════════════════════════
  describe("GET /v1/admin/invoices/:id/line-items", () => {
    const lineItemsPath = (id: string) => `/v1/admin/invoices/${id}/line-items`;

    it("should return 3 line items for Invoice 1 with exact values", async () => {
      const path = lineItemsPath(invoice1Id);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(3);
      expect(response.body.cursor).toBeNull();
      expect(response.body.hasMore).toBe(false);

      // Ordered by id ascending
      const [li1, li2, li3] = response.body.data;

      expect(li1).toMatchObject({
        id: "e0000000-0000-4000-a000-000000000030",
        invoiceId: invoice1Id,
        type: "base_fee",
        description: "Monthly subscription",
        amountCents: 10000,
        quantity: 1,
      });
      expect(li2).toMatchObject({
        id: "e0000000-0000-4000-a000-000000000031",
        invoiceId: invoice1Id,
        type: "surcharge",
        description: "Credit card surcharge",
        amountCents: 3000,
        quantity: 1,
      });
      expect(li3).toMatchObject({
        id: "e0000000-0000-4000-a000-000000000032",
        invoiceId: invoice1Id,
        type: "credit",
        description: "Applied credit",
        amountCents: -2000,
        quantity: 1,
      });
    });

    it("should return 1 line item for Invoice 4", async () => {
      const path = lineItemsPath(invoice4Id);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        id: "e0000000-0000-4000-a000-000000000035",
        invoiceId: invoice4Id,
        type: "base_fee",
        description: "Monthly subscription",
        amountCents: 10000,
        quantity: 1,
      });
    });

    it("should return 404 for non-existent invoice", async () => {
      const path = lineItemsPath(NON_EXISTENT_UUID);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(404);

      expect(response.body).toMatchObject({
        statusCode: 404,
        message: `Invoice ${NON_EXISTENT_UUID} not found`,
      });
    });

    it("should verify line items are ordered by id ascending", async () => {
      const path = lineItemsPath(invoice1Id);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(200);

      const ids: string[] = response.body.data.map(
        (li: { id: string }) => li.id,
      );
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    });

    it("should return single line item for void invoice (Invoice 3)", async () => {
      const path = lineItemsPath(invoice3Id);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        type: "base_fee",
        amountCents: 5000,
      });
    });
  });

  // ══════════════════════════════════════════════
  // Task 6: Dunning History E2E Tests
  // ══════════════════════════════════════════════
  describe("GET /v1/admin/customers/:id/dunning-history", () => {
    const dunningPath = (id: string) =>
      `/v1/admin/customers/${id}/dunning-history`;

    it("should return all dunning attempts for Customer A with correct fields", async () => {
      const path = dunningPath(customerAId);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(3);

      // Descending by id: da3 > da2 > da1
      const [d3, d2, d1] = response.body.data;

      expect(d1).toMatchObject({
        id: da1Id,
        invoiceId: invoice1Id,
        paymentMethodId: pm1Id,
        attemptNumber: 1,
        status: "scheduled",
        failureReason: null,
        paymentMethodType: "card",
        gatewayProvider: "stripe",
      });

      expect(d2).toMatchObject({
        id: da2Id,
        invoiceId: invoice1Id,
        paymentMethodId: pm2Id,
        attemptNumber: 2,
        status: "failed",
        failureReason: "insufficient_funds",
        paymentMethodType: "card",
        gatewayProvider: "adyen",
      });

      expect(d3).toMatchObject({
        id: da3Id,
        invoiceId: invoice2Id,
        paymentMethodId: pm1Id,
        attemptNumber: 1,
        status: "succeeded",
        paymentMethodType: "card",
        gatewayProvider: "stripe",
      });
    });

    it("should verify failureReason is present on failed attempt", async () => {
      const path = dunningPath(customerAId);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(200);

      const failedAttempt = response.body.data.find(
        (d: { id: string }) => d.id === da2Id,
      );
      expect(failedAttempt.failureReason).toBe("insufficient_funds");
      expect(failedAttempt.status).toBe("failed");
    });

    it("should return results in descending order by id", async () => {
      const path = dunningPath(customerAId);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(200);

      const ids: string[] = response.body.data.map((d: { id: string }) => d.id);
      const sortedDesc = [...ids].sort().reverse();
      expect(ids).toEqual(sortedDesc);
    });

    it("should filter by dateFrom", async () => {
      const path = dunningPath(customerAId);
      const headers = csHeaders("GET", path);
      // dateFrom = tomorrow → no results
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const response = await request(app.getHttpServer())
        .get(path)
        .query({ dateFrom: tomorrow.toISOString() })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(0);
    });

    it("should include attempts within date range (positive case)", async () => {
      const path = dunningPath(customerAId);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .query({ dateFrom: "2020-01-01T00:00:00.000Z" })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(3);
      const ids = response.body.data.map((d: { id: string }) => d.id);
      expect(ids).toContain(da1Id);
      expect(ids).toContain(da2Id);
      expect(ids).toContain(da3Id);
    });

    it("should support cursor pagination descending", async () => {
      const path = dunningPath(customerAId);
      const headers = csHeaders("GET", path);
      const page1 = await request(app.getHttpServer())
        .get(path)
        .query({ limit: 2 })
        .set(headers)
        .expect(200);

      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.hasMore).toBe(true);

      const page2 = await request(app.getHttpServer())
        .get(path)
        .query({ limit: 2, cursor: page1.body.cursor })
        .set(headers)
        .expect(200);

      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.hasMore).toBe(false);
      expect(page2.body.data[0].id).toBe(da1Id);
    });

    it("should return 404 for non-existent customer", async () => {
      const path = dunningPath(NON_EXISTENT_UUID);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(404);

      expect(response.body).toMatchObject({
        statusCode: 404,
        message: `Customer ${NON_EXISTENT_UUID} not found`,
      });
    });

    it("should return empty results for customer with no dunning history", async () => {
      const path = dunningPath(customerBId);
      const headers = csHeaders("GET", path);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });
  });

  // ══════════════════════════════════════════════
  // Task 7: Role Enforcement E2E Tests
  // ══════════════════════════════════════════════
  describe("Role Enforcement", () => {
    const endpoints = [
      { method: "GET" as const, path: "/v1/admin/customers/search" },
      {
        method: "GET" as const,
        path: `/v1/admin/customers/${customerAId}/payments`,
      },
      { method: "GET" as const, path: "/v1/admin/invoices/search" },
      {
        method: "GET" as const,
        path: `/v1/admin/invoices/${invoice1Id}/line-items`,
      },
      {
        method: "GET" as const,
        path: `/v1/admin/customers/${customerAId}/dunning-history`,
      },
    ];

    it("should return 200 for cs role on all 5 endpoints", async () => {
      for (const endpoint of endpoints) {
        const headers = signRequest(endpoint.method, endpoint.path, undefined, {
          adminRole: "cs",
          adminUserId: "cs-user-1",
        });
        await request(app.getHttpServer())
          .get(endpoint.path)
          .set(headers)
          .expect(200);
      }
    });

    it("should return 200 for finance role on all 5 endpoints", async () => {
      for (const endpoint of endpoints) {
        const headers = signRequest(endpoint.method, endpoint.path, undefined, {
          adminRole: "finance",
          adminUserId: "finance-user-1",
        });
        await request(app.getHttpServer())
          .get(endpoint.path)
          .set(headers)
          .expect(200);
      }
    });

    it("should return 200 for admin role on all 5 endpoints", async () => {
      for (const endpoint of endpoints) {
        const headers = signRequest(endpoint.method, endpoint.path, undefined, {
          adminRole: "admin",
          adminUserId: "admin-user-1",
        });
        await request(app.getHttpServer())
          .get(endpoint.path)
          .set(headers)
          .expect(200);
      }
    });

    it("should return 403 for missing role on all 5 endpoints", async () => {
      for (const endpoint of endpoints) {
        const headers = signRequest(endpoint.method, endpoint.path);
        const response = await request(app.getHttpServer())
          .get(endpoint.path)
          .set(headers)
          .expect(403);

        expect(response.body).toMatchObject({
          statusCode: 403,
          message: "Forbidden resource",
        });
      }
    });

    it("should return 401 when no HMAC signature is provided", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/admin/customers/search")
        .expect(401);

      expect(response.body).toMatchObject({
        statusCode: 401,
        message: "Unauthorized",
      });
    });
  });
});
