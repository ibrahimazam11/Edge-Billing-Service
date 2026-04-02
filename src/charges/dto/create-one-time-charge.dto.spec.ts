import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateOneTimeChargeDto } from "./create-one-time-charge.dto";

describe("CreateOneTimeChargeDto", () => {
  const validData = {
    customerId: "a0000000-0000-4000-a000-000000000001",
    amountCents: 5000,
    description: "Setup fee",
  };

  it("should pass with valid data", async () => {
    const dto = plainToInstance(CreateOneTimeChargeDto, validData);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("should pass with optional paymentMethodId", async () => {
    const dto = plainToInstance(CreateOneTimeChargeDto, {
      ...validData,
      paymentMethodId: "b0000000-0000-4000-a000-000000000002",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("should fail when customerId is not a UUID", async () => {
    const dto = plainToInstance(CreateOneTimeChargeDto, {
      ...validData,
      customerId: "not-a-uuid",
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("customerId");
  });

  it("should fail when amountCents is zero", async () => {
    const dto = plainToInstance(CreateOneTimeChargeDto, {
      ...validData,
      amountCents: 0,
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("amountCents");
  });

  it("should fail when amountCents is negative", async () => {
    const dto = plainToInstance(CreateOneTimeChargeDto, {
      ...validData,
      amountCents: -100,
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("amountCents");
  });

  it("should fail when amountCents is not an integer", async () => {
    const dto = plainToInstance(CreateOneTimeChargeDto, {
      ...validData,
      amountCents: 50.5,
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("amountCents");
  });

  it("should fail when description is empty", async () => {
    const dto = plainToInstance(CreateOneTimeChargeDto, {
      ...validData,
      description: "",
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("description");
  });

  it("should fail when description is missing", async () => {
    const withoutDesc = {
      customerId: validData.customerId,
      amountCents: validData.amountCents,
    };
    const dto = plainToInstance(CreateOneTimeChargeDto, withoutDesc);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === "description")).toBe(true);
  });

  it("should fail when paymentMethodId is not a UUID", async () => {
    const dto = plainToInstance(CreateOneTimeChargeDto, {
      ...validData,
      paymentMethodId: "not-a-uuid",
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("paymentMethodId");
  });
});
