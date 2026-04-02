import { ConfigService } from "@nestjs/config";
import Stripe from "stripe";
import { StripeWebhookService } from "./stripe.webhooks";
import { WebhookVerificationException } from "../../common/exceptions/webhook-verification.exception";

jest.mock("stripe", () => {
  const mockStripeInstance = {
    webhooks: {
      constructEvent: jest.fn(),
    },
  };

  const StripeMock = jest.fn(() => mockStripeInstance);
  return { __esModule: true, default: StripeMock };
});

describe("StripeWebhookService", () => {
  let service: StripeWebhookService;
  let mockConstructEvent: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    const mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, string> = {
          "stripe.secretKey": "sk_test_123",
          "stripe.apiVersion": "2026-01-28.clover",
          "stripe.webhookSecret": "whsec_test_123",
          "stripe.apiBaseUrl": "",
        };
        return config[key];
      }),
    } as unknown as ConfigService;

    service = new StripeWebhookService(mockConfigService);

    const stripeInstance = (Stripe as unknown as jest.Mock).mock.results;
    mockConstructEvent =
      stripeInstance[stripeInstance.length - 1].value.webhooks.constructEvent;
  });

  const validEvent: Stripe.Event = {
    id: "evt_123",
    object: "event",
    type: "payment_intent.succeeded",
    api_version: "2026-01-28.clover",
    created: 1700000000,
    data: {
      object: {
        id: "pi_123",
        object: "payment_intent",
      } as Stripe.PaymentIntent,
    },
    livemode: false,
    pending_webhooks: 0,
    request: null,
  } as Stripe.Event;

  it("should return verified event on valid signature", () => {
    mockConstructEvent.mockReturnValue(validEvent);

    const result = service.verifyWebhookSignature(
      '{"id":"evt_123"}',
      "sig_valid",
    );

    expect(result).toEqual(validEvent);
    expect(mockConstructEvent).toHaveBeenCalledWith(
      '{"id":"evt_123"}',
      "sig_valid",
      "whsec_test_123",
    );
  });

  it("should throw WebhookVerificationException on invalid signature", () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error(
        "No signatures found matching the expected signature for payload.",
      );
    });

    expect(() =>
      service.verifyWebhookSignature('{"id":"evt_123"}', "sig_invalid"),
    ).toThrow(WebhookVerificationException);
  });

  it("should throw WebhookVerificationException on missing signature header", () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error(
        "No signatures found matching the expected signature for payload.",
      );
    });

    expect(() =>
      service.verifyWebhookSignature('{"id":"evt_123"}', ""),
    ).toThrow(WebhookVerificationException);
  });

  it("should throw WebhookVerificationException on tampered payload", () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error(
        "No signatures found matching the expected signature for payload.",
      );
    });

    expect(() =>
      service.verifyWebhookSignature('{"id":"evt_tampered"}', "sig_valid"),
    ).toThrow(WebhookVerificationException);
  });

  it("should throw WebhookVerificationException on expired timestamp", () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error("Timestamp outside the tolerance zone.");
    });

    expect(() =>
      service.verifyWebhookSignature('{"id":"evt_123"}', "sig_expired"),
    ).toThrow(WebhookVerificationException);
  });

  it("should include error details in thrown exception message", () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error("Timestamp outside the tolerance zone.");
    });

    expect(() =>
      service.verifyWebhookSignature('{"id":"evt_123"}', "sig_expired"),
    ).toThrow(/Webhook signature verification failed: Timestamp outside/);
  });
});
