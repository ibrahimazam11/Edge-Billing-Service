import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpsertSurchargeConfigDto } from "./upsert-surcharge-config.dto";

describe("UpsertSurchargeConfigDto", () => {
  async function validateDto(
    plain: Record<string, unknown>,
  ): Promise<string[]> {
    const dto = plainToInstance(UpsertSurchargeConfigDto, plain);
    const errors = await validate(dto);
    return errors.flatMap((e) => Object.keys(e.constraints ?? {}));
  }

  it("should accept valid dto with all fields", async () => {
    const errors = await validateDto({
      allowCreditCard: true,
      surchargeType: "percentage",
      surchargeValue: 350,
      reason: "Convenience fee",
      notes: "Standard rate",
      enabledBy: "admin-1",
    });
    expect(errors).toHaveLength(0);
  });

  it("should accept valid dto with only required fields", async () => {
    const errors = await validateDto({
      allowCreditCard: false,
    });
    expect(errors).toHaveLength(0);
  });

  it("should reject missing allowCreditCard", async () => {
    const errors = await validateDto({});
    expect(errors).toContain("isBoolean");
  });

  it("should reject non-boolean allowCreditCard", async () => {
    const errors = await validateDto({ allowCreditCard: "yes" });
    expect(errors).toContain("isBoolean");
  });

  it("should accept surchargeType 'percentage' with surchargeValue", async () => {
    const errors = await validateDto({
      allowCreditCard: true,
      surchargeType: "percentage",
      surchargeValue: 350,
    });
    expect(errors).toHaveLength(0);
  });

  it("should accept surchargeType 'flat_fee' with surchargeValue", async () => {
    const errors = await validateDto({
      allowCreditCard: true,
      surchargeType: "flat_fee",
      surchargeValue: 500,
    });
    expect(errors).toHaveLength(0);
  });

  it("should reject invalid surchargeType", async () => {
    const errors = await validateDto({
      allowCreditCard: true,
      surchargeType: "invalid",
      surchargeValue: 350,
    });
    expect(errors).toContain("isIn");
  });

  it("should reject surchargeType without surchargeValue", async () => {
    const errors = await validateDto({
      allowCreditCard: true,
      surchargeType: "percentage",
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("should reject surchargeValue without surchargeType", async () => {
    const errors = await validateDto({
      allowCreditCard: true,
      surchargeValue: 350,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("should reject non-integer surchargeValue", async () => {
    const errors = await validateDto({
      allowCreditCard: true,
      surchargeValue: 3.5,
    });
    expect(errors).toContain("isInt");
  });

  it("should reject negative surchargeValue", async () => {
    const errors = await validateDto({
      allowCreditCard: true,
      surchargeValue: -100,
    });
    expect(errors).toContain("min");
  });

  it("should accept surchargeValue of 0", async () => {
    const errors = await validateDto({
      allowCreditCard: true,
      surchargeType: "flat_fee",
      surchargeValue: 0,
    });
    expect(errors).toHaveLength(0);
  });

  it("should reject non-string reason", async () => {
    const errors = await validateDto({
      allowCreditCard: true,
      reason: 123,
    });
    expect(errors).toContain("isString");
  });

  it("should reject non-string notes", async () => {
    const errors = await validateDto({
      allowCreditCard: true,
      notes: 456,
    });
    expect(errors).toContain("isString");
  });

  it("should reject non-string enabledBy", async () => {
    const errors = await validateDto({
      allowCreditCard: true,
      enabledBy: 789,
    });
    expect(errors).toContain("isString");
  });
});
