import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  PurgeQueueCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import type { SqsEnvelope } from "../../src/common/interfaces/envelope.interface";

let sqsClient: SQSClient | null = null;

/**
 * Get or create an SQS client pointing to LocalStack.
 * Uses the same endpoint and credentials as .env.test.
 */
export function getSqsClient(): SQSClient {
  if (sqsClient) return sqsClient;

  sqsClient = new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });

  return sqsClient;
}

/**
 * Send a real SQS message to a LocalStack queue.
 * Wraps the payload in the standard SqsEnvelope format.
 */
export async function sendSqsMessage(
  queueUrl: string,
  envelope: SqsEnvelope,
): Promise<void> {
  const client = getSqsClient();
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(envelope),
    }),
  );
}

/**
 * Receive messages from a LocalStack SQS queue via long-polling.
 * Returns up to 10 messages, waits up to maxWaitMs for messages.
 */
export async function receiveSqsMessages(
  queueUrl: string,
  maxWaitMs = 5000,
): Promise<Message[]> {
  const client = getSqsClient();
  const waitTimeSeconds = Math.min(Math.ceil(maxWaitMs / 1000), 20);

  const response = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitTimeSeconds,
      VisibilityTimeout: 0,
    }),
  );

  return response.Messages ?? [];
}

/**
 * Poll a predicate function until it returns true or timeout expires.
 * Useful for waiting on async consumer processing (e.g., checking DB state).
 */
export async function waitForSqsConsumer(
  predicate: () => Promise<boolean>,
  timeoutMs = 10000,
): Promise<void> {
  const startTime = Date.now();
  const pollIntervalMs = 200;

  while (Date.now() - startTime < timeoutMs) {
    const result = await predicate();
    if (result) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `waitForSqsConsumer timed out after ${timeoutMs}ms — predicate never returned true`,
  );
}

/**
 * Purge all messages from a LocalStack SQS queue.
 * Useful for cleaning up between tests.
 */
export async function purgeSqsQueue(queueUrl: string): Promise<void> {
  const client = getSqsClient();
  await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
}
