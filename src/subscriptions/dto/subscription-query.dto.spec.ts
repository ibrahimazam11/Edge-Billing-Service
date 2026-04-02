import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { SubscriptionQueryDto } from "./subscription-query.dto";

describe("SubscriptionQueryDto", () => {
  function createDto(partial: Record<string, unknown>): SubscriptionQueryDto {
    return plainToInstance(SubscriptionQueryDto, partial);
  }

  it("should accept valid status values", async () => {
    for (const status of [
      "pending",
      "active",
      "paused",
      "canceled",
      "past_due",
    ]) {
      const dto = createDto({ status });
      const errors = await validate(dto);
      const statusErrors = errors.filter((e) => e.property === "status");
      expect(statusErrors).toHaveLength(0);
    }
  });

  it("should reject invalid status values", async () => {
    const dto = createDto({ status: "invalid-status" });
    const errors = await validate(dto);
    const statusErrors = errors.filter((e) => e.property === "status");
    expect(statusErrors.length).toBeGreaterThan(0);
  });

  it("should accept valid ISO 8601 date strings for startDate", async () => {
    const dto = createDto({ startDate: "2026-01-15T00:00:00.000Z" });
    const errors = await validate(dto);
    const dateErrors = errors.filter((e) => e.property === "startDate");
    expect(dateErrors).toHaveLength(0);
  });

  it("should accept valid ISO 8601 date strings for endDate", async () => {
    const dto = createDto({ endDate: "2026-12-31T23:59:59.999Z" });
    const errors = await validate(dto);
    const dateErrors = errors.filter((e) => e.property === "endDate");
    expect(dateErrors).toHaveLength(0);
  });

  it("should reject invalid date strings for startDate", async () => {
    const dto = createDto({ startDate: "not-a-date" });
    const errors = await validate(dto);
    const dateErrors = errors.filter((e) => e.property === "startDate");
    expect(dateErrors.length).toBeGreaterThan(0);
  });

  it("should reject invalid date strings for endDate", async () => {
    const dto = createDto({ endDate: "invalid" });
    const errors = await validate(dto);
    const dateErrors = errors.filter((e) => e.property === "endDate");
    expect(dateErrors.length).toBeGreaterThan(0);
  });

  it("should accept empty query (all filters optional)", async () => {
    const dto = createDto({});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("should accept startDate and endDate together", async () => {
    const dto = createDto({
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-06-30T23:59:59.999Z",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("should accept all filters combined", async () => {
    const dto = createDto({
      customerId: "a0000000-0000-4000-a000-000000000001",
      status: "active",
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-06-30T23:59:59.999Z",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
