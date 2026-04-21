import { Module, forwardRef } from "@nestjs/common";
import { GatewayModule } from "../gateway/gateway.module";
import { CustomersModule } from "../customers/customers.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { InvoicesService } from "../invoices/invoices.service";
import { PaymentMethodsRepository } from "./payment-methods.repository";
import { GatewayAssignmentsRepository } from "./gateway-assignments.repository";
import {
  PaymentMethodsService,
  INVOICES_SERVICE,
} from "./payment-methods.service";
import { PaymentMethodsController } from "./payment-methods.controller";
import { SetupIntentsController } from "./setup-intents.controller";

@Module({
  imports: [GatewayModule, CustomersModule, forwardRef(() => InvoicesModule)],
  controllers: [PaymentMethodsController, SetupIntentsController],
  providers: [
    PaymentMethodsRepository,
    GatewayAssignmentsRepository,
    PaymentMethodsService,
    {
      provide: INVOICES_SERVICE,
      useExisting: InvoicesService,
    },
  ],
  exports: [
    PaymentMethodsRepository,
    GatewayAssignmentsRepository,
    PaymentMethodsService,
  ],
})
export class PaymentMethodsModule {}
