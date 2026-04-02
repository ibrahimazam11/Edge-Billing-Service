/**
 * Helpers for stripe-mock e2e testing infrastructure.
 * stripe-mock is a local HTTP server that mimics the Stripe API.
 * Running on port 12111 via docker-compose.
 */

/**
 * Get the stripe-mock base URL from environment or default.
 */
export function getStripeMockUrl(): string {
  return process.env.STRIPE_API_BASE_URL ?? "http://localhost:12111";
}

/**
 * Wait for stripe-mock to be available before running tests.
 * Polls the stripe-mock health endpoint until it responds.
 * Call this in `beforeAll` of any e2e test that exercises Stripe.
 */
export async function waitForStripeMock(maxWaitMs = 10000): Promise<void> {
  const url = getStripeMockUrl();
  const startTime = Date.now();
  const pollIntervalMs = 500;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Any HTTP response (even 401) means stripe-mock is running.
      // Use a well-formatted test key so we get 200 instead of 401.
      const response = await fetch(`${url}/v1/customers`, {
        method: "GET",
        headers: {
          Authorization: "Bearer sk_test_123",
        },
      });
      if (response.status > 0) {
        return;
      }
    } catch {
      // stripe-mock not ready yet (connection refused), retry
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `stripe-mock not available at ${url} after ${maxWaitMs}ms — is docker compose running?`,
  );
}
