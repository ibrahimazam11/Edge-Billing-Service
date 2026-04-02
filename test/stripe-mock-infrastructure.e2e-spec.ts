/**
 * stripe-mock Infrastructure E2E Tests — Reference Pattern
 *
 * These tests verify that the real StripeAdapter correctly routes
 * API calls through stripe-mock (not real Stripe) during e2e tests.
 *
 * PREREQUISITES: `docker compose up -d` (stripe-mock must be running on port 12111)
 *
 * PATTERN: Use these tests as a template for Stripe-related e2e tests in future stories.
 * In any e2e test that exercises Stripe calls:
 *   1. Call `await waitForStripeMock()` in `beforeAll`
 *   2. Get the adapter via `app.get(PAYMENT_GATEWAY)` or DI
 *   3. Call adapter methods — they route to stripe-mock automatically via STRIPE_API_BASE_URL
 */
import { INestApplication } from "@nestjs/common";
import { createTestApp } from "./helpers/test-app";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  seedLedgerAccounts,
} from "./helpers/database";
import { waitForStripeMock } from "./helpers/stripe-mock";
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from "../src/gateway/gateway.interface";
import type { App } from "supertest/types";

describe("stripe-mock Infrastructure (e2e)", () => {
  let app: INestApplication<App>;
  let gateway: PaymentGateway;

  beforeAll(async () => {
    await setupTestDatabase();
    await cleanDatabase();
    await seedLedgerAccounts();

    // Wait for stripe-mock to be available before tests
    await waitForStripeMock();

    app = await createTestApp();
    gateway = app.get<PaymentGateway>(PAYMENT_GATEWAY);
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  describe("StripeAdapter → stripe-mock", () => {
    it("should create a customer via stripe-mock and receive a cus_* ID", async () => {
      const result = await gateway.createCustomer({
        email: "stripe-mock-test@example.com",
        name: "Stripe Mock Test Customer",
      });

      expect(result).toBeDefined();
      expect(result.id).toMatch(/^cus_/);
      expect(result.email).toBe("stripe-mock-test@example.com");
    });

    it("should create a charge via stripe-mock and receive a pi_* ID", async () => {
      // First create a customer to get a valid customer ID
      const customer = await gateway.createCustomer({
        email: "stripe-mock-charge@example.com",
        name: "Charge Test Customer",
      });

      const result = await gateway.createCharge({
        amount: 5000,
        currency: "usd",
        customerId: customer.id,
        paymentMethodId: "pm_card_visa",
        description: "stripe-mock e2e test charge",
        idempotencyKey: `stripe-mock-e2e-${Date.now()}`,
      });

      expect(result).toBeDefined();
      expect(result.id).toMatch(/^pi_/);
      expect(result.amount).toBe(5000);
      expect(result.currency).toBe("usd");
    });
  });
});
