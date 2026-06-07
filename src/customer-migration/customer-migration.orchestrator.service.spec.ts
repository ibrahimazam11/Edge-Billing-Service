import { CustomerMigrationOrchestratorService } from "./customer-migration.orchestrator.service";
import type { CustomersRepository } from "../customers/customers.repository";
import type { PaymentSettingsWriter } from "./writers/payment-settings.writer";
import type { CreditBalanceWriter } from "./writers/credit-balance.writer";
import type { SurchargeWriter } from "./writers/surcharge.writer";
import type { PayrollsWriter } from "./writers/payrolls.writer";
import type { ChargesWriter } from "./writers/charges.writer";
import type { SubscriptionWriter } from "./writers/subscription.writer";
import type { CustomerMigrationLogsRepository } from "./customer-migration-logs.repository";
import type { MigrateCustomerBodyDto } from "./dto/migrate-customer-body.dto";

function makeBody(over: Partial<MigrateCustomerBodyDto> = {}): MigrateCustomerBodyDto {
  return {
    customer: {
      monolithCustomerId: "mono-1",
      companyName: "Acme",
      contactEmail: "a@a.com",
      trialEndDate: 15,
      isPrepaid: true,
      status: "enabled",
    },
    paymentSettings: {
      stripeCustomerId: "cus_1",
      paymentMethodType: "ACH",
      subscriptionId: "sub_1",
    },
    latestPayroll: { totalAmount: "1000", payrollMonth: "2026-05-01" },
    payrolls: [],
    charges: [],
    ...over,
  };
}

describe("CustomerMigrationOrchestratorService", () => {
  let svc: CustomerMigrationOrchestratorService;
  let customersRepo: { findByMonolithId: jest.Mock };
  let psWriter: { write: jest.Mock };
  let cbWriter: { write: jest.Mock };
  let surWriter: { write: jest.Mock };
  let payWriter: { write: jest.Mock };
  let chWriter: { write: jest.Mock };
  let subWriter: { write: jest.Mock };
  let logsRepo: { writeStepLog: jest.Mock };

  beforeEach(() => {
    customersRepo = { findByMonolithId: jest.fn().mockResolvedValue(null) };
    psWriter = {
      write: jest.fn().mockResolvedValue({
        status: "succeeded",
        billingCustomerId: "bc-1",
      }),
    };
    cbWriter = {
      write: jest.fn().mockResolvedValue({ status: "skipped", reason: "no_credit" }),
    };
    surWriter = {
      write: jest.fn().mockResolvedValue({ status: "skipped", reason: "no_config" }),
    };
    payWriter = {
      write: jest.fn().mockResolvedValue({ status: "skipped", reason: "no_payrolls" }),
    };
    chWriter = {
      write: jest.fn().mockResolvedValue({ status: "skipped", reason: "no_charges" }),
    };
    subWriter = {
      write: jest.fn().mockResolvedValue({ status: "succeeded" }),
    };
    logsRepo = { writeStepLog: jest.fn().mockResolvedValue(undefined) };

    svc = new CustomerMigrationOrchestratorService(
      customersRepo as unknown as CustomersRepository,
      psWriter as unknown as PaymentSettingsWriter,
      cbWriter as unknown as CreditBalanceWriter,
      surWriter as unknown as SurchargeWriter,
      payWriter as unknown as PayrollsWriter,
      chWriter as unknown as ChargesWriter,
      subWriter as unknown as SubscriptionWriter,
      logsRepo as unknown as CustomerMigrationLogsRepository,
    );
  });

  it("happy path returns succeeded with all step results", async () => {
    const r = await svc.migrate("mono-1", makeBody());
    expect(r.status).toBe("succeeded");
    expect(r.billingCustomerId).toBe("bc-1");
    expect(Object.keys(r.stepResults).sort()).toEqual(
      [
        "charges",
        "creditBalance",
        "paymentSettings",
        "payrolls",
        "subscription",
        "surcharge",
      ].sort(),
    );
  });

  it("already-migrated short-circuit returns skipped with all six skipped step results", async () => {
    customersRepo.findByMonolithId.mockResolvedValueOnce({ id: "bc-existing" });
    const r = await svc.migrate("mono-1", makeBody());
    expect(r.status).toBe("skipped");
    expect(r.billingCustomerId).toBe("bc-existing");
    expect(r.stepResults.paymentSettings?.status).toBe("skipped");
    expect(r.stepResults.subscription?.status).toBe("skipped");
    expect(psWriter.write).not.toHaveBeenCalled();
  });

  it("short-circuits on payment-settings failure", async () => {
    psWriter.write.mockResolvedValueOnce({
      status: "failed",
      reason: "payment_method_type_unsupported",
    });
    const r = await svc.migrate("mono-1", makeBody());
    expect(r.status).toBe("failed");
    expect(r.failedStep).toBe("paymentSettings");
    expect(cbWriter.write).not.toHaveBeenCalled();
  });

  it("short-circuits on subscription failure (mid-step)", async () => {
    subWriter.write.mockResolvedValueOnce({
      status: "failed",
      reason: "subscription_conflict",
    });
    const r = await svc.migrate("mono-1", makeBody());
    expect(r.status).toBe("failed");
    expect(r.failedStep).toBe("subscription");
    expect(r.reason).toBe("subscription_conflict");
  });

  it("P7: dry-run runs all six writers even when billingCustomerId is undefined", async () => {
    psWriter.write.mockResolvedValueOnce({
      status: "succeeded",
      dryRun: true,
      billingCustomerId: "<dry-run>",
      planned: {},
    });
    const body = makeBody({ dryRun: true });
    const r = await svc.migrate("mono-1", body);
    expect(r.status).toBe("succeeded");
    // All six writers must have been called
    expect(psWriter.write).toHaveBeenCalled();
    expect(cbWriter.write).toHaveBeenCalled();
    expect(surWriter.write).toHaveBeenCalled();
    expect(payWriter.write).toHaveBeenCalled();
    expect(chWriter.write).toHaveBeenCalled();
    expect(subWriter.write).toHaveBeenCalled();
    expect(Object.keys(r.stepResults).length).toBe(6);
  });

  it("Bug 2 fix: dry-run on already-migrated customer reports six skipped steps", async () => {
    customersRepo.findByMonolithId.mockResolvedValueOnce({ id: "bc-existing" });
    const r = await svc.migrate("mono-1", makeBody({ dryRun: true }));
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("already_migrated");
    expect(r.billingCustomerId).toBe("bc-existing");
    expect(Object.keys(r.stepResults).length).toBe(6);
    expect(r.stepResults.paymentSettings).toEqual({
      status: "skipped",
      reason: "already_migrated",
    });
    expect(r.stepResults.creditBalance).toEqual({
      status: "skipped",
      reason: "already_migrated",
    });
    expect(r.stepResults.surcharge).toEqual({
      status: "skipped",
      reason: "already_migrated",
    });
    expect(r.stepResults.payrolls).toEqual({
      status: "skipped",
      reason: "already_migrated",
    });
    expect(r.stepResults.charges).toEqual({
      status: "skipped",
      reason: "already_migrated",
    });
    expect(r.stepResults.subscription).toEqual({
      status: "skipped",
      reason: "already_migrated",
    });
    // No individual writer should have been invoked (whole-flow short-circuit)
    expect(psWriter.write).not.toHaveBeenCalled();
  });

  it("Bug 3 fix: dry-run continues on writer failure and reports all six step results", async () => {
    psWriter.write.mockResolvedValueOnce({
      status: "succeeded",
      dryRun: true,
      billingCustomerId: "<dry-run>",
      planned: {},
    });
    cbWriter.write.mockResolvedValueOnce({
      status: "failed",
      reason: "issue_credit_note_failed",
    });
    const r = await svc.migrate("mono-1", makeBody({ dryRun: true }));
    expect(r.status).toBe("failed");
    expect(r.failedStep).toBe("creditBalance");
    // All six writers must have been called even after the failure
    expect(psWriter.write).toHaveBeenCalled();
    expect(cbWriter.write).toHaveBeenCalled();
    expect(surWriter.write).toHaveBeenCalled();
    expect(payWriter.write).toHaveBeenCalled();
    expect(chWriter.write).toHaveBeenCalled();
    expect(subWriter.write).toHaveBeenCalled();
    expect(Object.keys(r.stepResults).length).toBe(6);
    expect(r.stepResults.creditBalance?.status).toBe("failed");
  });

  it("Bug 1 fix: dry-run does not write to migration_logs", async () => {
    psWriter.write.mockResolvedValueOnce({
      status: "succeeded",
      dryRun: true,
      billingCustomerId: "<dry-run>",
      planned: {},
    });
    await svc.migrate("mono-1", makeBody({ dryRun: true }));
    expect(logsRepo.writeStepLog).not.toHaveBeenCalled();
  });

  it("Bug 1 fix: dry-run on already-migrated customer does not write to migration_logs", async () => {
    customersRepo.findByMonolithId.mockResolvedValueOnce({ id: "bc-existing" });
    await svc.migrate("mono-1", makeBody({ dryRun: true }));
    expect(logsRepo.writeStepLog).not.toHaveBeenCalled();
  });

  it("Bug 1 confirmation: real-run still writes to migration_logs", async () => {
    await svc.migrate("mono-1", makeBody());
    expect(logsRepo.writeStepLog).toHaveBeenCalled();
  });
});
