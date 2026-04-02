import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { App } from "supertest/types";
import { createTestApp } from "./helpers/test-app";
import { signRequest } from "./helpers/hmac-signer";
import { sql } from "drizzle-orm";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  seedCustomer,
  getAuditTrailRecords,
  getTestDatabase,
} from "./helpers/database";

describe("Admin Module (e2e)", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    await setupTestDatabase();
    app = await createTestApp();
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
    await closeDatabase();
  });

  // ──────────────────────────────────────────────
  // Task 4: Admin role enforcement E2E tests
  // ──────────────────────────────────────────────

  describe("GET /v1/admin/info (admin-only)", () => {
    // AC2 + AC9: Admin role → 200 with body content verification
    it("should return 200 with module info when admin role is provided", async () => {
      const headers = signRequest("GET", "/v1/admin/info", undefined, {
        adminRole: "admin",
        adminUserId: "admin-user-123",
      });

      const response = await request(app.getHttpServer())
        .get("/v1/admin/info")
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        module: "admin",
        status: "active",
        timestamp: expect.any(String) as string,
      });
    });

    // AC3 + AC9: Wrong role (cs) → 403 with body verification
    it("should return 403 when cs role is provided", async () => {
      const headers = signRequest("GET", "/v1/admin/info", undefined, {
        adminRole: "cs",
        adminUserId: "cs-user-1",
      });

      const response = await request(app.getHttpServer())
        .get("/v1/admin/info")
        .set(headers)
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
        message: "Forbidden resource",
      });
    });

    // AC3 additive: Wrong role (finance) → 403
    it("should return 403 when finance role is provided", async () => {
      const headers = signRequest("GET", "/v1/admin/info", undefined, {
        adminRole: "finance",
        adminUserId: "finance-user-1",
      });

      const response = await request(app.getHttpServer())
        .get("/v1/admin/info")
        .set(headers)
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
        message: "Forbidden resource",
      });
    });

    // AC4: Missing role header → 403
    it("should return 403 when no admin role header is provided", async () => {
      const headers = signRequest("GET", "/v1/admin/info");

      const response = await request(app.getHttpServer())
        .get("/v1/admin/info")
        .set(headers)
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
        message: "Forbidden resource",
      });
    });

    // AC4 additive: Invalid role → 403
    it("should return 403 when invalid role (superuser) is provided", async () => {
      const headers = signRequest("GET", "/v1/admin/info", undefined, {
        adminRole: "superuser",
      });

      const response = await request(app.getHttpServer())
        .get("/v1/admin/info")
        .set(headers)
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
      });
    });
  });

  describe("GET /v1/admin/whoami (multi-role)", () => {
    // AC5 + AC9: Admin role → 200 with role and userId in body
    it("should return 200 with admin role and userId", async () => {
      const headers = signRequest("GET", "/v1/admin/whoami", undefined, {
        adminRole: "admin",
        adminUserId: "admin-user-456",
      });

      const response = await request(app.getHttpServer())
        .get("/v1/admin/whoami")
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        adminRole: "admin",
        adminUserId: "admin-user-456",
      });
    });

    // AC5 + AC9: CS role → 200 with cs role reflected
    it("should return 200 with cs role", async () => {
      const headers = signRequest("GET", "/v1/admin/whoami", undefined, {
        adminRole: "cs",
        adminUserId: "cs-user-789",
      });

      const response = await request(app.getHttpServer())
        .get("/v1/admin/whoami")
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        adminRole: "cs",
        adminUserId: "cs-user-789",
      });
    });

    // AC5 + AC9: Finance role → 200 with finance role reflected
    it("should return 200 with finance role", async () => {
      const headers = signRequest("GET", "/v1/admin/whoami", undefined, {
        adminRole: "finance",
        adminUserId: "finance-user-321",
      });

      const response = await request(app.getHttpServer())
        .get("/v1/admin/whoami")
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        adminRole: "finance",
        adminUserId: "finance-user-321",
      });
    });

    // AC5 + AC9: CS role without adminUserId → 200 with adminUserId: null
    it("should return 200 with adminUserId null when no adminUserId header is provided", async () => {
      const headers = signRequest("GET", "/v1/admin/whoami", undefined, {
        adminRole: "cs",
      });

      const response = await request(app.getHttpServer())
        .get("/v1/admin/whoami")
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        adminRole: "cs",
        adminUserId: null,
      });
    });

    // AC6: Missing role header → 403
    it("should return 403 when no admin role header is provided", async () => {
      const headers = signRequest("GET", "/v1/admin/whoami");

      const response = await request(app.getHttpServer())
        .get("/v1/admin/whoami")
        .set(headers)
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
        message: "Forbidden resource",
      });
    });
  });

  // ──────────────────────────────────────────────
  // Task 5: Backward compatibility E2E tests
  // ──────────────────────────────────────────────

  describe("Backward Compatibility", () => {
    beforeAll(async () => {
      await seedCustomer({
        id: "c0000000-0000-4000-a000-000000000001",
        monolithCustomerId: "mono-compat-1",
        name: "Backward Compat Customer",
        email: "compat@example.com",
      });
    });

    // AC7 + AC9: Existing MVP endpoint without admin headers → 200 with data array
    it("GET /v1/customers with valid HMAC and no admin headers should return 200 with data array", async () => {
      const headers = signRequest("GET", "/v1/customers");

      const response = await request(app.getHttpServer())
        .get("/v1/customers")
        .set(headers)
        .expect(200);

      expect(response.body).toHaveProperty("data");
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    // AC7: Existing MVP endpoint with admin role header → 200 (unaffected)
    it("GET /v1/customers with valid HMAC and admin role header should return 200", async () => {
      const headers = signRequest("GET", "/v1/customers", undefined, {
        adminRole: "admin",
        adminUserId: "admin-1",
      });

      const response = await request(app.getHttpServer())
        .get("/v1/customers")
        .set(headers)
        .expect(200);

      expect(response.body).toHaveProperty("data");
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    // AC7: Public endpoint (health) → 200 without any auth
    it("GET /health should return 200 without any auth (sanity check)", async () => {
      const response = await request(app.getHttpServer())
        .get("/health")
        .expect(200);

      expect(response.body).toHaveProperty("status", "ok");
    });
  });

  // ──────────────────────────────────────────────
  // Task 6: HMAC auth on admin endpoints
  // ──────────────────────────────────────────────

  describe("HMAC auth on admin endpoints", () => {
    // AC8: No auth headers → 401 (HMAC guard rejects first)
    it("should return 401 when no auth headers are provided", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/admin/info")
        .expect(401);

      expect(response.body).toMatchObject({
        statusCode: 401,
        message: "Unauthorized",
      });
    });

    // AC8: Invalid HMAC signature → 401
    it("should return 401 when invalid HMAC signature is provided", async () => {
      const headers = signRequest("GET", "/v1/admin/info", undefined, {
        adminRole: "admin",
        hmacSecret: "wrong-secret",
      });

      const response = await request(app.getHttpServer())
        .get("/v1/admin/info")
        .set(headers)
        .expect(401);

      expect(response.body).toMatchObject({
        statusCode: 401,
        message: "Unauthorized",
      });
    });
  });

  // ──────────────────────────────────────────────
  // Story 8.3: Audit Trail E2E tests
  // ──────────────────────────────────────────────

  describe("Audit Trail", () => {
    // Fire-and-forget audit writes complete asynchronously after the HTTP response;
    // this delay allows the DB INSERT to flush before assertions.
    const AUDIT_FLUSH_MS = 500;

    // AC3 + AC9: POST admin endpoint → audit record created with correct fields
    it("should create an audit record for a successful admin POST", async () => {
      const body = { message: "hello audit" };
      const headers = signRequest("POST", "/v1/admin/echo", body, {
        adminRole: "admin",
        adminUserId: "audit-admin-1",
      });

      const response = await request(app.getHttpServer())
        .post("/v1/admin/echo")
        .set(headers)
        .send(body)
        .expect(201);

      expect(response.body).toEqual({
        id: "echo-response",
        received: true,
        body: { message: "hello audit" },
      });

      // Allow fire-and-forget audit write to complete
      await new Promise((resolve) => setTimeout(resolve, AUDIT_FLUSH_MS));

      const records = await getAuditTrailRecords();
      expect(records.length).toBeGreaterThanOrEqual(1);

      const latestRecord = records[0];
      expect(latestRecord).toMatchObject({
        admin_user_id: "audit-admin-1",
        action: "POST /v1/admin/echo",
        entity_type: "echo",
        entity_id: "echo-response",
      });
      expect(latestRecord.details).toEqual({ message: "hello audit" });
      expect(latestRecord.id).toBeDefined();
      expect(latestRecord.created_at).toBeDefined();
    });

    // AC7 + AC9: Verify adminUserId, action, entityType, entityId, details field values
    it("should capture correct audit field values", async () => {
      const body = { amount: 5000, reason: "test-refund" };
      const headers = signRequest("POST", "/v1/admin/echo", body, {
        adminRole: "admin",
        adminUserId: "audit-admin-fields",
      });

      await request(app.getHttpServer())
        .post("/v1/admin/echo")
        .set(headers)
        .send(body)
        .expect(201);

      await new Promise((resolve) => setTimeout(resolve, AUDIT_FLUSH_MS));

      const records = await getAuditTrailRecords();
      const record = records.find(
        (r) => r.admin_user_id === "audit-admin-fields",
      );
      expect(record).toBeDefined();
      expect(record!.action).toBe("POST /v1/admin/echo");
      expect(record!.entity_type).toBe("echo");
      expect(record!.entity_id).toBe("echo-response");
      expect(record!.details).toEqual({
        amount: 5000,
        reason: "test-refund",
      });
    });

    // AC4 + AC9: GET admin endpoint → NO audit record
    it("should NOT create an audit record for admin GET requests", async () => {
      // Clear existing records first
      const db = getTestDatabase();
      await db.execute(sql`TRUNCATE "audit_trail" CASCADE`);

      const headers = signRequest("GET", "/v1/admin/info", undefined, {
        adminRole: "admin",
        adminUserId: "audit-admin-get",
      });

      await request(app.getHttpServer())
        .get("/v1/admin/info")
        .set(headers)
        .expect(200);

      await new Promise((resolve) => setTimeout(resolve, AUDIT_FLUSH_MS));

      const records = await getAuditTrailRecords();
      expect(records.length).toBe(0);
    });

    // AC5 + AC9: Failed admin write → NO audit record
    it("should NOT create an audit record for failed admin operations", async () => {
      // Clear existing records
      const db = getTestDatabase();
      await db.execute(sql`TRUNCATE "audit_trail" CASCADE`);

      // POST to echo with wrong role → 403 (failed operation)
      const body = { data: "should-not-audit" };
      const headers = signRequest("POST", "/v1/admin/echo", body, {
        adminRole: "cs",
        adminUserId: "audit-admin-fail",
      });

      await request(app.getHttpServer())
        .post("/v1/admin/echo")
        .set(headers)
        .send(body)
        .expect(403);

      await new Promise((resolve) => setTimeout(resolve, AUDIT_FLUSH_MS));

      const records = await getAuditTrailRecords();
      expect(records.length).toBe(0);
    });

    // AC2 + AC8: MVP endpoints unaffected — no audit record for non-admin routes
    it("should NOT create audit records for non-admin routes", async () => {
      const db = getTestDatabase();
      await db.execute(sql`TRUNCATE "audit_trail" CASCADE`);

      const headers = signRequest("GET", "/v1/customers");

      await request(app.getHttpServer())
        .get("/v1/customers")
        .set(headers)
        .expect(200);

      await new Promise((resolve) => setTimeout(resolve, AUDIT_FLUSH_MS));

      const records = await getAuditTrailRecords();
      expect(records.length).toBe(0);
    });
  });
});
