import { registerAs } from "@nestjs/config";

export const stripeConfig = registerAs("stripe", () => {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const apiVersion = process.env.STRIPE_API_VERSION?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();

  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is required");
  if (!apiVersion) throw new Error("STRIPE_API_VERSION is required");
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is required");

  return {
    secretKey,
    apiVersion,
    webhookSecret,
    apiBaseUrl: process.env.STRIPE_API_BASE_URL?.trim() || undefined,
  };
});
