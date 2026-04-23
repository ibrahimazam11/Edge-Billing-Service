import { Module } from "@nestjs/common";
import { MonolithApiService } from "./monolith-api.service";

@Module({
  providers: [MonolithApiService],
  exports: [MonolithApiService],
})
export class MonolithApiModule {}
