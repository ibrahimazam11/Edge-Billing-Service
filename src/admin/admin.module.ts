import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { CustomersModule } from "../customers/customers.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { ChargesModule } from "../charges/charges.module";
import { DunningModule } from "../dunning/dunning.module";
import { ReconciliationModule } from "../reconciliation/reconciliation.module";
import { RefundsModule } from "../refunds/refunds.module";
import { CreditsModule } from "../credits/credits.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AuditTrailService } from "./audit-trail.service";
import { AuditTrailRepository } from "./audit-trail.repository";
import { AuditTrailInterceptor } from "./audit-trail.interceptor";
import { TimeMachineController } from "./time-machine.controller";
import { TimeMachineService } from "./time-machine.service";

@Module({
  imports: [
    SubscriptionsModule,
    CustomersModule,
    InvoicesModule,
    ChargesModule,
    DunningModule,
    ReconciliationModule,
    RefundsModule,
    CreditsModule,
  ],
  controllers: [AdminController, TimeMachineController],
  providers: [
    AdminService,
    AuditTrailService,
    AuditTrailRepository,
    TimeMachineService,
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditTrailInterceptor,
    },
  ],
})
export class AdminModule {}
