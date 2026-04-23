import { registerAs } from "@nestjs/config";

export const monolithConfig = registerAs("monolith", () => {
  const baseUrl = process.env.MONOLITH_API_BASE_URL?.trim();

  return {
    baseUrl: baseUrl || undefined,
    apiKey: process.env.MONOLITH_API_KEY?.trim() || undefined,
    hmacSecret: process.env.MONOLITH_HMAC_SECRET?.trim() || undefined,
  };
});
