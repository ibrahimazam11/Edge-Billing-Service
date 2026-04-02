import { registerAs } from "@nestjs/config";

export const dunningConfig = registerAs("dunning", () => {
  const raw = process.env.DUNNING_RETRY_SCHEDULE_DAYS?.trim();

  if (raw !== undefined && raw.length === 0) {
    throw new Error(
      "DUNNING_RETRY_SCHEDULE_DAYS cannot be empty. Provide a comma-separated list of positive integers (e.g., 1,3,5,7) or remove the variable to use the default.",
    );
  }

  const scheduleStr = raw || "1,3,5,7";

  const retryScheduleDays = scheduleStr.split(",").map((s) => {
    const trimmed = s.trim();
    const num = parseInt(trimmed, 10);
    if (isNaN(num) || num < 1 || String(num) !== trimmed) {
      throw new Error(
        `DUNNING_RETRY_SCHEDULE_DAYS contains invalid value "${s.trim()}". All values must be positive integers.`,
      );
    }
    return num;
  });

  return {
    retryScheduleDays,
    maxRetryAttempts: retryScheduleDays.length,
  };
});
