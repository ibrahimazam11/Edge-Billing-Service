import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { IssueCreditNoteDto } from "./issue-credit-note.dto";

describe("IssueCreditNoteDto", () => {
  const validData = {
    customerId: "c0000000-0000-4000-a000-000000000001",
    invoiceId: "a0000000-0000-4000-a000-000000000010",
    amountCents: 2000,
    reason: "Billing adjustment",
    createdBy: "admin-user",
  };

  it("should accept valid data", async () => {
    const dto = plainToInstance(IssueCreditNoteDto, validData);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("should accept valid data without optional createdBy", async () => {
    const data = { ...validData };
    delete (data as Record<string, unknown>).createdBy;
    const dto = plainToInstance(IssueCreditNoteDto, data);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("should reject missing customerId", async () => {
    const data = { ...validData };
    delete (data as Record<string, unknown>).customerId;
    const dto = plainToInstance(IssueCreditNoteDto, data);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === "customerId")).toBe(true);
  });

  it("should reject invalid customerId format", async () => {
    const dto = plainToInstance(IssueCreditNoteDto, {
      ...validData,
      customerId: "not-a-uuid",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "customerId")).toBe(true);
  });

  it("should accept missing invoiceId (optional — general account credit)", async () => {
    const data = { ...validData };
    delete (data as Record<string, unknown>).invoiceId;
    const dto = plainToInstance(IssueCreditNoteDto, data);
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "invoiceId")).toBe(false);
  });

  it("should reject invalid invoiceId format", async () => {
    const dto = plainToInstance(IssueCreditNoteDto, {
      ...validData,
      invoiceId: "not-a-uuid",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "invoiceId")).toBe(true);
  });

  it("should reject non-integer amountCents", async () => {
    const dto = plainToInstance(IssueCreditNoteDto, {
      ...validData,
      amountCents: 20.5,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "amountCents")).toBe(true);
  });

  it("should reject zero amountCents", async () => {
    const dto = plainToInstance(IssueCreditNoteDto, {
      ...validData,
      amountCents: 0,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "amountCents")).toBe(true);
  });

  it("should reject negative amountCents", async () => {
    const dto = plainToInstance(IssueCreditNoteDto, {
      ...validData,
      amountCents: -100,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "amountCents")).toBe(true);
  });

  it("should reject empty reason", async () => {
    const dto = plainToInstance(IssueCreditNoteDto, {
      ...validData,
      reason: "",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "reason")).toBe(true);
  });

  it("should reject missing reason", async () => {
    const data = { ...validData };
    delete (data as Record<string, unknown>).reason;
    const dto = plainToInstance(IssueCreditNoteDto, data);
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "reason")).toBe(true);
  });
});
