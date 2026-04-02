import { registerAs } from "@nestjs/config";

export const sqsConfig = registerAs("sqs", () => {
  const monolithInboundQueueUrl = process.env.SQS_MONOLITH_INBOUND_QUEUE_URL;
  const monolithOutboundQueueUrl = process.env.SQS_MONOLITH_OUTBOUND_QUEUE_URL;
  const schedulerQueueUrl = process.env.SQS_SCHEDULER_QUEUE_URL;

  if (!monolithInboundQueueUrl)
    throw new Error("SQS_MONOLITH_INBOUND_QUEUE_URL is required");
  if (!monolithOutboundQueueUrl)
    throw new Error("SQS_MONOLITH_OUTBOUND_QUEUE_URL is required");
  if (!schedulerQueueUrl)
    throw new Error("SQS_SCHEDULER_QUEUE_URL is required");

  return {
    monolithInboundQueueUrl,
    monolithOutboundQueueUrl,
    schedulerQueueUrl,
  };
});
