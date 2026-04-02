import { Module } from "@nestjs/common";
import { SqsIntegrationModule } from "./sqs/sqs.module";

@Module({
  imports: [SqsIntegrationModule],
  exports: [SqsIntegrationModule],
})
export class IntegrationModule {}
