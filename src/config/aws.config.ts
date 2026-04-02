import { registerAs } from "@nestjs/config";

export const awsConfig = registerAs("aws", () => {
  const region = process.env.AWS_REGION;

  if (!region) throw new Error("AWS_REGION is required");

  return {
    endpointUrl: process.env.AWS_ENDPOINT_URL || undefined,
    region,
    // Optional: only used for LocalStack / explicit credentials.
    // When omitted, AWS SDK v3 uses the default credential chain
    // (AWS_PROFILE, ~/.aws/credentials, EC2/ECS IAM role, etc.)
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || undefined,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || undefined,
  };
});
