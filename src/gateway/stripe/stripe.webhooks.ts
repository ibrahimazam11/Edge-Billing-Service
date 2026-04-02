import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Stripe from "stripe";
import { WebhookVerificationException } from "../../common/exceptions/webhook-verification.exception";

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(private readonly configService: ConfigService) {
    const secretKey = this.configService.get<string>("stripe.secretKey")!;
    const apiVersion = this.configService.get<string>("stripe.apiVersion")!;
    const apiBaseUrl = this.configService.get<string>("stripe.apiBaseUrl");

    const options: Stripe.StripeConfig = {
      apiVersion: apiVersion as Stripe.LatestApiVersion,
    };

    if (apiBaseUrl) {
      options.host = new URL(apiBaseUrl).hostname;
      options.port = parseInt(new URL(apiBaseUrl).port, 10);
      options.protocol = new URL(apiBaseUrl).protocol.replace(":", "") as
        | "http"
        | "https";
    }

    this.stripe = new Stripe(secretKey, options);
    this.webhookSecret = this.configService.get<string>(
      "stripe.webhookSecret",
    )!;
  }

  verifyWebhookSignature(
    payload: string | Buffer,
    signature: string,
  ): Stripe.Event {
    try {
      return this.stripe.webhooks.constructEvent(
        payload,
        signature,
        this.webhookSecret,
      );
    } catch (error) {
      this.logger.error({
        action: "webhook.verification_failed",
        error: error instanceof Error ? error.message : String(error),
      });

      throw new WebhookVerificationException(
        `Webhook signature verification failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
}
