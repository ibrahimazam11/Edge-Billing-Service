import { registerAs } from "@nestjs/config";

export const authConfig = registerAs("auth", () => {
  const apiKey = process.env.API_KEY?.trim();
  const hmacSecret = process.env.HMAC_SECRET?.trim();

  if (!apiKey) throw new Error("API_KEY is required");
  if (!hmacSecret) throw new Error("HMAC_SECRET is required");

  return {
    apiKey,
    hmacSecret,
  };
});
