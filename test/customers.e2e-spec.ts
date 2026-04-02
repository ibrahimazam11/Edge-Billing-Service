import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { App } from "supertest/types";
import { createTestApp } from "./helpers/test-app";
import { signRequest } from "./helpers/hmac-signer";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  seedCustomer,
} from "./helpers/database";

describe("Customers API (e2e)", () => {
  let app: INestApplication<App>;

  const CUSTOMER_1 = {
    id: "a0000000-0000-0000-0000-000000000001",
    monolithCustomerId: "mono-cust-001",
    stripeCustomerId: "cus_test_001",
    name: "Alice Smith",
    email: "alice@example.com",
  };

  const CUSTOMER_2 = {
    id: "a0000000-0000-0000-0000-000000000002",
    monolithCustomerId: "mono-cust-002",
    stripeCustomerId: "cus_test_002",
    name: "Bob Jones",
    email: "bob@example.com",
    status: "inactive",
  };

  beforeAll(async () => {
    await setupTestDatabase();
    app = await createTestApp();
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedCustomer(CUSTOMER_1);
    await seedCustomer(CUSTOMER_2);
  });

  describe("HMAC Authentication", () => {
    it("should reject requests without auth headers", async () => {
      await request(app.getHttpServer()).get("/v1/customers").expect(401);
    });

    it("should reject requests with invalid API key", async () => {
      const headers = signRequest("GET", "/v1/customers", undefined, {
        apiKey: "wrong-key",
      });

      await request(app.getHttpServer())
        .get("/v1/customers")
        .set(headers)
        .expect(401);
    });

    it("should reject requests with invalid signature", async () => {
      await request(app.getHttpServer())
        .get("/v1/customers")
        .set("x-api-key", "test-api-key")
        .set("x-signature", "invalid-hex-signature")
        .set("x-timestamp", Date.now().toString())
        .expect(401);
    });
  });

  describe("GET /v1/customers", () => {
    it("should return paginated customer list", async () => {
      const headers = signRequest("GET", "/v1/customers");

      const response = await request(app.getHttpServer())
        .get("/v1/customers")
        .set(headers)
        .expect(200);

      expect(response.body).toHaveProperty("data");
      expect(response.body).toHaveProperty("hasMore");
      expect(response.body).toHaveProperty("cursor");
      expect(response.body.data).toHaveLength(2);
    });

    it("should filter by status", async () => {
      const headers = signRequest("GET", "/v1/customers");

      const response = await request(app.getHttpServer())
        .get("/v1/customers?status=active")
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].name).toBe("Alice Smith");
    });

    it("should support pagination with limit", async () => {
      const headers = signRequest("GET", "/v1/customers");

      const response = await request(app.getHttpServer())
        .get("/v1/customers?limit=1")
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.hasMore).toBe(true);
      expect(response.body.cursor).toBeTruthy();
    });

    it("should support cursor-based pagination", async () => {
      const headers = signRequest("GET", "/v1/customers");

      // Get first page
      const page1 = await request(app.getHttpServer())
        .get("/v1/customers?limit=1")
        .set(headers)
        .expect(200);

      // Get second page using cursor
      const cursor = page1.body.cursor as string;
      const page2 = await request(app.getHttpServer())
        .get(`/v1/customers?limit=1&cursor=${cursor}`)
        .set(headers)
        .expect(200);

      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    });
  });

  describe("GET /v1/customers/:id", () => {
    it("should return a customer by id", async () => {
      const path = `/v1/customers/${CUSTOMER_1.id}`;
      const headers = signRequest("GET", path);

      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(200);

      expect(response.body).toMatchObject({
        id: CUSTOMER_1.id,
        monolithCustomerId: CUSTOMER_1.monolithCustomerId,
        stripeCustomerId: CUSTOMER_1.stripeCustomerId,
        name: CUSTOMER_1.name,
        email: CUSTOMER_1.email,
        status: "active",
      });
      expect(response.body.createdAt).toBeDefined();
      expect(response.body.updatedAt).toBeDefined();
    });

    it("should return 404 for non-existent customer", async () => {
      const fakeId = "f0000000-0000-0000-0000-000000000099";
      const path = `/v1/customers/${fakeId}`;
      const headers = signRequest("GET", path);

      await request(app.getHttpServer()).get(path).set(headers).expect(404);
    });
  });
});
