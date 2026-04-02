import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { RevenueQueryDto } from "./revenue-query.dto";

describe("RevenueQueryDto", () => {
  async function validateDto(data: Record<string, unknown>): Promise<string[]> {
    const dto = plainToInstance(RevenueQueryDto, data);
    const errors = await validate(dto);
    return errors.map((e) => e.property);
  }

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

  it("should reject missing startDate", async () => {
    const errors = await validateDto({
      endDate: "2026-02-01",
    });
    expect(errors).toContain("startDate");
  });

  it("should reject missing endDate", async () => {
    const errors = await validateDto({
      startDate: "2026-01-01",
    });
    expect(errors).toContain("endDate");
  });

  it("should reject invalid date format", async () => {
    const errors = await validateDto({
      startDate: "not-a-date",
      endDate: "2026-02-01",
    });
    expect(errors).toContain("startDate");
  });
});
