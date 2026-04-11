import { Logger } from "@nestjs/common";
import { SqsProducerService } from "./sqs-producer.service";
import { SqsService } from "@ssut/nestjs-sqs";
import type { SqsEnvelope } from "../../common/interfaces/envelope.interface";
import type { PaymentSucceededPayload } from "./contracts/outbound-events";

describe("SqsProducerService", () => {
  let service: SqsProducerService;
  let mockSqsService: { send: jest.Mock };

  beforeEach(() => {
    mockSqsService = {
      send: jest.fn().mockResolvedValue([]),
    };

    service = new SqsProducerService(mockSqsService as unknown as SqsService);

    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const validPayload: PaymentSucceededPayload = {
    invoiceId: "inv-1",
    customerId: "cust-1",
    monolithCustomerId: "mono-cust-1",
    amountCents: 1000,
    currency: "USD",
    paymentMethodId: "pm-1",
    stripePaymentIntentId: "pi-1",
  };

  it("should wrap payload in SqsEnvelope with correct version, type, timestamp, and correlationId", async () => {
    const correlationId = "corr-123";

    await service.publish("payment.succeeded", validPayload, correlationId);

    expect(mockSqsService.send).toHaveBeenCalledTimes(1);
    const call = mockSqsService.send.mock.calls[0] as [
      string,
      { id: string; body: SqsEnvelope },
    ];
    const [queueName, message] = call;
    expect(queueName).toBe("monolith-outbound");

    const envelope = message.body;
    expect(envelope.version).toBe("1.0");
    expect(envelope.type).toBe("payment.succeeded");
    expect(envelope.correlationId).toBe(correlationId);
    expect(envelope.payload).toEqual(validPayload);
  });

  it('should call SqsService.send() with producer name "monolith-outbound"', async () => {
    await service.publish(
      "invoice.created",
      {
        invoiceId: "inv-1",
        customerId: "cust-1",
        monolithCustomerId: "mono-cust-1",
        totalAmountCents: 5000,
        currency: "USD",
        billingPeriodStart: "2026-01-01",
        billingPeriodEnd: "2026-01-31",
      },
      "corr-456",
    );

    expect(mockSqsService.send).toHaveBeenCalledWith(
      "monolith-outbound",
      expect.objectContaining({
        id: expect.any(String) as string,
        body: expect.any(Object) as object,
      }),
    );
  });

  it("should generate a valid UUIDv7 message ID", async () => {
    await service.publish(
      "payment.failed",
      {
        invoiceId: "inv-1",
        customerId: "cust-1",
        monolithCustomerId: "mono-cust-1",
        amountCents: 1000,
        currency: "USD",
        failureReason: "card_declined",
        attemptNumber: 1,
      },
      "corr-789",
    );

    const call = mockSqsService.send.mock.calls[0] as [
      string,
      { id: string; body: SqsEnvelope },
    ];
    const uuidV7Regex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(call[1].id).toMatch(uuidV7Regex);
  });

  it("should include a valid ISO 8601 UTC timestamp", async () => {
    const before = new Date().toISOString();
    await service.publish("payment.succeeded", validPayload, "corr-000");
    const after = new Date().toISOString();

    const call = mockSqsService.send.mock.calls[0] as [
      string,
      { id: string; body: SqsEnvelope },
    ];
    const envelope = call[1].body;

    const timestamp = new Date(envelope.timestamp);
    expect(timestamp.toISOString()).toBe(envelope.timestamp);
    expect(envelope.timestamp >= before).toBe(true);
    expect(envelope.timestamp <= after).toBe(true);
  });

  it("should include metadata in envelope when provided", async () => {
    const metadata = { dual_write: true };

    await service.publish(
      "payment.succeeded",
      validPayload,
      "corr-meta",
      metadata,
    );

    const call = mockSqsService.send.mock.calls[0] as [
      string,
      { id: string; body: SqsEnvelope },
    ];
    const envelope = call[1].body;
    expect(envelope.metadata).toEqual({ dual_write: true });
  });

  it("should NOT include metadata field in envelope when metadata is undefined", async () => {
    await service.publish("payment.succeeded", validPayload, "corr-no-meta");

    const call = mockSqsService.send.mock.calls[0] as [
      string,
      { id: string; body: SqsEnvelope },
    ];
    const envelope = call[1].body;
    expect(envelope).not.toHaveProperty("metadata");
  });

  it("should NOT include metadata field in envelope when metadata is explicitly undefined", async () => {
    await service.publish(
      "payment.succeeded",
      validPayload,
      "corr-explicit-undef",
      undefined,
    );

    const call = mockSqsService.send.mock.calls[0] as [
      string,
      { id: string; body: SqsEnvelope },
    ];
    const envelope = call[1].body;
    expect(envelope).not.toHaveProperty("metadata");
  });

  it("should log error and re-throw when SQS send fails", async () => {
    const sendError = new Error("Network timeout");
    mockSqsService.send.mockRejectedValue(sendError);

    const errorSpy = jest.spyOn(Logger.prototype, "error");

    await expect(
      service.publish("payment.succeeded", validPayload, "corr-fail"),
    ).rejects.toThrow("Network timeout");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "payment.succeeded",
        correlationId: "corr-fail",
        action: "event.publish.failed",
        error: "Network timeout",
      }),
    );
  });
});
