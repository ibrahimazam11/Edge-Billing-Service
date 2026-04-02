import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { FeatureFlagService } from "./feature-flags.service";
import { FeatureFlagsRepository } from "./feature-flags.repository";

@Module({
  imports: [DatabaseModule],
  providers: [FeatureFlagService, FeatureFlagsRepository],
  exports: [FeatureFlagService, FeatureFlagsRepository],
})
export class FeatureFlagsModule {}
