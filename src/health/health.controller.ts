import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiOkResponse } from "@nestjs/swagger";
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
  HealthIndicatorResult,
} from "@nestjs/terminus";
import { DatabaseHealthRepository } from "../database/database-health.repository";
import { Public } from "../common/decorators/public.decorator";

@ApiTags("Health")
@Controller()
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private databaseHealthRepository: DatabaseHealthRepository,
  ) {}

  @Public()
  @Get("health")
  @HealthCheck()
  @ApiOperation({ summary: "Liveness check" })
  @ApiOkResponse({ description: "Service is healthy" })
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      async (): Promise<HealthIndicatorResult> => {
        try {
          await this.databaseHealthRepository.ping();
          return { database: { status: "up" } };
        } catch {
          return { database: { status: "down" } };
        }
      },
    ]);
  }

  @Public()
  @Get("ready")
  @HealthCheck()
  @ApiOperation({ summary: "Readiness check" })
  @ApiOkResponse({ description: "Service is healthy" })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      async (): Promise<HealthIndicatorResult> => {
        await this.databaseHealthRepository.ping();
        return { database: { status: "up" } };
      },
    ]);
  }
}
