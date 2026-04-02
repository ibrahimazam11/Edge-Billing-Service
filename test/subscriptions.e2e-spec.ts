import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { App } from "supertest/types";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers/test-app";
import { signRequest } from "./helpers/hmac-signer";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  seedCustomer,
  seedPaymentMethod,
  seedSubscription,
  getTestDatabase,
} from "./helpers/database";
import * as schema from "../src/database/schema";
import { SubscriptionsService } from "../src/subscriptions/subscriptions.service";

describe("Subscriptions API (e2e)", () => {
  let app: INestApplication<App>;

  const CUSTOMER_1 = {
    id: "b0000000-0000-4000-a000-000000000001",
    monolithCustomerId: "mono-sub-001",
    stripeCustomerId: "cus_sub_001",
    name: "Sub Customer",
    email: "sub@example.com",
  };

  const PAYMENT_METHOD_1 = {
    id: "c0000000-0000-4000-a000-000000000001",
    customerId: CUSTOMER_1.id,
    stripePaymentMethodId: "pm_sub_001",
    type: "card",
    isDefault: true,
    lastFour: "4242",
    brand: "visa",
  };

  const SUBSCRIPTION_1 = {
    id: "d0000000-0000-4000-a000-000000000001",
    customerId: CUSTOMER_1.id,
    planName: "standard-monthly",
    amountCents: 5000,
    billingPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
    billingPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
    nextBillingDate: new Date("2026-04-01T00:00:00.000Z"),
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
    await seedPaymentMethod(PAYMENT_METHOD_1);
  });

  describe("POST /v1/subscriptions", () => {
    it("should create a subscription (201)", async () => {
      const body = {
        customerId: CUSTOMER_1.id,
        planName: "standard-monthly",
        amountCents: 5000,
        billingStartDate: "2026-03-01T00:00:00.000Z",
      };
      const headers = signRequest("POST", "/v1/subscriptions", body);

      const response = await request(app.getHttpServer())
        .post("/v1/subscriptions")
        .set(headers)
        .send(body)
        .expect(201);

      expect(response.body).toMatchObject({
        customerId: CUSTOMER_1.id,
        planName: "standard-monthly",
        status: "pending",
        amountCents: 5000,
        currency: "usd",
        billingInterval: "monthly",
      });
      expect(response.body.id).toBeDefined();
      expect(response.body.billingPeriodStart).toBe("2026-03-01T00:00:00.000Z");
      expect(response.body.billingPeriodEnd).toBe("2026-04-01T00:00:00.000Z");
      expect(response.body.nextBillingDate).toBe("2026-04-01T00:00:00.000Z");
      expect(response.body.createdAt).toBeDefined();
      expect(response.body.updatedAt).toBeDefined();
    });

    it("should return 404 when customer does not exist", async () => {
      const fakeCustomerId = "f0000000-0000-4000-a000-000000000099";
      const body = {
        customerId: fakeCustomerId,
        planName: "standard-monthly",
        amountCents: 5000,
        billingStartDate: "2026-03-01T00:00:00.000Z",
      };
      const headers = signRequest("POST", "/v1/subscriptions", body);

      await request(app.getHttpServer())
        .post("/v1/subscriptions")
        .set(headers)
        .send(body)
        .expect(404);
    });

    it("should return 422 when customer has no payment methods", async () => {
      const custNoPayment = {
        id: "b0000000-0000-4000-a000-000000000099",
        monolithCustomerId: "mono-sub-099",
        stripeCustomerId: "cus_sub_099",
        name: "No Payment Customer",
        email: "nopay@example.com",
      };
      await seedCustomer(custNoPayment);

      const body = {
        customerId: custNoPayment.id,
        planName: "standard-monthly",
        amountCents: 5000,
        billingStartDate: "2026-03-01T00:00:00.000Z",
      };
      const headers = signRequest("POST", "/v1/subscriptions", body);

      const response = await request(app.getHttpServer())
        .post("/v1/subscriptions")
        .set(headers)
        .send(body)
        .expect(422);

      expect(response.body.details).toMatchObject({
        errorCode: "CUSTOMER_NO_PAYMENT_METHOD",
      });
    });
  });

  describe("GET /v1/subscriptions/:id", () => {
    it("should return subscription by id (200)", async () => {
      await seedSubscription(SUBSCRIPTION_1);

      const path = `/v1/subscriptions/${SUBSCRIPTION_1.id}`;
      const headers = signRequest("GET", path);

      const response = await request(app.getHttpServer())
        .get(path)
        .set(headers)
        .expect(200);

      expect(response.body).toMatchObject({
        id: SUBSCRIPTION_1.id,
        customerId: CUSTOMER_1.id,
        planName: "standard-monthly",
        status: "pending",
        amountCents: 5000,
      });
    });

    it("should return 404 for non-existent subscription", async () => {
      const fakeId = "f0000000-0000-4000-a000-000000000099";
      const path = `/v1/subscriptions/${fakeId}`;
      const headers = signRequest("GET", path);

      await request(app.getHttpServer()).get(path).set(headers).expect(404);
    });
  });

  describe("PUT /v1/subscriptions/:id", () => {
    it("should transition pending to active (200)", async () => {
      await seedSubscription(SUBSCRIPTION_1);

      const path = `/v1/subscriptions/${SUBSCRIPTION_1.id}`;
      const body = { status: "active" };
      const headers = signRequest("PUT", path, body);

      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(200);

      expect(response.body.status).toBe("active");
      expect(response.body.id).toBe(SUBSCRIPTION_1.id);
      expect(response.body.updatedAt).toBeDefined();
    });

    it("should return 409 for invalid transition (canceled to active)", async () => {
      await seedSubscription({ ...SUBSCRIPTION_1, status: "canceled" });

      const path = `/v1/subscriptions/${SUBSCRIPTION_1.id}`;
      const body = { status: "active" };
      const headers = signRequest("PUT", path, body);

      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(409);

      expect(response.body.details).toMatchObject({
        currentState: "canceled",
        targetState: "active",
        allowedTransitions: [],
      });
    });

    it("should return 404 for non-existent subscription", async () => {
      const fakeId = "f0000000-0000-4000-a000-000000000099";
      const path = `/v1/subscriptions/${fakeId}`;
      const body = { status: "active" };
      const headers = signRequest("PUT", path, body);

      await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(404);
    });

    it("should clear next_billing_date when pausing", async () => {
      await seedSubscription({ ...SUBSCRIPTION_1, status: "active" });

      const path = `/v1/subscriptions/${SUBSCRIPTION_1.id}`;
      const body = { status: "paused" };
      const headers = signRequest("PUT", path, body);

      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(200);

      expect(response.body.status).toBe("paused");
      expect(response.body.nextBillingDate).toBeNull();
    });

    it("should recalculate billing dates when resuming from paused", async () => {
      await seedSubscription({
        ...SUBSCRIPTION_1,
        status: "paused",
        nextBillingDate: null,
      });

      const path = `/v1/subscriptions/${SUBSCRIPTION_1.id}`;
      const body = { status: "active" };
      const headers = signRequest("PUT", path, body);

      const response = await request(app.getHttpServer())
        .put(path)
        .set(headers)
        .send(body)
        .expect(200);

      expect(response.body.status).toBe("active");
      expect(response.body.nextBillingDate).not.toBeNull();
      expect(response.body.billingPeriodStart).toBeDefined();
      expect(response.body.billingPeriodEnd).toBeDefined();
      // billingPeriodStart should be recent (close to now)
      const start = new Date(response.body.billingPeriodStart as string);
      const now = new Date();
      expect(now.getTime() - start.getTime()).toBeLessThan(5000);
    });
  });

  describe("GET /v1/subscriptions", () => {
    it("should list subscriptions with customer name and email", async () => {
      await seedSubscription(SUBSCRIPTION_1);

      const headers = signRequest("GET", "/v1/subscriptions");

      const response = await request(app.getHttpServer())
        .get("/v1/subscriptions")
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].customerName).toBe(CUSTOMER_1.name);
      expect(response.body.data[0].customerEmail).toBe(CUSTOMER_1.email);
      expect(response.body.data[0].id).toBe(SUBSCRIPTION_1.id);
      expect(response.body.data[0].customerId).toBe(CUSTOMER_1.id);
    });

    it("should list subscriptions with pagination", async () => {
      await seedSubscription(SUBSCRIPTION_1);
      await seedSubscription({
        ...SUBSCRIPTION_1,
        id: "d0000000-0000-4000-a000-000000000002",
        planName: "premium-monthly",
        amountCents: 10000,
      });

      const headers = signRequest("GET", "/v1/subscriptions");

      const response = await request(app.getHttpServer())
        .get("/v1/subscriptions?limit=1")
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.hasMore).toBe(true);
      expect(response.body.cursor).toBeDefined();

      // Follow cursor for second page
      const response2 = await request(app.getHttpServer())
        .get(
          `/v1/subscriptions?limit=1&cursor=${response.body.cursor as string}`,
        )
        .set(signRequest("GET", "/v1/subscriptions"))
        .expect(200);

      expect(response2.body.data).toHaveLength(1);
      expect(response2.body.hasMore).toBe(false);
      expect(response2.body.cursor).toBeNull();
    });

    it("should filter by customerId", async () => {
      await seedSubscription(SUBSCRIPTION_1);

      const headers = signRequest("GET", "/v1/subscriptions");

      const response = await request(app.getHttpServer())
        .get(`/v1/subscriptions?customerId=${CUSTOMER_1.id}`)
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].customerId).toBe(CUSTOMER_1.id);
    });

    it("should filter by status", async () => {
      await seedSubscription({ ...SUBSCRIPTION_1, status: "active" });

      const headers = signRequest("GET", "/v1/subscriptions");

      const activeResp = await request(app.getHttpServer())
        .get("/v1/subscriptions?status=active")
        .set(headers)
        .expect(200);

      expect(activeResp.body.data).toHaveLength(1);
      expect(activeResp.body.data[0].status).toBe("active");

      const pausedResp = await request(app.getHttpServer())
        .get("/v1/subscriptions?status=paused")
        .set(signRequest("GET", "/v1/subscriptions"))
        .expect(200);

      expect(pausedResp.body.data).toHaveLength(0);
    });

    it("should filter by date range", async () => {
      await seedSubscription(SUBSCRIPTION_1);

      const headers = signRequest("GET", "/v1/subscriptions");

      // Subscription createdAt is set by DB default (now). Use wide range to match.
      const startDate = "2020-01-01T00:00:00.000Z";
      const endDate = "2030-12-31T23:59:59.999Z";

      const response = await request(app.getHttpServer())
        .get(`/v1/subscriptions?startDate=${startDate}&endDate=${endDate}`)
        .set(headers)
        .expect(200);

      expect(response.body.data).toHaveLength(1);

      // Use a past range that should return nothing
      const response2 = await request(app.getHttpServer())
        .get(
          "/v1/subscriptions?startDate=2020-01-01T00:00:00.000Z&endDate=2020-12-31T23:59:59.999Z",
        )
        .set(signRequest("GET", "/v1/subscriptions"))
        .expect(200);

      expect(response2.body.data).toHaveLength(0);
    });

    it("should return 400 for invalid status", async () => {
      const headers = signRequest("GET", "/v1/subscriptions");

      await request(app.getHttpServer())
        .get("/v1/subscriptions?status=invalid")
        .set(headers)
        .expect(400);
    });

    it("should return empty result with correct shape when no matches", async () => {
      const headers = signRequest("GET", "/v1/subscriptions");

      const response = await request(app.getHttpServer())
        .get("/v1/subscriptions")
        .set(headers)
        .expect(200);

      expect(response.body).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });
  });

  describe("Subscription Pricing Updates (updatePricing)", () => {
    let subscriptionsService: SubscriptionsService;

    beforeAll(() => {
      subscriptionsService = app.get(SubscriptionsService);
    });

    it("should update amount for active subscription in DB", async () => {
      await seedSubscription({ ...SUBSCRIPTION_1, status: "active" });

      const count = await subscriptionsService.updatePricing(
        CUSTOMER_1.id,
        9500,
      );

      expect(count).toBe(1);

      const testDb = getTestDatabase();
      const [row] = await testDb
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.id, SUBSCRIPTION_1.id))
        .limit(1);

      expect(row.amountCents).toBe(9500);
    });

    it("should update paused subscription amount but not billing dates", async () => {
      const originalStart = new Date("2026-03-01T00:00:00.000Z");
      const originalEnd = new Date("2026-04-01T00:00:00.000Z");
      await seedSubscription({
        ...SUBSCRIPTION_1,
        status: "paused",
        nextBillingDate: null,
        billingPeriodStart: originalStart,
        billingPeriodEnd: originalEnd,
      });

      const count = await subscriptionsService.updatePricing(
        CUSTOMER_1.id,
        12000,
      );

      expect(count).toBe(1);

      const testDb = getTestDatabase();
      const [row] = await testDb
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.id, SUBSCRIPTION_1.id))
        .limit(1);

      expect(row.amountCents).toBe(12000);
      expect(row.billingPeriodStart.toISOString()).toBe(
        originalStart.toISOString(),
      );
      expect(row.billingPeriodEnd.toISOString()).toBe(
        originalEnd.toISOString(),
      );
      expect(row.nextBillingDate).toBeNull();
    });

    it("should return 0 when customer has no subscriptions", async () => {
      // No subscriptions seeded for this test
      const count = await subscriptionsService.updatePricing(
        CUSTOMER_1.id,
        7500,
      );

      expect(count).toBe(0);
    });

    it("should NOT update canceled subscription", async () => {
      await seedSubscription({
        ...SUBSCRIPTION_1,
        status: "canceled",
        amountCents: 5000,
      });

      const count = await subscriptionsService.updatePricing(
        CUSTOMER_1.id,
        9500,
      );

      expect(count).toBe(0);

      const testDb = getTestDatabase();
      const [row] = await testDb
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.id, SUBSCRIPTION_1.id))
        .limit(1);

      expect(row.amountCents).toBe(5000);
    });

    it("should verify updatePricing via direct service injection", async () => {
      await seedSubscription({
        ...SUBSCRIPTION_1,
        id: "d0000000-0000-4000-a000-000000000010",
        status: "active",
        amountCents: 5000,
      });
      await seedSubscription({
        ...SUBSCRIPTION_1,
        id: "d0000000-0000-4000-a000-000000000011",
        status: "paused",
        amountCents: 5000,
        nextBillingDate: null,
      });

      const count = await subscriptionsService.updatePricing(
        CUSTOMER_1.id,
        15000,
        "e2e-correlation-id",
      );

      expect(count).toBe(2);

      const testDb = getTestDatabase();
      const rows = await testDb
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.customerId, CUSTOMER_1.id));

      for (const row of rows) {
        expect(row.amountCents).toBe(15000);
      }
    });
  });
});
