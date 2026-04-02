import { registerAs } from "@nestjs/config";

export const adyenConfig = registerAs("adyen", () => {
  const apiKey = process.env.ADYEN_API_KEY?.trim();
  const merchantAccount = process.env.ADYEN_MERCHANT_ACCOUNT?.trim();
  const hmacKey = process.env.ADYEN_HMAC_KEY?.trim();
  const environment = (
    process.env.ADYEN_ENVIRONMENT?.trim() || "TEST"
  ).toUpperCase();
  const liveUrlPrefix = process.env.ADYEN_LIVE_URL_PREFIX?.trim();
  const apiBaseUrl = process.env.ADYEN_API_BASE_URL?.trim() || undefined;

  if (!apiKey) throw new Error("ADYEN_API_KEY is required");
  if (!merchantAccount) throw new Error("ADYEN_MERCHANT_ACCOUNT is required");
  if (!hmacKey) throw new Error("ADYEN_HMAC_KEY is required");
  if (environment === "LIVE" && !liveUrlPrefix) {
    throw new Error(
      "ADYEN_LIVE_URL_PREFIX is required when ADYEN_ENVIRONMENT is LIVE",
    );
  }

  return {
    apiKey,
    merchantAccount,
    hmacKey,
    environment,
    liveUrlPrefix: liveUrlPrefix || undefined,
    apiBaseUrl,
  };
});
