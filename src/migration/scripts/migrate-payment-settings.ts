import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../app.module";
import { PaymentSettingsMigrationService } from "../payment-settings-migration.service";
import type { MigrationOptions } from "../dto/migration-options.dto";

async function bootstrap(): Promise<void> {
  const args = process.argv.slice(2);

  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");

  const batchSizeIdx = args.indexOf("--batch-size");
  const batchSize =
    batchSizeIdx >= 0 ? parseInt(args[batchSizeIdx + 1], 10) : 50;

  const batchDelayIdx = args.indexOf("--batch-delay");
  const batchDelayMs =
    batchDelayIdx >= 0 ? parseInt(args[batchDelayIdx + 1], 10) : 1000;

  const customerIdsIdx = args.indexOf("--customer-ids");
  const customerIds =
    customerIdsIdx >= 0 ? args[customerIdsIdx + 1].split(",") : [];

  if (!all && customerIds.length === 0) {
    console.error(
      "Usage: migrate-payment-settings --all | --customer-ids <comma-separated>",
    );
    console.error(
      "  --dry-run           Validate without writing to billing DB",
    );
    console.error("  --batch-size <N>    Customers per batch (default: 50)");
    console.error(
      "  --batch-delay <ms>  Delay between batches (default: 1000)",
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  const service = app.get(PaymentSettingsMigrationService);

  const options: MigrationOptions = {
    dryRun,
    batchSize,
    batchDelayMs,
  };

  const summary = all
    ? await service.migrateAll(options)
    : await service.migrateByIds(customerIds, options);

  console.log(JSON.stringify(summary, null, 2));

  await app.close();
  process.exit(summary.failed > 0 ? 1 : 0);
}

bootstrap().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
