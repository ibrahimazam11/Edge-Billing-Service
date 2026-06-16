import { CustomerMigrationLogsRepository } from "./customer-migration-logs.repository";

describe("CustomerMigrationLogsRepository", () => {
  let repo: CustomerMigrationLogsRepository;
  let valuesMock: jest.Mock;
  let insertMock: jest.Mock;

  beforeEach(() => {
    valuesMock = jest.fn().mockResolvedValue(undefined);
    insertMock = jest.fn().mockReturnValue({ values: valuesMock });
    const db = { insert: insertMock };
    repo = new CustomerMigrationLogsRepository(db as never);
  });

  it("writes a row with given runId and scriptName", async () => {
    await repo.writeStepLog({
      runId: "run-1",
      scriptName: "customer-migration-paymentSettings",
      monolithCustomerId: "mono-1",
      billingCustomerId: "bc-1",
      status: "succeeded",
      details: { foo: "bar" },
    });
    expect(insertMock).toHaveBeenCalled();
    const args = valuesMock.mock.calls[0][0];
    expect(args.runId).toBe("run-1");
    expect(args.scriptName).toBe("customer-migration-paymentSettings");
    expect(args.status).toBe("succeeded");
    expect(args.billingCustomerId).toBe("bc-1");
    expect(args.details).toEqual({ foo: "bar" });
  });
});
