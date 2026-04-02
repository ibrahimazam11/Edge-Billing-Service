import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { App } from "supertest/types";
import { signRequest } from "./helpers/hmac-signer";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  seedCustomer,
  seedPaymentMethod,
  seedSubscription,
  seedInvoice,
  seedCharge,
  seedCreditNote,
  seedRefund,
  seedLedgerAccounts,
  getAuditTrailRecords,
} from "./helpers/database";
import { createTestApp } from "./helpers/test-app";

// ─── UUID Constants (b prefix to avoid collision with e/f/c specs) ───
const customerAId = "b0000000-0000-4000-a000-000000000001";
const customerBId = "b0000000-0000-4000-a000-000000000002";

const pm1Id = "b0000000-0000-4000-a000-000000000010";
const pm2Id = "b0000000-0000-4000-a000-000000000011";

const sub1Id = "b0000000-0000-4000-a000-000000000020";
const sub2Id = "b0000000-0000-4000-a000-000000000021";
const sub3Id = "b0000000-0000-4000-a000-000000000022";
const sub4Id = "b0000000-0000-4000-a000-000000000023";

const inv1Id = "b0000000-0000-4000-a000-000000000030";
const inv2Id = "b0000000-0000-4000-a000-000000000031";

const charge1Id = "b0000000-0000-4000-a000-000000000040";
const charge2Id = "b0000000-0000-4000-a000-000000000041";

const cn1Id = "b0000000-0000-4000-a000-000000000050";

const refund1Id = "b0000000-0000-4000-a000-000000000060";

const nonExistentId = "b0000000-0000-4000-a000-ffffffffffff";

const AUDIT_FLUSH_MS = 500;

// ─── Header Helpers ───
function adminHeaders(
  method: string,
  path: string,
  body?: Record<string, unknown>,
) {
  return signRequest(method, path, body, {
    adminRole: "admin",
    adminUserId: "admin-e2e-1",
  });
}

function csHeaders(
  method: string,
  path: string,
  body?: Record<string, unknown>,
) {
  return signRequest(method, path, body, {
    adminRole: "cs",
    adminUserId: "cs-e2e-1",
  });
}

function financeHeaders(
  method: string,
  path: string,
  body?: Record<string, unknown>,
) {
  return signRequest(method, path, body, {
    adminRole: "finance",
    adminUserId: "finance-e2e-1",
  });
}

describe("Expanded Admin E2E (Story 14.3)", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    await setupTestDatabase();
    await seedLedgerAccounts();
    app = await createTestApp();
    await cleanDatabase();
    await seedLedgerAccounts();

    // ─── Customers ───
    await seedCustomer({
      id: customerAId,
      monolithCustomerId: "mono-g-001",
      name: "Admin E2E Customer A",
      email: "admin-e2e-a@test.com",
      status: "active",
    });
    await seedCustomer({
      id: customerBId,
      monolithCustomerId: "mono-g-002",
      name: "Admin E2E Customer B",
      email: "admin-e2e-b@test.com",
      status: "active",
    });

    // ─── Payment Methods ───
    await seedPaymentMethod({
      id: pm1Id,
      customerId: customerAId,
      stripePaymentMethodId: "pm_g_001",
      type: "card",
      isDefault: true,
      lastFour: "4242",
      brand: "visa",
    });
    await seedPaymentMethod({
      id: pm2Id,
      customerId: customerAId,
      stripePaymentMethodId: "pm_g_002",
      type: "card",
      isDefault: false,
      lastFour: "5555",
      brand: "mastercard",
    });

    // ─── Subscriptions ───
    const billingStart = new Date("2026-01-01T00:00:00.000Z");
    const billingEnd = new Date("2026-01-31T23:59:59.999Z");
    const nextBilling = new Date("2026-02-01T00:00:00.000Z");

    await seedSubscription({
      id: sub1Id,
      customerId: customerAId,
      planName: "Pro Plan",
      amountCents: 5000,
      billingPeriodStart: billingStart,
      billingPeriodEnd: billingEnd,
      nextBillingDate: nextBilling,
      status: "active",
    });
    await seedSubscription({
      id: sub2Id,
      customerId: customerAId,
      planName: "Pro Plan",
      amountCents: 5000,
      billingPeriodStart: billingStart,
      billingPeriodEnd: billingEnd,
      nextBillingDate: nextBilling,
      status: "active",
    });
    await seedSubscription({
      id: sub3Id,
      customerId: customerAId,
      planName: "Pro Plan",
      amountCents: 5000,
      billingPeriodStart: billingStart,
      billingPeriodEnd: billingEnd,
      nextBillingDate: nextBilling,
      status: "active",
    });
    await seedSubscription({
      id: sub4Id,
      customerId: customerAId,
      planName: "Pro Plan",
      amountCents: 5000,
      billingPeriodStart: billingStart,
      billingPeriodEnd: billingEnd,
      nextBillingDate: null,
      status: "canceled",
    });

    // ─── Invoices (with line items) ───
    // Explicit timestamps ensure deterministic ordering for cursor pagination tests
    await seedInvoice({
      id: inv1Id,
      customerId: customerAId,
      subscriptionId: sub1Id,
      status: "paid",
      totalAmountCents: 5000,
      billingPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
      billingPeriodEnd: new Date("2026-01-31T00:00:00.000Z"),
      dueDate: new Date("2026-02-01T00:00:00.000Z"),
      createdAt: new Date("2026-02-20T08:00:00.000Z"),
      lineItems: [
        {
          id: "b0000000-0000-4000-a000-000000000070",
          type: "subscription",
          description: "Pro Plan - January 2026",
          amountCents: 5000,
          quantity: 1,
        },
      ],
    });
    await seedInvoice({
      id: inv2Id,
      customerId: customerAId,
      subscriptionId: sub2Id,
      status: "finalized",
      totalAmountCents: 3000,
      billingPeriodStart: new Date("2026-02-01T00:00:00.000Z"),
      billingPeriodEnd: new Date("2026-02-28T00:00:00.000Z"),
      dueDate: new Date("2026-03-01T00:00:00.000Z"),
      createdAt: new Date("2026-02-20T09:00:00.000Z"),
      lineItems: [
        {
          id: "b0000000-0000-4000-a000-000000000071",
          type: "subscription",
          description: "Pro Plan - February 2026",
          amountCents: 3000,
          quantity: 1,
        },
      ],
    });

    // ─── Charges ───
    // Explicit timestamps ensure deterministic ordering for cursor pagination tests
    await seedCharge({
      id: charge1Id,
      invoiceId: inv1Id,
      customerId: customerAId,
      paymentMethodId: pm1Id,
      amountCents: 5000,
      status: "succeeded",
      idempotencyKey: "idem-g-001",
      attemptNumber: 1,
      createdAt: new Date("2026-02-20T10:00:00.000Z"),
    });
    await seedCharge({
      id: charge2Id,
      invoiceId: inv2Id,
      customerId: customerAId,
      paymentMethodId: pm1Id,
      amountCents: 3000,
      status: "failed",
      idempotencyKey: "idem-g-002",
      attemptNumber: 1,
      failureReason: "card_declined",
      createdAt: new Date("2026-02-20T11:00:00.000Z"),
    });

    // ─── Credit Note ───
    await seedCreditNote({
      id: cn1Id,
      customerId: customerAId,
      invoiceId: inv1Id,
      amountCents: 1000,
      reason: "Goodwill adjustment",
      createdAt: new Date("2026-02-20T12:00:00.000Z"),
    });

    // ─── Refund ───
    await seedRefund({
      id: refund1Id,
      chargeId: charge1Id,
      invoiceId: inv1Id,
      customerId: customerAId,
      amountCents: 2000,
      status: "succeeded",
      reason: "Customer request",
      idempotencyKey: "idem-g-refund-001",
      createdAt: new Date("2026-02-20T13:00:00.000Z"),
    });
  }, 60_000);

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
    await closeDatabase();
  });

  // ═══════════════════════════════════════════════════════════
  // BILLING HISTORY (AC #1, #2, #3, #4, #5)
  // ═══════════════════════════════════════════════════════════
  describe("GET /v1/admin/customers/:id/billing-history", () => {
    const basePath = (id: string) =>
      `/v1/admin/customers/${id}/billing-history`;

    it("should return unified billing history sorted by createdAt DESC (AC1)", async () => {
      const path = basePath(customerAId);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(adminHeaders("GET", path))
        .expect(200);

      const { data, hasMore } = response.body;

      // Should contain all 4 types: 2 invoices, 2 charges, 1 credit, 1 refund = 6 items
      expect(data).toHaveLength(6);
      expect(hasMore).toBe(false);

      // Verify all 4 types present
      const types = data.map((item: { type: string }) => item.type);
      expect(types).toContain("invoice");
      expect(types).toContain("payment");
      expect(types).toContain("credit");
      expect(types).toContain("refund");

      // Verify descending createdAt order
      for (let i = 1; i < data.length; i++) {
        const prev = new Date(data[i - 1].createdAt as string).getTime();
        const curr = new Date(data[i].createdAt as string).getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }

      // Verify specific field values
      const invoice1 = data.find(
        (item: { referenceId: string }) => item.referenceId === inv1Id,
      );
      expect(invoice1).toMatchObject({
        type: "invoice",
        referenceId: inv1Id,
        description: expect.stringContaining("Invoice for"),
        amountCents: 5000,
        currency: "usd",
        status: "paid",
      });

      const payment1 = data.find(
        (item: { referenceId: string }) => item.referenceId === charge1Id,
      );
      expect(payment1).toMatchObject({
        type: "payment",
        referenceId: charge1Id,
        description: "Payment attempt #1 - succeeded",
        amountCents: 5000,
        currency: "usd",
        status: "succeeded",
      });

      const payment2 = data.find(
        (item: { referenceId: string }) => item.referenceId === charge2Id,
      );
      expect(payment2).toMatchObject({
        type: "payment",
        referenceId: charge2Id,
        description: "Payment attempt #1 - Failed: card_declined",
        amountCents: 3000,
        currency: "usd",
        status: "failed",
      });

      const credit1 = data.find(
        (item: { referenceId: string }) => item.referenceId === cn1Id,
      );
      expect(credit1).toMatchObject({
        type: "credit",
        referenceId: cn1Id,
        description: "Credit note: Goodwill adjustment",
        amountCents: 1000,
        currency: "usd",
        status: "issued",
      });

      const refundItem = data.find(
        (item: { referenceId: string }) => item.referenceId === refund1Id,
      );
      expect(refundItem).toMatchObject({
        type: "refund",
        referenceId: refund1Id,
        description: "Refund: Customer request",
        amountCents: 2000,
        currency: "usd",
        status: "succeeded",
      });
    });

    it("should filter by type=payment (AC2)", async () => {
      const path = basePath(customerAId);
      const response = await request(app.getHttpServer())
        .get(path)
        .query({ type: "payment" })
        .set(adminHeaders("GET", path))
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      for (const item of response.body.data) {
        expect(item.type).toBe("payment");
      }
    });

    it("should filter by type=invoice (AC2)", async () => {
      const path = basePath(customerAId);
      const response = await request(app.getHttpServer())
        .get(path)
        .query({ type: "invoice" })
        .set(adminHeaders("GET", path))
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      for (const item of response.body.data) {
        expect(item.type).toBe("invoice");
      }
    });

    it("should filter by type=credit (AC2)", async () => {
      const path = basePath(customerAId);
      const response = await request(app.getHttpServer())
        .get(path)
        .query({ type: "credit" })
        .set(adminHeaders("GET", path))
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].type).toBe("credit");
    });

    it("should filter by type=refund (AC2)", async () => {
      const path = basePath(customerAId);
      const response = await request(app.getHttpServer())
        .get(path)
        .query({ type: "refund" })
        .set(adminHeaders("GET", path))
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].type).toBe("refund");
    });

    it("should filter by dateFrom and dateTo (AC3)", async () => {
      const path = basePath(customerAId);
      // First get all records to know their timestamps
      const allResponse = await request(app.getHttpServer())
        .get(path)
        .set(adminHeaders("GET", path))
        .expect(200);

      const allItems = allResponse.body.data as {
        createdAt: string;
        type: string;
      }[];
      expect(allItems).toHaveLength(6);

      // Use the earliest and latest timestamps to create a range that includes all items
      const timestamps = allItems.map((item) =>
        new Date(item.createdAt).getTime(),
      );
      const earliest = new Date(Math.min(...timestamps));
      const latest = new Date(Math.max(...timestamps));

      // Wide range: dateFrom = earliest - 1ms, dateTo = latest + 1ms — includes everything
      const dateFrom = new Date(earliest.getTime() - 1).toISOString();
      const dateTo = new Date(latest.getTime() + 1).toISOString();

      const wideResponse = await request(app.getHttpServer())
        .get(path)
        .query({ dateFrom, dateTo })
        .set(adminHeaders("GET", path))
        .expect(200);

      expect(wideResponse.body.data).toHaveLength(6);

      // dateTo in the far past — excludes everything (half-open: >= dateFrom, < dateTo)
      const pastDate = new Date("2020-01-01T00:00:00.000Z").toISOString();
      const pastResponse = await request(app.getHttpServer())
        .get(path)
        .query({ dateTo: pastDate })
        .set(adminHeaders("GET", path))
        .expect(200);

      expect(pastResponse.body.data).toHaveLength(0);

      // dateFrom in the far future — excludes everything
      const futureDate = new Date("2030-01-01T00:00:00.000Z").toISOString();
      const futureResponse = await request(app.getHttpServer())
        .get(path)
        .query({ dateFrom: futureDate })
        .set(adminHeaders("GET", path))
        .expect(200);

      expect(futureResponse.body.data).toHaveLength(0);
    });

    it("should support cursor-based pagination (AC4)", async () => {
      const path = basePath(customerAId);
      // Page 1: limit=2
      const page1 = await request(app.getHttpServer())
        .get(path)
        .query({ limit: 2 })
        .set(adminHeaders("GET", path))
        .expect(200);

      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.hasMore).toBe(true);
      expect(page1.body.cursor).toBeDefined();
      expect(typeof page1.body.cursor).toBe("string");

      // Page 2: use cursor from page 1
      const page2 = await request(app.getHttpServer())
        .get(path)
        .query({ limit: 2, cursor: page1.body.cursor as string })
        .set(adminHeaders("GET", path))
        .expect(200);

      expect(page2.body.data).toHaveLength(2);

      // No overlap between page 1 and page 2
      const page1Ids = (page1.body.data as { id: string }[]).map(
        (item) => item.id,
      );
      const page2Ids = (page2.body.data as { id: string }[]).map(
        (item) => item.id,
      );
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }

      // Continue paginating until hasMore is false
      let currentCursor = page2.body.cursor as string | null;
      const allIds = [...page1Ids, ...page2Ids];

      while (currentCursor) {
        const nextPage = await request(app.getHttpServer())
          .get(path)
          .query({ limit: 2, cursor: currentCursor })
          .set(adminHeaders("GET", path))
          .expect(200);

        const nextIds = (nextPage.body.data as { id: string }[]).map(
          (item) => item.id,
        );

        // No overlap with previous pages
        for (const id of nextIds) {
          expect(allIds).not.toContain(id);
        }
        allIds.push(...nextIds);
        currentCursor = nextPage.body.cursor as string | null;
      }

      // All pages together should cover all 6 billing history items
      expect(allIds).toHaveLength(6);
    });

    it("should return 404 for non-existent customer (AC5)", async () => {
      const path = basePath(nonExistentId);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(adminHeaders("GET", path))
        .expect(404);

      expect(response.body).toMatchObject({
        statusCode: 404,
        message: expect.stringContaining(nonExistentId),
      });
    });

    it("should return empty data for customer with no billing history", async () => {
      const path = basePath(customerBId);
      const response = await request(app.getHttpServer())
        .get(path)
        .set(adminHeaders("GET", path))
        .expect(200);

      expect(response.body).toMatchObject({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // BULK SUBSCRIPTION OPERATIONS (AC #10, #11, #12, #13)
  // Must run BEFORE audit trail tests (generates audit entries)
  // ═══════════════════════════════════════════════════════════
  describe("POST /v1/admin/subscriptions/bulk", () => {
    const bulkPath = "/v1/admin/subscriptions/bulk";

    it("should bulk pause active subscriptions successfully (AC10)", async () => {
      const body = {
        action: "pause",
        subscriptionIds: [sub1Id, sub2Id, sub3Id],
      };
      const response = await request(app.getHttpServer())
        .post(bulkPath)
        .set(adminHeaders("POST", bulkPath, body))
        .send(body)
        .expect(200);

      expect(response.body).toMatchObject({
        successCount: 3,
        failureCount: 0,
      });
      expect(response.body.results).toHaveLength(3);
      for (const result of response.body.results as {
        subscriptionId: string;
        success: boolean;
      }[]) {
        expect(result.success).toBe(true);
      }
    });

    it("should verify paused subscriptions persist via GET (AC10)", async () => {
      for (const subId of [sub1Id, sub2Id, sub3Id]) {
        const subPath = `/v1/subscriptions/${subId}`;
        const response = await request(app.getHttpServer())
          .get(subPath)
          .set(signRequest("GET", subPath))
          .expect(200);

        expect(response.body.status).toBe("paused");
      }
    });

    it("should bulk cancel with partial failure for already-cancelled subscription (AC11)", async () => {
      // sub1, sub2, sub3 are now paused (from previous test)
      // sub4 is already canceled
      // Cancel: sub1 (paused→canceled ok), sub2 (paused→canceled ok), sub4 (canceled→canceled fail)
      const body = {
        action: "cancel",
        subscriptionIds: [sub1Id, sub2Id, sub4Id],
      };
      const response = await request(app.getHttpServer())
        .post(bulkPath)
        .set(adminHeaders("POST", bulkPath, body))
        .send(body)
        .expect(200);

      expect(response.body).toMatchObject({
        successCount: 2,
        failureCount: 1,
      });
      expect(response.body.results).toHaveLength(3);

      // Check individual results
      const sub1Result = (
        response.body.results as {
          subscriptionId: string;
          success: boolean;
        }[]
      ).find((r) => r.subscriptionId === sub1Id);
      expect(sub1Result?.success).toBe(true);

      const sub2Result = (
        response.body.results as {
          subscriptionId: string;
          success: boolean;
        }[]
      ).find((r) => r.subscriptionId === sub2Id);
      expect(sub2Result?.success).toBe(true);

      const sub4Result = (
        response.body.results as {
          subscriptionId: string;
          success: boolean;
          reason?: string;
        }[]
      ).find((r) => r.subscriptionId === sub4Id);
      expect(sub4Result?.success).toBe(false);
      expect(sub4Result?.reason).toBeDefined();
      expect(typeof sub4Result?.reason).toBe("string");
    });

    it("should verify cancelled subscriptions persist via GET (AC11)", async () => {
      // sub1, sub2 should now be canceled
      for (const subId of [sub1Id, sub2Id]) {
        const subPath = `/v1/subscriptions/${subId}`;
        const response = await request(app.getHttpServer())
          .get(subPath)
          .set(signRequest("GET", subPath))
          .expect(200);

        expect(response.body.status).toBe("canceled");
      }

      // sub4 should still be canceled (unchanged)
      const sub4Path = `/v1/subscriptions/${sub4Id}`;
      const sub4Response = await request(app.getHttpServer())
        .get(sub4Path)
        .set(signRequest("GET", sub4Path))
        .expect(200);

      expect(sub4Response.body.status).toBe("canceled");
    });

    it("should return 400 for empty subscriptionIds array (AC13)", async () => {
      const body = { action: "pause", subscriptionIds: [] };
      const response = await request(app.getHttpServer())
        .post(bulkPath)
        .set(adminHeaders("POST", bulkPath, body))
        .send(body)
        .expect(400);

      expect(response.body.statusCode).toBe(400);
      expect(response.body.message).toEqual(
        expect.arrayContaining([expect.any(String)]),
      );
    });

    it("should return 400 for subscriptionIds exceeding 50 (AC12)", async () => {
      const ids = Array.from(
        { length: 51 },
        (_, i) => `b0000000-0000-4000-a000-${String(i).padStart(12, "0")}`,
      );
      const body = { action: "pause", subscriptionIds: ids };
      const response = await request(app.getHttpServer())
        .post(bulkPath)
        .set(adminHeaders("POST", bulkPath, body))
        .send(body)
        .expect(400);

      expect(response.body.statusCode).toBe(400);
      expect(response.body.message).toEqual(
        expect.arrayContaining([expect.any(String)]),
      );
    });

    it("should return 400 for invalid action", async () => {
      const body = { action: "resume", subscriptionIds: [sub3Id] };
      const response = await request(app.getHttpServer())
        .post(bulkPath)
        .set(adminHeaders("POST", bulkPath, body))
        .send(body)
        .expect(400);

      expect(response.body.statusCode).toBe(400);
      expect(response.body.message).toEqual(
        expect.arrayContaining([expect.any(String)]),
      );
    });

    it("should handle non-existent subscription in bulk operation", async () => {
      const body = {
        action: "pause",
        subscriptionIds: [nonExistentId],
      };
      const response = await request(app.getHttpServer())
        .post(bulkPath)
        .set(adminHeaders("POST", bulkPath, body))
        .send(body)
        .expect(200);

      expect(response.body).toMatchObject({
        successCount: 0,
        failureCount: 1,
      });
      expect(response.body.results).toHaveLength(1);
      expect(response.body.results[0]).toMatchObject({
        subscriptionId: nonExistentId,
        success: false,
      });
      expect(typeof response.body.results[0].reason).toBe("string");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // AUDIT TRAIL (AC #6, #7, #8, #9, #15)
  // Runs AFTER bulk operations which generate audit entries
  // ═══════════════════════════════════════════════════════════
  describe("GET /v1/admin/audit-trail", () => {
    const auditPath = "/v1/admin/audit-trail";

    // Wait for fire-and-forget audit writes from bulk operations above
    beforeAll(async () => {
      await new Promise((resolve) => setTimeout(resolve, AUDIT_FLUSH_MS));
    });

    it("should return audit trail records sorted by id DESC (AC6)", async () => {
      const response = await request(app.getHttpServer())
        .get(auditPath)
        .set(adminHeaders("GET", auditPath))
        .expect(200);

      const { data } = response.body;
      // 3 bulk operations (pause, cancel, non-existent) each generated an audit entry
      expect(data).toHaveLength(3);

      // Verify descending id order
      for (let i = 1; i < data.length; i++) {
        expect(data[i - 1].id > data[i].id).toBe(true);
      }

      // Verify correct field structure for first record (including details per AC6)
      expect(data[0]).toMatchObject({
        id: expect.any(String),
        adminUserId: "admin-e2e-1",
        action: "POST /v1/admin/subscriptions/bulk",
        entityType: "subscriptions",
        entityId: expect.any(String),
        details: expect.anything(),
        createdAt: expect.any(String),
      });
    });

    it("should filter by entityType (AC7)", async () => {
      // Bulk subscription operations create entity_type "subscriptions" audit entries
      // (path /v1/admin/subscriptions/bulk → entityType = "subscriptions")
      const response = await request(app.getHttpServer())
        .get(auditPath)
        .query({ entityType: "subscriptions" })
        .set(adminHeaders("GET", auditPath))
        .expect(200);

      const { data } = response.body;
      // 3 bulk operations all have entityType "subscriptions"
      expect(data).toHaveLength(3);
      for (const record of data as { entityType: string }[]) {
        expect(record.entityType).toBe("subscriptions");
      }
    });

    it("should filter by adminUserId (AC8)", async () => {
      const response = await request(app.getHttpServer())
        .get(auditPath)
        .query({ adminUserId: "admin-e2e-1" })
        .set(adminHeaders("GET", auditPath))
        .expect(200);

      const { data } = response.body;
      // All 3 audit entries were created by admin-e2e-1
      expect(data).toHaveLength(3);
      for (const record of data as { adminUserId: string }[]) {
        expect(record.adminUserId).toBe("admin-e2e-1");
      }
    });

    it("should support cursor-based pagination (AC9)", async () => {
      // Page 1: limit=1 (3 total entries)
      const page1 = await request(app.getHttpServer())
        .get(auditPath)
        .query({ limit: 1 })
        .set(adminHeaders("GET", auditPath))
        .expect(200);

      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.hasMore).toBe(true);
      expect(page1.body.cursor).toBeDefined();

      // Page 2: use cursor from page 1
      const page2 = await request(app.getHttpServer())
        .get(auditPath)
        .query({ limit: 1, cursor: page1.body.cursor as string })
        .set(adminHeaders("GET", auditPath))
        .expect(200);

      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.hasMore).toBe(true);

      // No overlap between pages
      const page1Ids = (page1.body.data as { id: string }[]).map(
        (item) => item.id,
      );
      const page2Ids = (page2.body.data as { id: string }[]).map(
        (item) => item.id,
      );
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }

      // Page 3: last page
      const page3 = await request(app.getHttpServer())
        .get(auditPath)
        .query({ limit: 1, cursor: page2.body.cursor as string })
        .set(adminHeaders("GET", auditPath))
        .expect(200);

      expect(page3.body.data).toHaveLength(1);
      expect(page3.body.hasMore).toBe(false);
    });

    it("should return empty data when no matching entries", async () => {
      const response = await request(app.getHttpServer())
        .get(auditPath)
        .query({ entityType: "nonexistent-type-xyz" })
        .set(adminHeaders("GET", auditPath))
        .expect(200);

      expect(response.body).toMatchObject({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });

    it("should create audit record for bulk subscription operation (AC15)", async () => {
      // sub3Id is paused (from AC10) — cancel is a valid transition (paused → canceled)
      const body = {
        action: "cancel",
        subscriptionIds: [sub3Id],
      };
      const opResponse = await request(app.getHttpServer())
        .post("/v1/admin/subscriptions/bulk")
        .set(adminHeaders("POST", "/v1/admin/subscriptions/bulk", body))
        .send(body)
        .expect(200);

      // Verify the operation itself succeeded (AC15: "successful bulk operation")
      expect(opResponse.body).toMatchObject({
        successCount: 1,
        failureCount: 0,
      });

      // Wait for fire-and-forget audit write
      await new Promise((resolve) => setTimeout(resolve, AUDIT_FLUSH_MS));

      // Verify via direct DB query
      const records = await getAuditTrailRecords();
      const bulkRecord = records.find(
        (r) => r.action === "POST /v1/admin/subscriptions/bulk",
      );

      expect(bulkRecord).toBeDefined();
      expect(bulkRecord).toMatchObject({
        admin_user_id: "admin-e2e-1",
        action: "POST /v1/admin/subscriptions/bulk",
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // ROLE ENFORCEMENT (AC #14)
  // ═══════════════════════════════════════════════════════════
  describe("Role enforcement — admin-only endpoints", () => {
    const billingHistoryPath = `/v1/admin/customers/${customerAId}/billing-history`;
    const auditTrailPath = "/v1/admin/audit-trail";
    const bulkSubsPath = "/v1/admin/subscriptions/bulk";

    it("should return 403 for cs role on billing-history (AC14)", async () => {
      const response = await request(app.getHttpServer())
        .get(billingHistoryPath)
        .set(csHeaders("GET", billingHistoryPath))
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
        message: "Forbidden resource",
      });
    });

    it("should return 403 for finance role on billing-history (AC14)", async () => {
      const response = await request(app.getHttpServer())
        .get(billingHistoryPath)
        .set(financeHeaders("GET", billingHistoryPath))
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
        message: "Forbidden resource",
      });
    });

    it("should return 403 for cs role on audit-trail (AC14)", async () => {
      const response = await request(app.getHttpServer())
        .get(auditTrailPath)
        .set(csHeaders("GET", auditTrailPath))
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
        message: "Forbidden resource",
      });
    });

    it("should return 403 for finance role on audit-trail (AC14)", async () => {
      const response = await request(app.getHttpServer())
        .get(auditTrailPath)
        .set(financeHeaders("GET", auditTrailPath))
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
        message: "Forbidden resource",
      });
    });

    it("should return 403 for cs role on bulk subscriptions (AC14)", async () => {
      const body = { action: "pause", subscriptionIds: [sub3Id] };
      const response = await request(app.getHttpServer())
        .post(bulkSubsPath)
        .set(csHeaders("POST", bulkSubsPath, body))
        .send(body)
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
        message: "Forbidden resource",
      });
    });

    it("should return 403 for finance role on bulk subscriptions (AC14)", async () => {
      const body = { action: "pause", subscriptionIds: [sub3Id] };
      const response = await request(app.getHttpServer())
        .post(bulkSubsPath)
        .set(financeHeaders("POST", bulkSubsPath, body))
        .send(body)
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
        message: "Forbidden resource",
      });
    });
  });
});
