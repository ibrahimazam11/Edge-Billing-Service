import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { DualWriteService } from "./dual-write.service";
import { MigrationLogsRepository } from "./migration-logs.repository";

@Module({
  imports: [DatabaseModule, FeatureFlagsModule],
  providers: [DualWriteService, MigrationLogsRepository],
  exports: [DualWriteService],
})
export class DualWriteModule {}
