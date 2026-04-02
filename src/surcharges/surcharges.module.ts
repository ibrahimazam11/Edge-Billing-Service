import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { SurchargeConfigService } from "./surcharge-config.service";
import { SurchargeConfigRepository } from "./surcharge-config.repository";

@Module({
  imports: [DatabaseModule],
  providers: [SurchargeConfigService, SurchargeConfigRepository],
  exports: [SurchargeConfigService, SurchargeConfigRepository],
})
export class SurchargesModule {}
