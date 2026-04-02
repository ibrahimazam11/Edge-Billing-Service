/**
 * Helpers for WireMock e2e testing infrastructure.
 * WireMock acts as an Adyen Checkout API stub for E2E tests.
 * Running on port 8080 via docker-compose.
 */

/**
 * Get the WireMock base URL from environment or default.
 */
export function getWireMockUrl(): string {
  return process.env.ADYEN_API_BASE_URL ?? "http://localhost:8080";
}

/**
 * Wait for WireMock to be available before running tests.
 * Polls the WireMock admin health endpoint until it responds.
 * Call this in `beforeAll` of any e2e test that exercises Adyen.
 */
export async function waitForWireMock(maxWaitMs = 10000): Promise<void> {
  const url = getWireMockUrl();
  const startTime = Date.now();
  const pollIntervalMs = 500;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetch(`${url}/__admin/health`);
      if (response.status > 0) {
        return;
      }
    } catch {
      // WireMock not ready yet (connection refused), retry
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `WireMock not available at ${url} after ${maxWaitMs}ms — is docker compose running?`,
  );
}
