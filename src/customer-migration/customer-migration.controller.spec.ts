import { CustomerMigrationController } from "./customer-migration.controller";
import type { CustomerMigrationOrchestratorService } from "./customer-migration.orchestrator.service";
import type { CustomerMigrationCleanupService } from "./customer-migration-cleanup.service";
import type { MigrateCustomerBodyDto } from "./dto/migrate-customer-body.dto";

describe("CustomerMigrationController", () => {
  let controller: CustomerMigrationController;
  let orchestrator: { migrate: jest.Mock };
  let cleanup: { rollback: jest.Mock };

  beforeEach(() => {
    orchestrator = {
      migrate: jest.fn().mockResolvedValue({ status: "succeeded" }),
    };
    cleanup = {
      rollback: jest.fn().mockResolvedValue({ status: "succeeded" }),
    };
    controller = new CustomerMigrationController(
      orchestrator as unknown as CustomerMigrationOrchestratorService,
      cleanup as unknown as CustomerMigrationCleanupService,
    );
  });

  it("delegates POST /:id to orchestrator", async () => {
    const body = {} as MigrateCustomerBodyDto;
    const r = await controller.migrate("mono-1", body);
    expect(orchestrator.migrate).toHaveBeenCalledWith("mono-1", body);
    expect(r).toEqual({ status: "succeeded" });
  });

  it("delegates POST /:id/rollback to cleanup", async () => {
    const r = await controller.rollback("mono-1", {});
    expect(cleanup.rollback).toHaveBeenCalledWith("mono-1");
    expect(r).toEqual({ status: "succeeded" });
  });
});
