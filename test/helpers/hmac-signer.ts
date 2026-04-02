import { createHmac, createHash } from "crypto";

const DEFAULT_API_KEY = "test-api-key";
const DEFAULT_HMAC_SECRET = "test-hmac-secret-for-e2e-testing";

interface HmacHeaders {
  [key: string]: string;
  "x-api-key": string;
  "x-signature": string;
  "x-timestamp": string;
}

/**
 * Generate HMAC auth headers for e2e test requests.
 * Mirrors the signing logic in HmacAuthGuard.
 */
export function signRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  options?: {
    apiKey?: string;
    hmacSecret?: string;
    timestamp?: number;
    adminRole?: string;
    adminUserId?: string;
  },
): HmacHeaders {
  const apiKey = options?.apiKey ?? DEFAULT_API_KEY;
  const hmacSecret = options?.hmacSecret ?? DEFAULT_HMAC_SECRET;
  const timestamp = options?.timestamp ?? Date.now();

  const bodyStr = body ? JSON.stringify(body) : "";
  const bodyHash = createHash("sha256").update(bodyStr).digest("hex");
  const signaturePayload = method + path + timestamp.toString() + bodyHash;
  const signature = createHmac("sha256", hmacSecret)
    .update(signaturePayload)
    .digest("hex");

  const headers: HmacHeaders = {
    "x-api-key": apiKey,
    "x-signature": signature,
    "x-timestamp": timestamp.toString(),
  };

  if (options?.adminRole) {
    headers["x-admin-role"] = options.adminRole;
  }
  if (options?.adminUserId) {
    headers["x-admin-user-id"] = options.adminUserId;
  }

  return headers;
}
