import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { DunningQueryDto } from "./dunning-query.dto";

describe("DunningQueryDto", () => {
  async function validateDto(data: Record<string, unknown>): Promise<string[]> {
    const dto = plainToInstance(DunningQueryDto, data);
    const errors = await validate(dto);
    return errors.map((e) => e.property);
  }

  it("should accept missing dates (both optional)", async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it("should accept valid ISO 8601 dates", async () => {
    const errors = await validateDto({
      startDate: "2026-01-01",
      endDate: "2026-02-01",
    });
    expect(errors).toHaveLength(0);
  });

  it("should accept full ISO 8601 datetime strings", async () => {
    const errors = await validateDto({
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-02-01T00:00:00.000Z",
    });
    expect(errors).toHaveLength(0);
  });

  it("should accept only startDate provided", async () => {
    const errors = await validateDto({
      startDate: "2026-01-01",
    });
    expect(errors).toHaveLength(0);
  });

  it("should accept only endDate provided", async () => {
    const errors = await validateDto({
      endDate: "2026-02-01",
    });
    expect(errors).toHaveLength(0);
  });

  it("should reject invalid startDate format", async () => {
    const errors = await validateDto({
      startDate: "not-a-date",
      endDate: "2026-02-01",
    });
    expect(errors).toContain("startDate");
  });

  it("should reject invalid endDate format", async () => {
    const errors = await validateDto({
      startDate: "2026-01-01",
      endDate: "invalid",
    });
    expect(errors).toContain("endDate");
  });
});
