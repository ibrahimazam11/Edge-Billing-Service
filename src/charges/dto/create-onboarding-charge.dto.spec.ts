import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateOnboardingChargeDto } from "./create-onboarding-charge.dto";

describe("CreateOnboardingChargeDto", () => {
  const validData = {
    customerId: "a0000000-0000-4000-a000-000000000001",
    amountCents: 15000,
    description: "Onboarding implementation fee",
    scheduledDate: "2026-03-01",
  };

  it("should pass with valid data", async () => {
    const dto = plainToInstance(CreateOnboardingChargeDto, validData);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("should fail when customerId is not a UUID", async () => {
    const dto = plainToInstance(CreateOnboardingChargeDto, {
      ...validData,
      customerId: "not-a-uuid",
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("customerId");
  });

  it("should fail when amountCents is zero", async () => {
    const dto = plainToInstance(CreateOnboardingChargeDto, {
      ...validData,
      amountCents: 0,
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("amountCents");
  });

  it("should fail when amountCents is not an integer", async () => {
    const dto = plainToInstance(CreateOnboardingChargeDto, {
      ...validData,
      amountCents: 50.5,
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("amountCents");
  });

  it("should fail when description is empty", async () => {
    const dto = plainToInstance(CreateOnboardingChargeDto, {
      ...validData,
      description: "",
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("description");
  });

  it("should fail when scheduledDate is not a valid date string", async () => {
    const dto = plainToInstance(CreateOnboardingChargeDto, {
      ...validData,
      scheduledDate: "not-a-date",
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("scheduledDate");
  });

  it("should fail when scheduledDate is missing", async () => {
    const withoutDate = {
      customerId: validData.customerId,
      amountCents: validData.amountCents,
      description: validData.description,
    };
    const dto = plainToInstance(CreateOnboardingChargeDto, withoutDate);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === "scheduledDate")).toBe(true);
  });

  it("should pass with ISO date-time format", async () => {
    const dto = plainToInstance(CreateOnboardingChargeDto, {
      ...validData,
      scheduledDate: "2026-03-01T00:00:00.000Z",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
