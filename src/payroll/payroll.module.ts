import { Module } from "@nestjs/common";
import { PayrollBreakdownResolver } from "./payroll-breakdown.resolver";

@Module({
  providers: [PayrollBreakdownResolver],
  exports: [PayrollBreakdownResolver],
})
export class PayrollModule {}
