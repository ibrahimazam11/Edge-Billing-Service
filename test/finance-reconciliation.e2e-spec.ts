import { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { App } from "supertest/types";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  seedReconciliationRun,
  seedReconciliationDiscrepancy,
  getAuditTrailRecords,
} from "./helpers/database";
import { createTestApp } from "./helpers/test-app";
import { signRequest } from "./helpers/hmac-signer";

// ──────────────────────────────────────────────
// Seed Data IDs (UUIDv4, prefix "f" for finance)
// ──────────────────────────────────────────────

// Reconciliation runs
const run1Id = "f0000000-0000-4000-a000-000000000001"; // Jan 2026
const run2Id = "f0000000-0000-4000-a000-000000000002"; // Feb 2026

// Search-only discrepancies (never mutated)
const searchDisc1Id = "f0000000-0000-4000-a000-000000000010"; // run1, missing_stripe, open, diff=500
const searchDisc2Id = "f0000000-0000-4000-a000-000000000011"; // run1, amount_mismatch, open, diff=1000
const searchDisc3Id = "f0000000-0000-4000-a000-000000000012"; // run2, missing_internal, investigating, diff=200

// Mutation targets (each used by exactly one test block)
const statusDisc1Id = "f0000000-0000-4000-a000-000000000020"; // run2, open → status update target
const statusDisc2Id = "f0000000-0000-4000-a000-000000000021"; // run2, open → second status update target
const resolveDisc1Id = "f0000000-0000-4000-a000-000000000030"; // run2, open → resolve workflow target
const conflictDisc1Id = "f0000000-0000-4000-a000-000000000031"; // run1, resolved → 409 conflict test

// Export test discrepancies (pre-seeded states)
const exportDisc1Id = "f0000000-0000-4000-a000-000000000040"; // run1, resolved, diff=400
const exportDisc2Id = "f0000000-0000-4000-a000-000000000041"; // run1, resolved, diff=600

// Role enforcement test target
const roleTestDiscId = "f0000000-0000-4000-a000-000000000050"; // run2, open

const NON_EXISTENT_UUID = "f0000000-0000-4000-a000-ffffffffffff";

// ──────────────────────────────────────────────
// HMAC signing helpers
// ──────────────────────────────────────────────
function financeHeaders(
  method: string,
  path: string,
  body?: Record<string, unknown>,
) {
  return signRequest(method, path, body, {
    adminRole: "finance",
    adminUserId: "finance-user-1",
  });
}

// ──────────────────────────────────────────────
// Seed all test data
// ──────────────────────────────────────────────
async function seedAllData(): Promise<void> {
  // Distinct createdAt per run so export date-range filtering can isolate run1
  const run1CreatedAt = new Date("2026-01-15T12:00:00.000Z");
  const run2CreatedAt = new Date("2026-02-15T12:00:00.000Z");

  // Run 1: Jan 2026
  await seedReconciliationRun({
    id: run1Id,
    periodStart: new Date("2026-01-01T00:00:00.000Z"),
    periodEnd: new Date("2026-01-31T23:59:59.999Z"),
    status: "discrepancy_found",
    recordsCompared: 100,
    totalInternalAmountCents: 500000,
    totalStripeAmountCents: 498000,
  });

  // Run 2: Feb 2026
  await seedReconciliationRun({
    id: run2Id,
    periodStart: new Date("2026-02-01T00:00:00.000Z"),
    periodEnd: new Date("2026-02-28T23:59:59.999Z"),
    status: "discrepancy_found",
    recordsCompared: 120,
    totalInternalAmountCents: 600000,
    totalStripeAmountCents: 599800,
  });

  // Search-only discrepancies (run1 — never mutated)
  await seedReconciliationDiscrepancy({
    id: searchDisc1Id,
    reconciliationRunId: run1Id,
    type: "missing_stripe",
    internalReferenceId: "int-ref-001",
    expectedAmountCents: 1000,
    actualAmountCents: 500,
    differenceCents: 500,
    disputeStatus: "open",
    createdAt: run1CreatedAt,
  });

  await seedReconciliationDiscrepancy({
    id: searchDisc2Id,
    reconciliationRunId: run1Id,
    type: "amount_mismatch",
    internalReferenceId: "int-ref-002",
    stripeTransactionId: "txn_stripe_002",
    expectedAmountCents: 5000,
    actualAmountCents: 4000,
    differenceCents: 1000,
    disputeStatus: "open",
    createdAt: run1CreatedAt,
  });

  await seedReconciliationDiscrepancy({
    id: searchDisc3Id,
    reconciliationRunId: run2Id,
    type: "missing_internal",
    stripeTransactionId: "txn_stripe_003",
    expectedAmountCents: 800,
    actualAmountCents: 600,
    differenceCents: 200,
    disputeStatus: "investigating",
    createdAt: run2CreatedAt,
  });

  // Mutation target discrepancies (run2)
  await seedReconciliationDiscrepancy({
    id: statusDisc1Id,
    reconciliationRunId: run2Id,
    type: "missing_stripe",
    internalReferenceId: "int-ref-020",
    expectedAmountCents: 2000,
    actualAmountCents: 1500,
    differenceCents: 500,
    disputeStatus: "open",
    createdAt: run2CreatedAt,
  });

  await seedReconciliationDiscrepancy({
    id: statusDisc2Id,
    reconciliationRunId: run2Id,
    type: "amount_mismatch",
    internalReferenceId: "int-ref-021",
    stripeTransactionId: "txn_stripe_021",
    expectedAmountCents: 3000,
    actualAmountCents: 2700,
    differenceCents: 300,
    disputeStatus: "open",
    createdAt: run2CreatedAt,
  });

  await seedReconciliationDiscrepancy({
    id: resolveDisc1Id,
    reconciliationRunId: run2Id,
    type: "missing_stripe",
    internalReferenceId: "int-ref-030",
    expectedAmountCents: 1500,
    actualAmountCents: 1000,
    differenceCents: 500,
    disputeStatus: "open",
    createdAt: run2CreatedAt,
  });

  await seedReconciliationDiscrepancy({
    id: conflictDisc1Id,
    reconciliationRunId: run1Id,
    type: "amount_mismatch",
    internalReferenceId: "int-ref-031",
    stripeTransactionId: "txn_stripe_031",
    expectedAmountCents: 4000,
    actualAmountCents: 3500,
    differenceCents: 500,
    disputeStatus: "resolved",
    resolvedBy: "previous-user",
    resolutionNotes: "Previously resolved",
    resolvedAt: new Date("2026-01-20T10:00:00.000Z"),
    createdAt: run1CreatedAt,
  });

  // Export test discrepancies (run1, pre-seeded resolved)
  await seedReconciliationDiscrepancy({
    id: exportDisc1Id,
    reconciliationRunId: run1Id,
    type: "missing_stripe",
    internalReferenceId: "int-ref-040",
    expectedAmountCents: 900,
    actualAmountCents: 500,
    differenceCents: 400,
    disputeStatus: "resolved",
    resolvedBy: "export-user",
    resolutionNotes: "Verified with bank",
    resolvedAt: new Date("2026-01-25T10:00:00.000Z"),
    createdAt: run1CreatedAt,
  });

  await seedReconciliationDiscrepancy({
    id: exportDisc2Id,
    reconciliationRunId: run1Id,
    type: "missing_internal",
    stripeTransactionId: "txn_stripe_041",
    expectedAmountCents: 1200,
    actualAmountCents: 600,
    differenceCents: 600,
    disputeStatus: "resolved",
    resolvedBy: "export-user",
    resolutionNotes: "Matched via batch import",
    resolvedAt: new Date("2026-01-26T10:00:00.000Z"),
    createdAt: run1CreatedAt,
  });

  // Role enforcement test target (run2)
  await seedReconciliationDiscrepancy({
    id: roleTestDiscId,
    reconciliationRunId: run2Id,
    type: "missing_stripe",
    internalReferenceId: "int-ref-050",
    expectedAmountCents: 700,
    actualAmountCents: 300,
    differenceCents: 400,
    disputeStatus: "open",
    createdAt: run2CreatedAt,
  });
}

describe("Finance Reconciliation (e2e)", () => {
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
  // Task 3: Discrepancy Search E2E Tests
  // ══════════════════════════════════════════════
  describe("GET /v1/admin/reconciliation/discrepancies", () => {
    const searchPath = "/v1/admin/reconciliation/discrepancies";

    it("should filter by disputeStatus=open and return only open discrepancies", async () => {
      const headers = financeHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ disputeStatus: "open" })
        .set(headers)
        .expect(200);

      // searchDisc1, searchDisc2, statusDisc1, statusDisc2, resolveDisc1, roleTestDiscId = 6 open
      expect(response.body.data).toHaveLength(6);
      for (const disc of response.body.data) {
        expect(disc.disputeStatus).toBe("open");
      }
    });

    it("should filter by runId and return only that run's discrepancies", async () => {
      const headers = financeHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ runId: run1Id })
        .set(headers)
        .expect(200);

      // run1 has: searchDisc1, searchDisc2, conflictDisc1, exportDisc1, exportDisc2 = 5
      expect(response.body.data).toHaveLength(5);
      for (const disc of response.body.data) {
        expect(disc.reconciliationRunId).toBe(run1Id);
      }
    });

    it("should filter by dateFrom and dateTo range", async () => {
      const headers = financeHeaders("GET", searchPath);
      // Far-future date ensures no seeded discrepancies match
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ dateFrom: "2099-01-01T00:00:00.000Z" })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(0);
    });

    it("should combine filters (disputeStatus + runId) with AND logic", async () => {
      const headers = financeHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ disputeStatus: "open", runId: run1Id })
        .set(headers)
        .expect(200);

      // run1 open: searchDisc1, searchDisc2 = 2
      expect(response.body.data).toHaveLength(2);
      for (const disc of response.body.data) {
        expect(disc.disputeStatus).toBe("open");
        expect(disc.reconciliationRunId).toBe(run1Id);
      }
    });

    it("should return all discrepancies in descending order when no filters", async () => {
      const headers = financeHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .set(headers)
        .expect(200);

      // Total: 10 discrepancies
      expect(response.body.data).toHaveLength(10);
      // Verify descending order by ID
      const ids: string[] = response.body.data.map((d: { id: string }) => d.id);
      const sortedDesc = [...ids].sort().reverse();
      expect(ids).toEqual(sortedDesc);
    });

    it("should support cursor pagination with limit=2", async () => {
      const headers = financeHeaders("GET", searchPath);
      const page1 = await request(app.getHttpServer())
        .get(searchPath)
        .query({ limit: 2 })
        .set(headers)
        .expect(200);

      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.hasMore).toBe(true);
      expect(page1.body.cursor).toBeDefined();
      expect(typeof page1.body.cursor).toBe("string");

      // Follow cursor for page 2
      const page2 = await request(app.getHttpServer())
        .get(searchPath)
        .query({ limit: 2, cursor: page1.body.cursor })
        .set(headers)
        .expect(200);

      expect(page2.body.data).toHaveLength(2);
      // Page 2 IDs should not overlap with page 1
      const page1Ids = page1.body.data.map((d: { id: string }) => d.id);
      const page2Ids = page2.body.data.map((d: { id: string }) => d.id);
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }
    });

    it("should return full response shape with all 15 fields including periodStart/periodEnd", async () => {
      const headers = financeHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ runId: run1Id, disputeStatus: "open", limit: 1 })
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      const disc = response.body.data[0];

      // Verify all 16 fields exist
      expect(disc).toHaveProperty("id");
      expect(disc).toHaveProperty("reconciliationRunId");
      expect(disc).toHaveProperty("type");
      expect(disc).toHaveProperty("internalReferenceId");
      expect(disc).toHaveProperty("stripeTransactionId");
      expect(disc).toHaveProperty("expectedAmountCents");
      expect(disc).toHaveProperty("actualAmountCents");
      expect(disc).toHaveProperty("differenceCents");
      expect(disc).toHaveProperty("disputeStatus");
      expect(disc).toHaveProperty("resolvedBy");
      expect(disc).toHaveProperty("resolutionNotes");
      expect(disc).toHaveProperty("resolvedAt");
      expect(disc).toHaveProperty("createdAt");
      expect(disc).toHaveProperty("periodStart");
      expect(disc).toHaveProperty("periodEnd");

      // Verify pagination shape
      expect(response.body).toHaveProperty("cursor");
      expect(response.body).toHaveProperty("hasMore");
    });

    it("should hydrate periodStart/periodEnd from joined reconciliation run", async () => {
      const headers = financeHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ runId: run1Id, limit: 1 })
        .set(headers)
        .expect(200);

      const disc = response.body.data[0];
      expect(disc.periodStart).not.toBeNull();
      expect(disc.periodEnd).not.toBeNull();
      // Verify they are ISO strings matching run1's period
      expect(disc.periodStart).toBe("2026-01-01T00:00:00.000Z");
      expect(disc.periodEnd).toBe("2026-01-31T23:59:59.999Z");
    });

    it("should return empty result set with correct shape", async () => {
      const headers = financeHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ runId: NON_EXISTENT_UUID })
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });

    it("should return 400 for invalid disputeStatus filter value", async () => {
      const headers = financeHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ disputeStatus: "invalid_status" })
        .set(headers)
        .expect(400);

      expect(response.body.statusCode).toBe(400);
      expect(response.body.message).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════
  // Task 4: Status Update E2E Tests
  // ══════════════════════════════════════════════
  describe("PUT /v1/admin/reconciliation/discrepancies/:id/status", () => {
    it("should update open discrepancy to investigating", async () => {
      const path = `/v1/admin/reconciliation/discrepancies/${statusDisc1Id}/status`;
      const body = { status: "investigating" };
      const headers = financeHeaders("PUT", path, body);
      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(200);

      expect(response.body).toMatchObject({
        id: statusDisc1Id,
        disputeStatus: "investigating",
        reconciliationRunId: run2Id,
        type: "missing_stripe",
        internalReferenceId: "int-ref-020",
        expectedAmountCents: 2000,
        actualAmountCents: 1500,
        differenceCents: 500,
      });
    });

    it("should update discrepancy to dismissed", async () => {
      const path = `/v1/admin/reconciliation/discrepancies/${statusDisc2Id}/status`;
      const body = { status: "dismissed" };
      const headers = financeHeaders("PUT", path, body);
      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(200);

      expect(response.body).toMatchObject({
        id: statusDisc2Id,
        disputeStatus: "dismissed",
      });
    });

    it("should return response with all DiscrepancySearchResponseDto fields", async () => {
      const path = `/v1/admin/reconciliation/discrepancies/${statusDisc1Id}/status`;
      const body = { status: "open" };
      const headers = financeHeaders("PUT", path, body);
      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(200);

      const disc = response.body;
      expect(disc.id).toBe(statusDisc1Id);
      expect(disc.reconciliationRunId).toBe(run2Id);
      expect(disc.type).toBe("missing_stripe");
      expect(disc.disputeStatus).toBe("open");
      expect(disc.periodStart).not.toBeNull();
      expect(disc.periodEnd).not.toBeNull();
      expect(disc.createdAt).toBeDefined();
    });

    it("should persist status change (verify via GET)", async () => {
      // First update to investigating
      const updatePath = `/v1/admin/reconciliation/discrepancies/${statusDisc1Id}/status`;
      const updateBody = { status: "investigating" };
      const updateHeaders = financeHeaders("PUT", updatePath, updateBody);
      await request(app.getHttpServer())
        .put(updatePath)
        .set(updateHeaders)
        .send(updateBody)
        .expect(200);

      // Verify via search
      const searchPath = "/v1/admin/reconciliation/discrepancies";
      const searchHeaders = financeHeaders("GET", searchPath);
      const searchResponse = await request(app.getHttpServer())
        .get(searchPath)
        .query({ disputeStatus: "investigating" })
        .set(searchHeaders)
        .expect(200);

      const found = searchResponse.body.data.find(
        (d: { id: string }) => d.id === statusDisc1Id,
      );
      expect(found).toBeDefined();
      expect(found.disputeStatus).toBe("investigating");
    });

    it("should return 404 for non-existent UUID", async () => {
      const path = `/v1/admin/reconciliation/discrepancies/${NON_EXISTENT_UUID}/status`;
      const body = { status: "investigating" };
      const headers = financeHeaders("PUT", path, body);
      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(404);

      expect(response.body).toMatchObject({
        statusCode: 404,
        message: `Discrepancy ${NON_EXISTENT_UUID} not found`,
      });
    });

    it("should return 400 for invalid status value", async () => {
      const path = `/v1/admin/reconciliation/discrepancies/${statusDisc1Id}/status`;
      const body = { status: "invalid_status" };
      const headers = financeHeaders("PUT", path, body);
      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(400);

      expect(response.body.statusCode).toBe(400);
      expect(response.body.message).toBeDefined();
    });

    it("should return 400 for missing status field in body", async () => {
      const path = `/v1/admin/reconciliation/discrepancies/${statusDisc1Id}/status`;
      const emptyBody = {} as Record<string, unknown>;
      const headers = financeHeaders("PUT", path, emptyBody);
      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(emptyBody)
        .expect(400);

      expect(response.body.statusCode).toBe(400);
    });
  });

  // ══════════════════════════════════════════════
  // Task 5: Resolve Discrepancy E2E Tests
  // ══════════════════════════════════════════════
  describe("PUT /v1/admin/reconciliation/discrepancies/:id/resolve", () => {
    it("should execute full workflow: tag investigating -> resolve with notes", async () => {
      // Step 1: Tag as investigating
      const statusPath = `/v1/admin/reconciliation/discrepancies/${resolveDisc1Id}/status`;
      const statusBody = { status: "investigating" };
      const statusHeaders = financeHeaders("PUT", statusPath, statusBody);
      const statusResponse = await request(app.getHttpServer())
        .put(statusPath)
        .set(statusHeaders)
        .send(statusBody)
        .expect(200);

      expect(statusResponse.body.disputeStatus).toBe("investigating");

      // Step 2: Resolve with notes
      const resolvePath = `/v1/admin/reconciliation/discrepancies/${resolveDisc1Id}/resolve`;
      const resolveBody = {
        resolutionNotes: "Verified with bank statement — transaction confirmed",
      };
      const resolveHeaders = financeHeaders("PUT", resolvePath, resolveBody);
      const resolveResponse = await request(app.getHttpServer())
        .put(resolvePath)
        .set(resolveHeaders)
        .send(resolveBody)
        .expect(200);

      expect(resolveResponse.body).toMatchObject({
        id: resolveDisc1Id,
        disputeStatus: "resolved",
        resolvedBy: "finance-user-1",
        resolutionNotes: "Verified with bank statement — transaction confirmed",
      });
      expect(resolveResponse.body.resolvedAt).not.toBeNull();
      // Verify resolvedAt is an ISO timestamp
      const resolvedAt = resolveResponse.body.resolvedAt as string;
      expect(new Date(resolvedAt).toISOString()).toBe(resolvedAt);
    });

    it("should verify resolved discrepancy has all fields populated", async () => {
      // resolveDisc1Id was resolved in previous test — verify via search
      const searchPath = "/v1/admin/reconciliation/discrepancies";
      const headers = financeHeaders("GET", searchPath);
      const response = await request(app.getHttpServer())
        .get(searchPath)
        .query({ disputeStatus: "resolved" })
        .set(headers)
        .expect(200);

      const resolved = response.body.data.find(
        (d: { id: string }) => d.id === resolveDisc1Id,
      );
      expect(resolved).toBeDefined();
      expect(resolved.disputeStatus).toBe("resolved");
      expect(resolved.resolvedBy).toBe("finance-user-1");
      expect(resolved.resolutionNotes).toBe(
        "Verified with bank statement — transaction confirmed",
      );
      expect(resolved.resolvedAt).not.toBeNull();
    });

    it("should return 409 Conflict for already-resolved discrepancy", async () => {
      const path = `/v1/admin/reconciliation/discrepancies/${conflictDisc1Id}/resolve`;
      const body = { resolutionNotes: "Trying to re-resolve" };
      const headers = financeHeaders("PUT", path, body);
      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(409);

      expect(response.body).toMatchObject({
        statusCode: 409,
        message: `Discrepancy ${conflictDisc1Id} is already resolved`,
      });
    });

    it("should return 404 for non-existent UUID", async () => {
      const path = `/v1/admin/reconciliation/discrepancies/${NON_EXISTENT_UUID}/resolve`;
      const body = { resolutionNotes: "Test resolution" };
      const headers = financeHeaders("PUT", path, body);
      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(404);

      expect(response.body).toMatchObject({
        statusCode: 404,
        message: `Discrepancy ${NON_EXISTENT_UUID} not found`,
      });
    });

    it("should return 400 for empty resolutionNotes", async () => {
      // Use statusDisc2Id which is not resolved
      const path = `/v1/admin/reconciliation/discrepancies/${statusDisc2Id}/resolve`;
      const body = { resolutionNotes: "" };
      const headers = financeHeaders("PUT", path, body);
      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(400);

      expect(response.body.statusCode).toBe(400);
      expect(response.body.message).toBeDefined();
    });

    it("should return 400 for resolutionNotes exceeding 2000 chars", async () => {
      const path = `/v1/admin/reconciliation/discrepancies/${statusDisc2Id}/resolve`;
      const body = { resolutionNotes: "x".repeat(2001) };
      const headers = financeHeaders("PUT", path, body);
      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(400);

      expect(response.body.statusCode).toBe(400);
      expect(response.body.message).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════
  // Task 6: Export E2E Tests
  // ══════════════════════════════════════════════
  describe("GET /v1/admin/reconciliation/export", () => {
    const exportPath = "/v1/admin/reconciliation/export";

    it("should export discrepancies in date range with correct summary", async () => {
      const headers = financeHeaders("GET", exportPath);
      const response = await request(app.getHttpServer())
        .get(exportPath)
        .query({
          dateFrom: "2020-01-01T00:00:00.000Z",
          dateTo: "2030-01-01T00:00:00.000Z",
        })
        .set(headers)
        .expect(200);

      // All 10 discrepancies should appear
      expect(response.body.discrepancies).toHaveLength(10);
      expect(response.body.summary.totalDiscrepancies).toBe(10);
      expect(response.body.exportDate).toBeDefined();
      expect(response.body.dateRange).toEqual({
        from: "2020-01-01T00:00:00.000Z",
        to: "2030-01-01T00:00:00.000Z",
      });
      // Exact byStatus counts after mutations in Tasks 4-5
      expect(response.body.summary.byStatus).toEqual({
        open: 3,
        investigating: 2,
        resolved: 4,
        dismissed: 1,
      });
      // Sum of |differenceCents| for all 10: 500+1000+200+500+300+500+500+400+600+400
      expect(response.body.summary.totalDifferenceCents).toBe(4900);
    });

    it("should export run1 discrepancies with exact AC3 byStatus counts (NFR42)", async () => {
      const headers = financeHeaders("GET", exportPath);
      const response = await request(app.getHttpServer())
        .get(exportPath)
        .query({
          dateFrom: "2026-01-01T00:00:00.000Z",
          dateTo: "2026-02-01T00:00:00.000Z",
        })
        .set(headers)
        .expect(200);

      // Run1 has 5 discrepancies: 2 open, 3 resolved (AC3)
      expect(response.body.discrepancies).toHaveLength(5);
      expect(response.body.summary.totalDiscrepancies).toBe(5);
      expect(response.body.summary.byStatus).toEqual({
        open: 2,
        investigating: 0,
        resolved: 3,
        dismissed: 0,
      });
      // totalDifferenceCents: |500| + |1000| + |500| + |400| + |600| = 3000
      expect(response.body.summary.totalDifferenceCents).toBe(3000);
      expect(response.body.dateRange).toEqual({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
      });
    });

    it("should return correct export response shape with all fields", async () => {
      const headers = financeHeaders("GET", exportPath);
      const response = await request(app.getHttpServer())
        .get(exportPath)
        .query({
          dateFrom: "2020-01-01T00:00:00.000Z",
          dateTo: "2030-01-01T00:00:00.000Z",
        })
        .set(headers)
        .expect(200);

      expect(response.body).toMatchObject({
        exportDate: expect.any(String),
        dateRange: {
          from: "2020-01-01T00:00:00.000Z",
          to: "2030-01-01T00:00:00.000Z",
        },
        summary: {
          totalDiscrepancies: expect.any(Number),
          byStatus: expect.objectContaining({
            open: expect.any(Number),
            investigating: expect.any(Number),
            resolved: expect.any(Number),
            dismissed: expect.any(Number),
          }),
          totalDifferenceCents: expect.any(Number),
        },
        discrepancies: expect.any(Array),
      });

      // Verify all 4 byStatus keys always exist
      expect(response.body.summary.byStatus).toHaveProperty("open");
      expect(response.body.summary.byStatus).toHaveProperty("investigating");
      expect(response.body.summary.byStatus).toHaveProperty("resolved");
      expect(response.body.summary.byStatus).toHaveProperty("dismissed");
    });

    it("should hydrate periodStart/periodEnd in export discrepancies", async () => {
      const headers = financeHeaders("GET", exportPath);
      const response = await request(app.getHttpServer())
        .get(exportPath)
        .query({
          dateFrom: "2020-01-01T00:00:00.000Z",
          dateTo: "2030-01-01T00:00:00.000Z",
        })
        .set(headers)
        .expect(200);

      // All discrepancies should have hydrated period from their run
      for (const disc of response.body.discrepancies) {
        expect(disc.periodStart).not.toBeNull();
        expect(disc.periodEnd).not.toBeNull();
      }
    });

    it("should return empty export for date range with no discrepancies", async () => {
      const headers = financeHeaders("GET", exportPath);
      const response = await request(app.getHttpServer())
        .get(exportPath)
        .query({
          dateFrom: "2099-01-01T00:00:00.000Z",
          dateTo: "2099-02-01T00:00:00.000Z",
        })
        .set(headers)
        .expect(200);

      expect(response.body).toMatchObject({
        exportDate: expect.any(String),
        dateRange: {
          from: "2099-01-01T00:00:00.000Z",
          to: "2099-02-01T00:00:00.000Z",
        },
        summary: {
          totalDiscrepancies: 0,
          byStatus: { open: 0, investigating: 0, resolved: 0, dismissed: 0 },
          totalDifferenceCents: 0,
        },
        discrepancies: [],
      });
    });

    it("should return 400 for missing dateFrom", async () => {
      const headers = financeHeaders("GET", exportPath);
      const response = await request(app.getHttpServer())
        .get(exportPath)
        .query({ dateTo: "2026-03-01T00:00:00.000Z" })
        .set(headers)
        .expect(400);

      expect(response.body.statusCode).toBe(400);
      expect(response.body.message).toBeDefined();
    });

    it("should return 400 for missing dateTo", async () => {
      const headers = financeHeaders("GET", exportPath);
      const response = await request(app.getHttpServer())
        .get(exportPath)
        .query({ dateFrom: "2026-01-01T00:00:00.000Z" })
        .set(headers)
        .expect(400);

      expect(response.body.statusCode).toBe(400);
      expect(response.body.message).toBeDefined();
    });

    it("should return 400 for invalid date format", async () => {
      const headers = financeHeaders("GET", exportPath);
      const response = await request(app.getHttpServer())
        .get(exportPath)
        .query({ dateFrom: "not-a-date", dateTo: "also-not-a-date" })
        .set(headers)
        .expect(400);

      expect(response.body.statusCode).toBe(400);
      expect(response.body.message).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════
  // Task 7: Role Enforcement E2E Tests
  // ══════════════════════════════════════════════
  describe("Role Enforcement", () => {
    const endpoints = [
      {
        method: "GET" as const,
        path: "/v1/admin/reconciliation/discrepancies",
      },
      {
        method: "PUT" as const,
        path: `/v1/admin/reconciliation/discrepancies/${roleTestDiscId}/status`,
        body: { status: "open" },
      },
      {
        method: "PUT" as const,
        path: `/v1/admin/reconciliation/discrepancies/${roleTestDiscId}/resolve`,
        body: { resolutionNotes: "role test" },
      },
      {
        method: "GET" as const,
        path: "/v1/admin/reconciliation/export",
        query: {
          dateFrom: "2026-01-01T00:00:00.000Z",
          dateTo: "2026-03-01T00:00:00.000Z",
        },
      },
    ];

    it("should return 200 for finance role on all 4 endpoints", async () => {
      for (const endpoint of endpoints) {
        const headers = signRequest(
          endpoint.method,
          endpoint.path,
          endpoint.body,
          {
            adminRole: "finance",
            adminUserId: "finance-user-1",
          },
        );

        const req =
          endpoint.method === "GET"
            ? request(app.getHttpServer()).get(endpoint.path)
            : request(app.getHttpServer()).put(endpoint.path);

        let chain = req.set(headers);
        if ("query" in endpoint && endpoint.query) {
          chain = chain.query(endpoint.query);
        }
        if (endpoint.body) {
          chain = chain.send(endpoint.body);
        }

        const response = await chain;
        expect(response.status).toBe(200);
      }
    });

    it("should return 200 for admin role on all 4 endpoints", async () => {
      for (const endpoint of endpoints) {
        const headers = signRequest(
          endpoint.method,
          endpoint.path,
          endpoint.body,
          {
            adminRole: "admin",
            adminUserId: "admin-user-1",
          },
        );

        const req =
          endpoint.method === "GET"
            ? request(app.getHttpServer()).get(endpoint.path)
            : request(app.getHttpServer()).put(endpoint.path);

        let chain = req.set(headers);
        if ("query" in endpoint && endpoint.query) {
          chain = chain.query(endpoint.query);
        }
        if (endpoint.body) {
          chain = chain.send(endpoint.body);
        }

        const response = await chain;
        expect(response.status).toBe(200);
      }
    });

    it("should return 403 for cs role on all 4 endpoints", async () => {
      for (const endpoint of endpoints) {
        const headers = signRequest(
          endpoint.method,
          endpoint.path,
          endpoint.body,
          {
            adminRole: "cs",
            adminUserId: "cs-user-1",
          },
        );

        const req =
          endpoint.method === "GET"
            ? request(app.getHttpServer()).get(endpoint.path)
            : request(app.getHttpServer()).put(endpoint.path);

        let chain = req.set(headers);
        if ("query" in endpoint && endpoint.query) {
          chain = chain.query(endpoint.query);
        }
        if (endpoint.body) {
          chain = chain.send(endpoint.body);
        }

        const response = await chain;
        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({
          statusCode: 403,
          message: "Forbidden resource",
        });
      }
    });

    it("should return 403 for missing role header on all 4 endpoints", async () => {
      for (const endpoint of endpoints) {
        const headers = signRequest(
          endpoint.method,
          endpoint.path,
          endpoint.body,
        );

        const req =
          endpoint.method === "GET"
            ? request(app.getHttpServer()).get(endpoint.path)
            : request(app.getHttpServer()).put(endpoint.path);

        let chain = req.set(headers);
        if ("query" in endpoint && endpoint.query) {
          chain = chain.query(endpoint.query);
        }
        if (endpoint.body) {
          chain = chain.send(endpoint.body);
        }

        const response = await chain;
        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({
          statusCode: 403,
          message: "Forbidden resource",
        });
      }
    });

    it("should return 401 when no HMAC signature is provided", async () => {
      for (const endpoint of endpoints) {
        const req =
          endpoint.method === "GET"
            ? request(app.getHttpServer()).get(endpoint.path)
            : request(app.getHttpServer()).put(endpoint.path);

        let chain = req;
        if ("query" in endpoint && endpoint.query) {
          chain = chain.query(endpoint.query);
        }
        if (endpoint.body) {
          chain = chain.send(endpoint.body);
        }

        const response = await chain;
        expect(response.status).toBe(401);
        expect(response.body).toMatchObject({
          statusCode: 401,
          message: "Unauthorized",
        });
      }
    });
  });

  // ══════════════════════════════════════════════
  // Task 8: Audit Trail Verification
  // ══════════════════════════════════════════════
  describe("Audit Trail", () => {
    it("should create audit trail entry for PUT /status mutation", async () => {
      // Perform a status update
      const path = `/v1/admin/reconciliation/discrepancies/${statusDisc1Id}/status`;
      const body = { status: "open" };
      const headers = financeHeaders("PUT", path, body);
      await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(200);

      // Wait briefly for fire-and-forget audit write
      await new Promise((resolve) => setTimeout(resolve, 200));

      const auditRecords = await getAuditTrailRecords();
      // Audit trail stores action as "METHOD path"
      const statusAudit = auditRecords.find(
        (r) =>
          (r.action as string).includes("PUT") &&
          (r.action as string).includes(`${statusDisc1Id}/status`),
      );
      expect(statusAudit).toBeDefined();
      expect(statusAudit!.admin_user_id).toBe("finance-user-1");
    });

    it("should create audit trail entry for PUT /resolve mutation", async () => {
      // Wait briefly for fire-and-forget audit write
      await new Promise((resolve) => setTimeout(resolve, 200));

      const auditRecords = await getAuditTrailRecords();
      // resolveDisc1Id was resolved earlier in the workflow test
      const resolveAudit = auditRecords.find(
        (r) =>
          (r.action as string).includes("PUT") &&
          (r.action as string).includes(`${resolveDisc1Id}/resolve`),
      );
      expect(resolveAudit).toBeDefined();
      expect(resolveAudit!.admin_user_id).toBe("finance-user-1");
    });
  });
});
