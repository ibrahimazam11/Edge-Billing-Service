import { SurchargeWriter } from "./surcharge.writer";
import type { SurchargeConfigRepository } from "../../surcharges/surcharge-config.repository";

describe("SurchargeWriter", () => {
  let writer: SurchargeWriter;
  let mockRepo: { findByCustomer: jest.Mock; upsert: jest.Mock };

  beforeEach(() => {
    mockRepo = {
      findByCustomer: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    };
    writer = new SurchargeWriter(
      mockRepo as unknown as SurchargeConfigRepository,
    );
  });

  it("skips when surchargeConfig is null", async () => {
    const result = await writer.write(
      { billingCustomerId: "bc-1", surchargeConfig: null },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_config");
  });

  it("maps Percentage to percentage and converts value", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        surchargeConfig: {
          allowCreditCard: true,
          surchargeType: "Percentage",
          surchargeValue: "3.5",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect(mockRepo.upsert).toHaveBeenCalledWith(
      "bc-1",
      expect.objectContaining({
        surchargeType: "percentage",
        surchargeValue: 350,
      }),
    );
  });

  it("maps Flat_Rate to flat_fee", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        surchargeConfig: {
          allowCreditCard: true,
          surchargeType: "Flat_Rate",
          surchargeValue: "5.00",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect(mockRepo.upsert).toHaveBeenCalledWith(
      "bc-1",
      expect.objectContaining({
        surchargeType: "flat_fee",
        surchargeValue: 500,
      }),
    );
  });

  it("skips when already_migrated", async () => {
    mockRepo.findByCustomer.mockResolvedValueOnce({ id: "existing" });
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        surchargeConfig: {
          allowCreditCard: true,
          surchargeType: "Percentage",
          surchargeValue: "3.5",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("already_migrated");
  });

  it("Bug 2 fix: dry-run on already-existing target returns already_migrated", async () => {
    mockRepo.findByCustomer.mockResolvedValueOnce({ id: "existing" });
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        surchargeConfig: {
          allowCreditCard: true,
          surchargeType: "Percentage",
          surchargeValue: "3.5",
        },
      },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("already_migrated");
    expect(mockRepo.upsert).not.toHaveBeenCalled();
  });

  it("P3: fails cleanly when surchargeValue is non-numeric", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        surchargeConfig: {
          allowCreditCard: true,
          surchargeType: "Percentage",
          surchargeValue: "abc",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("invalid_surcharge_value");
  });

  // -------------------------------------------------------------------------
  // Dry-run sentinel guard
  // (spec-billing-migration-dry-run-sentinel-idempotency.md)
  // -------------------------------------------------------------------------

  it("dry-run with sentinel billingCustomerId skips the BS-DB idempotency lookup (does not crash on UUID type)", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "<dry-run>",
        surchargeConfig: {
          allowCreditCard: true,
          surchargeType: "Percentage",
          surchargeValue: "3.5",
        },
      },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect((result as { dryRun?: boolean }).dryRun).toBe(true);
    // Critical: lookup must not be invoked with the sentinel — Postgres would
    // reject "<dry-run>" against a UUID column.
    expect(mockRepo.findByCustomer).not.toHaveBeenCalled();
    expect(mockRepo.upsert).not.toHaveBeenCalled();
  });

  it("dry-run with real billingCustomerId still runs the BS-DB idempotency lookup", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "11111111-1111-1111-1111-111111111111",
        surchargeConfig: {
          allowCreditCard: true,
          surchargeType: "Percentage",
          surchargeValue: "3.5",
        },
      },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect(mockRepo.findByCustomer).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
    );
    expect(mockRepo.upsert).not.toHaveBeenCalled();
  });
});
