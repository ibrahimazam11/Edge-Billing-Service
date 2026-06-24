import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { InvoiceQueryDto } from "./invoice-query.dto";

describe("InvoiceQueryDto", () => {
  function createDto(partial: Record<string, unknown>): InvoiceQueryDto {
    return plainToInstance(InvoiceQueryDto, partial);
  }

  it("leaves limit undefined when not supplied (no silent 20-row cap)", () => {
    // Regression guard for Fix 1: PaginationDto.limit defaults to 20, which
    // silently truncated customer payment history. The override must drop that
    // default so the service can return the full customer set instead.
    const dto = createDto({
      customerId: "a0000000-0000-4000-a000-000000000001",
    });
    expect(dto.limit).toBeUndefined();
  });

  it("preserves an explicit limit (cursor-paginated callers keep control)", () => {
    const dto = createDto({ limit: 5 });
    expect(dto.limit).toBe(5);
  });

  it("accepts a limit above the old 100 cap (Max(100) removed for this listing)", async () => {
    const dto = createDto({ limit: 150 });
    const errors = await validate(dto);
    const limitErrors = errors.filter((e) => e.property === "limit");
    expect(limitErrors).toHaveLength(0);
    expect(dto.limit).toBe(150);
  });

  it("still rejects a limit below 1 (Min(1) retained)", async () => {
    const dto = createDto({ limit: 0 });
    const errors = await validate(dto);
    const limitErrors = errors.filter((e) => e.property === "limit");
    expect(limitErrors.length).toBeGreaterThan(0);
  });

  it("accepts an empty query (all filters optional)", async () => {
    const dto = createDto({});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBeUndefined();
  });

  it("rejects a non-UUID customerId", async () => {
    const dto = createDto({ customerId: "not-a-uuid" });
    const errors = await validate(dto);
    const customerIdErrors = errors.filter((e) => e.property === "customerId");
    expect(customerIdErrors.length).toBeGreaterThan(0);
  });
});
