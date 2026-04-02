import { registerAs } from "@nestjs/config";

export const appConfig = registerAs("app", () => {
  const port = parseInt(process.env.PORT || "3000", 10);
  if (isNaN(port)) {
    throw new Error("PORT must be a valid number");
  }

  return {
    nodeEnv: process.env.NODE_ENV || "development",
    port,
  };
});
