import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ReconciliationQueryDto } from "./reconciliation-query.dto";

describe("ReconciliationQueryDto", () => {
  async function validateDto(data: Record<string, unknown>): Promise<string[]> {
    const dto = plainToInstance(ReconciliationQueryDto, data);
    const errors = await validate(dto);
    return errors.map((e) => e.property);
  }

  it("should accept empty query (all filters optional)", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("should accept valid status filter", async () => {
    const errors = await validateDto({ status: "balanced" });
    expect(errors).toHaveLength(0);
  });

  it("should accept discrepancy_found status", async () => {
    const errors = await validateDto({ status: "discrepancy_found" });
    expect(errors).toHaveLength(0);
  });

  it("should accept failed status", async () => {
    const errors = await validateDto({ status: "failed" });
    expect(errors).toHaveLength(0);
  });

  it("should reject invalid status", async () => {
    const errors = await validateDto({ status: "invalid" });
    expect(errors).toContain("status");
  });

  it("should accept valid date range", async () => {
    const errors = await validateDto({
      startDate: "2026-01-01",
      endDate: "2026-02-01",
    });
    expect(errors).toHaveLength(0);
  });

  it("should reject invalid startDate format", async () => {
    const errors = await validateDto({ startDate: "not-a-date" });
    expect(errors).toContain("startDate");
  });

  it("should accept valid pagination limit", async () => {
    const errors = await validateDto({ limit: 50 });
    expect(errors).toHaveLength(0);
  });

  it("should reject limit below 1", async () => {
    const errors = await validateDto({ limit: 0 });
    expect(errors).toContain("limit");
  });

  it("should reject limit above 100", async () => {
    const errors = await validateDto({ limit: 101 });
    expect(errors).toContain("limit");
  });
});
