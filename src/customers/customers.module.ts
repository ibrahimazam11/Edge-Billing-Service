import { Module } from "@nestjs/common";
import { GatewayModule } from "../gateway/gateway.module";
import { CustomersRepository } from "./customers.repository";
import { CustomersService } from "./customers.service";
import { CustomersController } from "./customers.controller";

@Module({
  imports: [GatewayModule],
  controllers: [CustomersController],
  providers: [CustomersRepository, CustomersService],
  exports: [CustomersRepository, CustomersService],
})
export class CustomersModule {}
