import { INestApplication } from "@nestjs/common";
import { createTestApp } from "./helpers/test-app";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  seedCustomer,
  seedSurchargeConfig,
} from "./helpers/database";
import { SurchargeConfigService } from "../src/surcharges/surcharge-config.service";

const CUSTOMER_A = {
  id: "c0000000-0000-4000-a000-000000000001",
  monolithCustomerId: "mono-sc-001",
  name: "Surcharge Customer A",
  email: "sc-a@example.com",
};

const CUSTOMER_B = {
  id: "c0000000-0000-4000-a000-000000000002",
  monolithCustomerId: "mono-sc-002",
  name: "Surcharge Customer B",
  email: "sc-b@example.com",
};

describe("Surcharge Configs (e2e)", () => {
  let app: INestApplication;
  let surchargeConfigService: SurchargeConfigService;

  beforeAll(async () => {
    await setupTestDatabase();
    app = await createTestApp();
    surchargeConfigService = app.get(SurchargeConfigService);
  });

  afterAll(async () => {
    await app.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedCustomer(CUSTOMER_A);
    await seedCustomer(CUSTOMER_B);
  });

  describe("getConfig", () => {
    it("should return config when it exists", async () => {
      await seedSurchargeConfig({
        id: "d0000000-0000-4000-a000-000000000001",
        customerId: CUSTOMER_A.id,
        allowCreditCard: true,
        surchargeType: "percentage",
        surchargeValue: 350,
        reason: "Convenience fee",
        notes: "Standard rate",
        enabledBy: "admin-1",
      });

      const result = await surchargeConfigService.getConfig(CUSTOMER_A.id);

      expect(result).not.toBeNull();
      expect(result!.customerId).toBe(CUSTOMER_A.id);
      expect(result!.allowCreditCard).toBe(true);
      expect(result!.surchargeType).toBe("percentage");
      expect(result!.surchargeValue).toBe(350);
      expect(result!.reason).toBe("Convenience fee");
      expect(result!.notes).toBe("Standard rate");
      expect(result!.enabledBy).toBe("admin-1");
    });

    it("should return null when no config exists", async () => {
      const result = await surchargeConfigService.getConfig(CUSTOMER_A.id);

      expect(result).toBeNull();
    });

    it("adversarial: should NOT return config from a different customer", async () => {
      // Seed config for Customer B only
      await seedSurchargeConfig({
        id: "d0000000-0000-4000-a000-000000000002",
        customerId: CUSTOMER_B.id,
        allowCreditCard: true,
        surchargeType: "flat_fee",
        surchargeValue: 500,
      });

      // Query Customer A — should be null
      const result = await surchargeConfigService.getConfig(CUSTOMER_A.id);
      expect(result).toBeNull();
    });
  });

  describe("upsertConfig", () => {
    it("should create a new config", async () => {
      const result = await surchargeConfigService.upsertConfig(CUSTOMER_A.id, {
        allowCreditCard: true,
        surchargeType: "percentage",
        surchargeValue: 350,
        reason: "Convenience fee",
        notes: "Standard rate",
        enabledBy: "admin-1",
      });

      expect(result.customerId).toBe(CUSTOMER_A.id);
      expect(result.allowCreditCard).toBe(true);
      expect(result.surchargeType).toBe("percentage");
      expect(result.surchargeValue).toBe(350);
    });

    it("should update an existing config", async () => {
      await seedSurchargeConfig({
        id: "d0000000-0000-4000-a000-000000000003",
        customerId: CUSTOMER_A.id,
        allowCreditCard: false,
        surchargeType: "percentage",
        surchargeValue: 200,
      });

      const result = await surchargeConfigService.upsertConfig(CUSTOMER_A.id, {
        allowCreditCard: true,
        surchargeType: "flat_fee",
        surchargeValue: 500,
        reason: "Updated fee",
      });

      expect(result.allowCreditCard).toBe(true);
      expect(result.surchargeType).toBe("flat_fee");
      expect(result.surchargeValue).toBe(500);
      expect(result.reason).toBe("Updated fee");

      // Verify via getConfig
      const config = await surchargeConfigService.getConfig(CUSTOMER_A.id);
      expect(config!.surchargeType).toBe("flat_fee");
      expect(config!.surchargeValue).toBe(500);
    });

    it("should handle config with null optional fields", async () => {
      const result = await surchargeConfigService.upsertConfig(CUSTOMER_A.id, {
        allowCreditCard: false,
      });

      expect(result.allowCreditCard).toBe(false);
      expect(result.surchargeType).toBeNull();
      expect(result.surchargeValue).toBeNull();
      expect(result.reason).toBeNull();
      expect(result.notes).toBeNull();
      expect(result.enabledBy).toBeNull();
    });
  });

  describe("deleteConfig", () => {
    it("should remove the config", async () => {
      await seedSurchargeConfig({
        id: "d0000000-0000-4000-a000-000000000004",
        customerId: CUSTOMER_A.id,
        allowCreditCard: true,
      });

      await surchargeConfigService.deleteConfig(CUSTOMER_A.id);

      const result = await surchargeConfigService.getConfig(CUSTOMER_A.id);
      expect(result).toBeNull();
    });

    it("should not affect other customers' configs", async () => {
      await seedSurchargeConfig({
        id: "d0000000-0000-4000-a000-000000000005",
        customerId: CUSTOMER_A.id,
        allowCreditCard: true,
      });
      await seedSurchargeConfig({
        id: "d0000000-0000-4000-a000-000000000006",
        customerId: CUSTOMER_B.id,
        allowCreditCard: true,
        surchargeType: "percentage",
        surchargeValue: 200,
      });

      await surchargeConfigService.deleteConfig(CUSTOMER_A.id);

      // Customer A config deleted
      const resultA = await surchargeConfigService.getConfig(CUSTOMER_A.id);
      expect(resultA).toBeNull();

      // Customer B config intact
      const resultB = await surchargeConfigService.getConfig(CUSTOMER_B.id);
      expect(resultB).not.toBeNull();
      expect(resultB!.surchargeValue).toBe(200);
    });
  });

  describe("adversarial isolation", () => {
    it("should isolate configs between customers completely", async () => {
      await seedSurchargeConfig({
        id: "d0000000-0000-4000-a000-000000000007",
        customerId: CUSTOMER_B.id,
        allowCreditCard: true,
        surchargeType: "flat_fee",
        surchargeValue: 999,
        reason: "B only config",
      });

      // Customer A should see null, not Customer B's config
      const resultA = await surchargeConfigService.getConfig(CUSTOMER_A.id);
      expect(resultA).toBeNull();

      // Customer B should see their config
      const resultB = await surchargeConfigService.getConfig(CUSTOMER_B.id);
      expect(resultB).not.toBeNull();
      expect(resultB!.surchargeValue).toBe(999);
    });
  });
});
