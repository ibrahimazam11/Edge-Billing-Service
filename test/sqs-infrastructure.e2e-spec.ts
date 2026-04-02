/**
 * SQS Infrastructure E2E Tests — Reference Pattern
 *
 * These tests verify that LocalStack SQS integration works end-to-end:
 * 1. Outbound: SqsProducerService.publish() → message arrives in LocalStack queue
 * 2. Inbound: Send message to inbound queue → consumer processes it → DB state changes
 *
 * PREREQUISITES: `docker compose up -d` (localstack must be running)
 *
 * PATTERN: Use these tests as a template for SQS-related e2e tests in future stories.
 */
import { INestApplication } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { createTestApp } from "./helpers/test-app";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  seedLedgerAccounts,
} from "./helpers/database";
import { waitForStripeMock } from "./helpers/stripe-mock";
import {
  sendSqsMessage,
  receiveSqsMessages,
  waitForSqsConsumer,
  purgeSqsQueue,
} from "./helpers/sqs";
import { SqsProducerService } from "../src/integration/sqs/sqs-producer.service";
import type { SqsEnvelope } from "../src/common/interfaces/envelope.interface";
import type { App } from "supertest/types";

const OUTBOUND_QUEUE_URL =
  process.env.SQS_MONOLITH_OUTBOUND_QUEUE_URL ??
  "http://localhost:4566/000000000000/billing-outbound";
const INBOUND_QUEUE_URL =
  process.env.SQS_MONOLITH_INBOUND_QUEUE_URL ??
  "http://localhost:4566/000000000000/billing-inbound";

describe("SQS Infrastructure (e2e)", () => {
  let app: INestApplication<App>;
  let sqsProducer: SqsProducerService;

  beforeAll(async () => {
    await setupTestDatabase();
    await cleanDatabase();
    await seedLedgerAccounts();

    // stripe-mock required because customer.created handler calls gateway.createCustomer()
    await waitForStripeMock();

    // Purge queues before tests to ensure clean state
    await purgeSqsQueue(OUTBOUND_QUEUE_URL).catch(() => {
      // Queue may not exist yet in LocalStack startup race
    });
    await purgeSqsQueue(INBOUND_QUEUE_URL).catch(() => {});

    // Small delay for purge to take effect
    await new Promise((resolve) => setTimeout(resolve, 1000));

    app = await createTestApp();
    sqsProducer = app.get(SqsProducerService);
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedLedgerAccounts();
  });

  describe("Outbound: SqsProducerService.publish()", () => {
    it("should publish a message to the outbound queue and receive it from LocalStack", async () => {
      // Purge outbound queue to ensure clean state for this test
      await purgeSqsQueue(OUTBOUND_QUEUE_URL);
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Publish a payment.succeeded event
      const payload = {
        invoiceId: "a0000000-0000-4000-a000-000000000001",
        customerId: "c0000000-0000-4000-a000-000000000001",
        amountCents: 5000,
        currency: "usd",
        paymentMethodId: "b0000000-0000-4000-a000-000000000001",
        stripePaymentIntentId: "pi_test_001",
      };

      await sqsProducer.publish(
        "payment.succeeded",
        payload,
        "sqs-e2e-corr-001",
      );

      // Receive messages from the LocalStack outbound queue
      const messages = await receiveSqsMessages(OUTBOUND_QUEUE_URL, 5000);
      expect(messages.length).toBeGreaterThan(0);

      // Parse the first message and verify envelope structure
      const envelope = JSON.parse(messages[0].Body!) as SqsEnvelope;
      expect(envelope.version).toBe("1.0");
      expect(envelope.type).toBe("payment.succeeded");
      expect(envelope.correlationId).toBe("sqs-e2e-corr-001");
      expect(envelope.timestamp).toBeDefined();
      expect(envelope.payload).toMatchObject(payload);
    });
  });

  describe("Inbound: MonolithEventsConsumer", () => {
    it("should process a customer.created event from the inbound queue", async () => {
      // Purge the inbound queue to clear any leftover messages from previous runs.
      // Messages stuck in visibility timeout (30s) may block new messages.
      await purgeSqsQueue(INBOUND_QUEUE_URL).catch(() => {});
      // Wait for purge to propagate (LocalStack can take up to 500ms)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const monolithCustomerId = `mono-sqs-e2e-${Date.now()}`;

      // Create a customer.created envelope
      const envelope: SqsEnvelope = {
        version: "1.0",
        type: "customer.created",
        timestamp: new Date().toISOString(),
        correlationId: "sqs-e2e-corr-002",
        payload: {
          monolithCustomerId,
          name: "SQS E2E Test Customer",
          email: "sqs-e2e@example.com",
        },
      };

      // Send the message to the inbound queue
      await sendSqsMessage(INBOUND_QUEUE_URL, envelope);

      // Wait for the consumer to process the message and create a customer.
      // The @ssut/nestjs-sqs consumer polls with long polling (default ~20s cycle).
      // customer.created also calls stripe-mock (gateway.createCustomer), adding latency.
      // Visibility timeout is 30s, so worst case is ~35s wait.
      const testDb = getTestDatabase();
      await waitForSqsConsumer(async () => {
        const result = await testDb.execute(
          sql`SELECT id FROM customers WHERE monolith_customer_id = ${monolithCustomerId}`,
        );
        return result.rows.length > 0;
      }, 40000);

      // Verify the customer was created in the database
      const rows = await testDb.execute(
        sql`SELECT * FROM customers WHERE monolith_customer_id = ${monolithCustomerId}`,
      );
      expect(rows.rows).toHaveLength(1);
      const customer = rows.rows[0];
      expect(customer.name).toBe("SQS E2E Test Customer");
      expect(customer.email).toBe("sqs-e2e@example.com");
    }, 60000);
  });
});
