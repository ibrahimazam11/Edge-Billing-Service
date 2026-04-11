import { Module } from "@nestjs/common";
import { GatewayModule } from "../gateway/gateway.module";
import { CustomersModule } from "../customers/customers.module";
import { PaymentMethodsRepository } from "./payment-methods.repository";
import { GatewayAssignmentsRepository } from "./gateway-assignments.repository";
import { PaymentMethodsService } from "./payment-methods.service";
import { PaymentMethodsController } from "./payment-methods.controller";
import { SetupIntentsController } from "./setup-intents.controller";

@Module({
  imports: [GatewayModule, CustomersModule],
  controllers: [PaymentMethodsController, SetupIntentsController],
  providers: [
    PaymentMethodsRepository,
    GatewayAssignmentsRepository,
    PaymentMethodsService,
  ],
  exports: [
    PaymentMethodsRepository,
    GatewayAssignmentsRepository,
    PaymentMethodsService,
  ],
})
export class PaymentMethodsModule {}
