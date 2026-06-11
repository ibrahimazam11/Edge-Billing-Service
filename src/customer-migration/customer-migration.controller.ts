import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
} from "@nestjs/common";
import {
  ApiOperation,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import {
  MigrateCustomerBodyDto,
  RollbackCustomerBodyDto,
} from "./dto/migrate-customer-body.dto";
import {
  CustomerMigrationOrchestratorService,
  type OrchestratorResult,
} from "./customer-migration.orchestrator.service";
import {
  CustomerMigrationCleanupService,
  type CleanupResult,
} from "./customer-migration-cleanup.service";

@ApiTags("CustomerMigration")
@ApiUnauthorizedResponse({ description: "Unauthorized" })
@Controller("v1/migration/customer")
export class CustomerMigrationController {
  private readonly logger = new Logger(CustomerMigrationController.name);

  constructor(
    private readonly orchestrator: CustomerMigrationOrchestratorService,
    private readonly cleanup: CustomerMigrationCleanupService,
  ) {}

  @Post(":monolithCustomerId")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Push-migrate a single customer to billing service",
  })
  @ApiOkResponse({ description: "Migration result with per-step status" })
  async migrate(
    @Param("monolithCustomerId") monolithCustomerId: string,
    @Body() body: MigrateCustomerBodyDto,
  ): Promise<OrchestratorResult> {
    this.logger.log({
      action: "customer-migration.controller.migrate",
      monolithCustomerId,
      dryRun: body.dryRun === true,
    });
    return this.orchestrator.migrate(monolithCustomerId, body);
  }

  @Post(":monolithCustomerId/rollback")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Roll back a migrated customer" })
  @ApiOkResponse({ description: "Rollback result" })
  async rollback(
    @Param("monolithCustomerId") monolithCustomerId: string,
    @Body() _body: RollbackCustomerBodyDto,
  ): Promise<CleanupResult> {
    void _body;
    this.logger.log({
      action: "customer-migration.controller.rollback",
      monolithCustomerId,
    });
    return this.cleanup.rollback(monolithCustomerId);
  }
}
