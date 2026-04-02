import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { App } from "supertest/types";
import { sql } from "drizzle-orm";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  seedCustomer,
  seedPaymentMethod,
  seedInvoice,
  seedCharge,
  seedLedgerAccounts,
  getAuditTrailRecords,
} from "./helpers/database";
import { createTestApp } from "./helpers/test-app";
import { signRequest } from "./helpers/hmac-signer";
import { waitForStripeMock } from "./helpers/stripe-mock";
import { purgeSqsQueue, receiveSqsMessages } from "./helpers/sqs";
import type { SqsEnvelope } from "../src/common/interfaces/envelope.interface";

const OUTBOUND_QUEUE_URL =
  process.env.SQS_MONOLITH_OUTBOUND_QUEUE_URL ??
  "http://localhost:4566/000000000000/billing-outbound";

// Seed data IDs — E2E UUID format: x0000000-0000-4000-a000-00000000000N
const CUSTOMER_ID = "e0000000-0000-4000-a000-000000000001";
const PAYMENT_METHOD_ID = "e0000000-0000-4000-a000-000000000002";
const INVOICE_ID = "e0000000-0000-4000-a000-000000000003";
const CHARGE_ID = "e0000000-0000-4000-a000-000000000004";
const LINE_ITEM_ID = "e0000000-0000-4000-a000-000000000005";

const AUDIT_FLUSH_MS = 500;

async function seedRefundTestData(): Promise<void> {
  await seedCustomer({
    id: CUSTOMER_ID,
    monolithCustomerId: "MON-REFUND-001",
    stripeCustomerId: "cus_refund_test_001",
    name: "Refund Test Customer",
    email: "refund-test@example.com",
  });

  await seedPaymentMethod({
    id: PAYMENT_METHOD_ID,
    customerId: CUSTOMER_ID,
    stripePaymentMethodId: "pm_refund_test_001",
    type: "card",
    isDefault: true,
    lastFour: "4242",
    brand: "visa",
  });

  await seedInvoice({
    id: INVOICE_ID,
    customerId: CUSTOMER_ID,
    status: "paid",
    totalAmountCents: 10000,
    billingPeriodStart: new Date("2026-01-01"),
    billingPeriodEnd: new Date("2026-02-01"),
    dueDate: new Date("2026-01-15"),
    lineItems: [
      {
        id: LINE_ITEM_ID,
        type: "subscription",
        description: "Monthly subscription",
        amountCents: 10000,
        quantity: 1,
      },
    ],
  });

  await seedCharge({
    id: CHARGE_ID,
    invoiceId: INVOICE_ID,
    customerId: CUSTOMER_ID,
    paymentMethodId: PAYMENT_METHOD_ID,
    amountCents: 10000,
    currency: "usd",
    status: "succeeded",
    stripePaymentIntentId: "pi_refund_test_001",
    idempotencyKey: "charge-key-refund-001",
  });
}

describe("Refunds E2E", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    await setupTestDatabase();
    await cleanDatabase();
    await seedLedgerAccounts();
    await waitForStripeMock();

    // Purge outbound queue for clean state
    await purgeSqsQueue(OUTBOUND_QUEUE_URL).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1000));

    app = await createTestApp();
  }, 30000);

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedLedgerAccounts();
  });

  // ──────────────────────────────────────────────
  // AC #1: POST /v1/admin/refunds — admin role → 201
  // ──────────────────────────────────────────────
  describe("POST /v1/admin/refunds", () => {
    it("should create a refund and return 201 with full refund details (AC #1)", async () => {
      await seedRefundTestData();

      const body = {
        chargeId: CHARGE_ID,
        amountCents: 5000,
        reason: "requested_by_customer",
      };

      const headers = signRequest("POST", "/v1/admin/refunds", body, {
        adminRole: "admin",
        adminUserId: "admin-user-1",
      });

      const response = await request(app.getHttpServer())
        .post("/v1/admin/refunds")
        .set(headers)
        .set("x-idempotency-key", "refund-idem-001")
        .send(body)
        .expect(201);

      expect(response.body).toMatchObject({
        id: expect.any(String) as string,
        chargeId: CHARGE_ID,
        invoiceId: INVOICE_ID,
        customerId: CUSTOMER_ID,
        amountCents: 5000,
        currency: "usd",
        status: "succeeded",
        reason: "requested_by_customer",
        idempotencyKey: "refund-idem-001",
        gatewayRefundId: expect.any(String) as string,
        failureReason: null,
        createdAt: expect.any(String) as string,
        updatedAt: expect.any(String) as string,
      });
    });

    // AC #2: cs role → 403
    it("should return 403 when cs role is provided (AC #2)", async () => {
      const body = {
        chargeId: CHARGE_ID,
        amountCents: 5000,
        reason: "requested_by_customer",
      };

      const headers = signRequest("POST", "/v1/admin/refunds", body, {
        adminRole: "cs",
        adminUserId: "cs-user-1",
      });

      const response = await request(app.getHttpServer())
        .post("/v1/admin/refunds")
        .set(headers)
        .set("x-idempotency-key", "refund-idem-cs-001")
        .send(body)
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
        message: "Forbidden resource",
      });
    });

    // AC #2 additive: finance role → 403
    it("should return 403 when finance role is provided (AC #2)", async () => {
      const body = {
        chargeId: CHARGE_ID,
        amountCents: 5000,
        reason: "requested_by_customer",
      };

      const headers = signRequest("POST", "/v1/admin/refunds", body, {
        adminRole: "finance",
        adminUserId: "finance-user-1",
      });

      const response = await request(app.getHttpServer())
        .post("/v1/admin/refunds")
        .set(headers)
        .set("x-idempotency-key", "refund-idem-finance-001")
        .send(body)
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
        message: "Forbidden resource",
      });
    });

    // AC #8: Missing idempotency key → 400
    it("should return 400 when x-idempotency-key header is missing (AC #8)", async () => {
      const body = {
        chargeId: CHARGE_ID,
        amountCents: 5000,
        reason: "requested_by_customer",
      };

      const headers = signRequest("POST", "/v1/admin/refunds", body, {
        adminRole: "admin",
        adminUserId: "admin-user-1",
      });

      const response = await request(app.getHttpServer())
        .post("/v1/admin/refunds")
        .set(headers)
        .send(body)
        .expect(400);

      expect(response.body).toMatchObject({
        message: "x-idempotency-key header is required",
      });
    });

    // AC #9: Invalid body → 400 validation error
    it("should return 400 with validation errors for invalid body (AC #9)", async () => {
      const body = {
        // missing chargeId
        amountCents: -5,
        reason: "",
      };

      const headers = signRequest(
        "POST",
        "/v1/admin/refunds",
        body as Record<string, unknown>,
        {
          adminRole: "admin",
          adminUserId: "admin-user-1",
        },
      );

      const response = await request(app.getHttpServer())
        .post("/v1/admin/refunds")
        .set(headers)
        .set("x-idempotency-key", "refund-idem-invalid-001")
        .send(body)
        .expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
      });
      expect(response.body.message).toBeDefined();

      // Verify specific validation errors are reported
      const messages = response.body.message as string[];
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.stringContaining("chargeId") as string,
          expect.stringContaining("amountCents") as string,
          expect.stringContaining("reason") as string,
        ]),
      );
    });
  });

  // ──────────────────────────────────────────────
  // AC #3, #4: GET /v1/admin/refunds/:id
  // ──────────────────────────────────────────────
  describe("GET /v1/admin/refunds/:id", () => {
    it("should return refund details when found (AC #3)", async () => {
      await seedRefundTestData();

      // First, create a refund
      const createBody = {
        chargeId: CHARGE_ID,
        amountCents: 3000,
        reason: "duplicate",
      };

      const createHeaders = signRequest(
        "POST",
        "/v1/admin/refunds",
        createBody,
        {
          adminRole: "admin",
          adminUserId: "admin-user-1",
        },
      );

      const createResponse = await request(app.getHttpServer())
        .post("/v1/admin/refunds")
        .set(createHeaders)
        .set("x-idempotency-key", "refund-idem-get-001")
        .send(createBody)
        .expect(201);

      const refundId = (createResponse.body as { id: string }).id;

      // Now GET it
      const getHeaders = signRequest(
        "GET",
        `/v1/admin/refunds/${refundId}`,
        undefined,
        {
          adminRole: "admin",
          adminUserId: "admin-user-1",
        },
      );

      const getResponse = await request(app.getHttpServer())
        .get(`/v1/admin/refunds/${refundId}`)
        .set(getHeaders)
        .expect(200);

      expect(getResponse.body).toMatchObject({
        id: refundId,
        chargeId: CHARGE_ID,
        invoiceId: INVOICE_ID,
        customerId: CUSTOMER_ID,
        amountCents: 3000,
        currency: "usd",
        status: "succeeded",
        reason: "duplicate",
        idempotencyKey: "refund-idem-get-001",
        gatewayRefundId: expect.any(String) as string,
        failureReason: null,
        createdAt: expect.any(String) as string,
        updatedAt: expect.any(String) as string,
      });
    });

    // AC #4: Non-existent UUID → 404
    it("should return 404 for a non-existent refund UUID (AC #4)", async () => {
      const nonExistentId = "f0000000-0000-4000-a000-000000000099";

      const headers = signRequest(
        "GET",
        `/v1/admin/refunds/${nonExistentId}`,
        undefined,
        {
          adminRole: "admin",
          adminUserId: "admin-user-1",
        },
      );

      await request(app.getHttpServer())
        .get(`/v1/admin/refunds/${nonExistentId}`)
        .set(headers)
        .expect(404);
    });
  });

  // ──────────────────────────────────────────────
  // AC #5: SQS refund.succeeded event
  // ──────────────────────────────────────────────
  describe("SQS event publishing", () => {
    it("should publish refund.succeeded event to SQS with correct envelope (AC #5)", async () => {
      await seedRefundTestData();

      // Purge queue before test
      await purgeSqsQueue(OUTBOUND_QUEUE_URL);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const body = {
        chargeId: CHARGE_ID,
        amountCents: 5000,
        reason: "requested_by_customer",
      };

      const headers = signRequest("POST", "/v1/admin/refunds", body, {
        adminRole: "admin",
        adminUserId: "admin-user-1",
      });

      const response = await request(app.getHttpServer())
        .post("/v1/admin/refunds")
        .set(headers)
        .set("x-idempotency-key", "refund-idem-sqs-001")
        .send(body)
        .expect(201);

      const refundId = (response.body as { id: string }).id;

      // Poll for SQS message
      const messages = await receiveSqsMessages(OUTBOUND_QUEUE_URL, 5000);
      expect(messages.length).toBeGreaterThan(0);

      const envelope = JSON.parse(messages[0].Body!) as SqsEnvelope;
      expect(envelope.version).toBe("1.0");
      expect(envelope.type).toBe("refund.succeeded");
      expect(envelope.timestamp).toBeDefined();
      expect(envelope.correlationId).toBeDefined();

      const payload = envelope.payload as Record<string, unknown>;
      expect(payload).toMatchObject({
        refundId,
        chargeId: CHARGE_ID,
        invoiceId: INVOICE_ID,
        customerId: CUSTOMER_ID,
        amount: 5000,
        currency: "usd",
        reason: "requested_by_customer",
        gatewayProvider: "stripe",
      });
    });
  });

  // ──────────────────────────────────────────────
  // AC #7: Full refund flow E2E
  // ──────────────────────────────────────────────
  describe("Full refund flow", () => {
    it("should process refund end-to-end: seed → create → verify DB → verify ledger (AC #7)", async () => {
      await seedRefundTestData();

      const body = {
        chargeId: CHARGE_ID,
        amountCents: 5000,
        reason: "requested_by_customer",
      };

      const headers = signRequest("POST", "/v1/admin/refunds", body, {
        adminRole: "admin",
        adminUserId: "admin-user-1",
      });

      const response = await request(app.getHttpServer())
        .post("/v1/admin/refunds")
        .set(headers)
        .set("x-idempotency-key", "refund-idem-full-001")
        .send(body)
        .expect(201);

      const refundId = (response.body as { id: string }).id;

      // Verify DB state
      const db = getTestDatabase();
      const refundRows = await db.execute(
        sql`SELECT * FROM refunds WHERE id = ${refundId}`,
      );
      expect(refundRows.rows.length).toBe(1);

      const refundRow = refundRows.rows[0];
      expect(refundRow.status).toBe("succeeded");
      expect(refundRow.amount_cents).toBe(5000);
      expect(refundRow.gateway_refund_id).toBeDefined();
      expect(refundRow.gateway_refund_id).not.toBeNull();

      // Verify ledger entries (refund creates debit on refunds, credit on cash)
      const ledgerRows = await db.execute(
        sql`SELECT * FROM ledger_entries WHERE reference_type = 'refund' AND reference_id = ${refundId}`,
      );
      expect(ledgerRows.rows.length).toBe(1);

      const ledgerEntry = ledgerRows.rows[0];
      expect(Number(ledgerEntry.amount_cents)).toBe(5000);
    });
  });

  // ──────────────────────────────────────────────
  // AC #10: Audit trail for refund creation
  // ──────────────────────────────────────────────
  describe("Audit trail", () => {
    it("should create audit trail record for POST /v1/admin/refunds (AC #10)", async () => {
      await seedRefundTestData();

      const body = {
        chargeId: CHARGE_ID,
        amountCents: 2000,
        reason: "fraudulent",
      };

      const headers = signRequest("POST", "/v1/admin/refunds", body, {
        adminRole: "admin",
        adminUserId: "admin-user-audit",
      });

      const response = await request(app.getHttpServer())
        .post("/v1/admin/refunds")
        .set(headers)
        .set("x-idempotency-key", "refund-idem-audit-001")
        .send(body)
        .expect(201);

      const refundId = (response.body as { id: string }).id;

      // Wait for async audit trail flush
      await new Promise((resolve) => setTimeout(resolve, AUDIT_FLUSH_MS));

      const auditRecords = await getAuditTrailRecords();
      const refundAudit = auditRecords.find(
        (r) => r.entity_type === "refunds" && r.entity_id === refundId,
      );

      expect(refundAudit).toBeDefined();
      expect(refundAudit!.admin_user_id).toBe("admin-user-audit");
      expect(refundAudit!.action).toBe("POST /v1/admin/refunds");
    });
  });

  // ──────────────────────────────────────────────
  // AC #7 additive: Idempotency — duplicate returns same refund
  // ──────────────────────────────────────────────
  describe("Idempotency", () => {
    it("should return same refund on duplicate POST with same idempotency key (AC #7)", async () => {
      await seedRefundTestData();

      const body = {
        chargeId: CHARGE_ID,
        amountCents: 4000,
        reason: "duplicate",
      };

      const headers = signRequest("POST", "/v1/admin/refunds", body, {
        adminRole: "admin",
        adminUserId: "admin-user-1",
      });

      // First request
      const response1 = await request(app.getHttpServer())
        .post("/v1/admin/refunds")
        .set(headers)
        .set("x-idempotency-key", "refund-idem-dup-001")
        .send(body)
        .expect(201);

      const refundId1 = (response1.body as { id: string }).id;

      // Duplicate request with same idempotency key
      const headers2 = signRequest("POST", "/v1/admin/refunds", body, {
        adminRole: "admin",
        adminUserId: "admin-user-1",
      });

      const response2 = await request(app.getHttpServer())
        .post("/v1/admin/refunds")
        .set(headers2)
        .set("x-idempotency-key", "refund-idem-dup-001")
        .send(body)
        .expect(201);

      const refundId2 = (response2.body as { id: string }).id;

      // Same refund returned
      expect(refundId1).toBe(refundId2);
    });
  });
});
