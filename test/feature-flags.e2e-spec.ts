import { INestApplication } from "@nestjs/common";
import { createTestApp } from "./helpers/test-app";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  seedCustomer,
  seedFeatureFlag,
} from "./helpers/database";
import { FeatureFlagService } from "../src/feature-flags/feature-flags.service";

const CUSTOMER_A = {
  id: "c0000000-0000-4000-a000-000000000001",
  monolithCustomerId: "mono-ff-001",
  name: "Feature Flag Customer A",
  email: "ff-a@example.com",
};

const CUSTOMER_B = {
  id: "c0000000-0000-4000-a000-000000000002",
  monolithCustomerId: "mono-ff-002",
  name: "Feature Flag Customer B",
  email: "ff-b@example.com",
};

const CUSTOMER_C = {
  id: "c0000000-0000-4000-a000-000000000003",
  monolithCustomerId: "mono-ff-003",
  name: "Feature Flag Customer C",
  email: "ff-c@example.com",
};

describe("Feature Flags (e2e)", () => {
  let app: INestApplication;
  let featureFlagService: FeatureFlagService;

  beforeAll(async () => {
    await setupTestDatabase();
    app = await createTestApp();
    featureFlagService = app.get(FeatureFlagService);
  });

  afterAll(async () => {
    await app.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedCustomer(CUSTOMER_A);
    await seedCustomer(CUSTOMER_B);
    await seedCustomer(CUSTOMER_C);
  });

  describe("isEnabled", () => {
    it("should return true when flag exists and is enabled", async () => {
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000001",
        customerId: CUSTOMER_A.id,
        flagName: "billing_service_enabled",
        enabled: true,
      });

      const result = await featureFlagService.isEnabled(
        CUSTOMER_A.id,
        "billing_service_enabled",
      );

      expect(result).toBe(true);
    });

    it("should return false when flag does not exist", async () => {
      const result = await featureFlagService.isEnabled(
        CUSTOMER_A.id,
        "billing_service_enabled",
      );

      expect(result).toBe(false);
    });

    it("should return false when flag exists but is disabled", async () => {
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000002",
        customerId: CUSTOMER_A.id,
        flagName: "billing_service_enabled",
        enabled: false,
      });

      const result = await featureFlagService.isEnabled(
        CUSTOMER_A.id,
        "billing_service_enabled",
      );

      expect(result).toBe(false);
    });

    it("adversarial: should NOT return flag from a different customer", async () => {
      // Seed flag for Customer B only
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000003",
        customerId: CUSTOMER_B.id,
        flagName: "billing_service_enabled",
        enabled: true,
      });

      // Query for Customer A — should NOT see Customer B's flag
      const result = await featureFlagService.isEnabled(
        CUSTOMER_A.id,
        "billing_service_enabled",
      );

      expect(result).toBe(false);
    });

    it("adversarial: disabled flag for same customer should return false", async () => {
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000004",
        customerId: CUSTOMER_A.id,
        flagName: "dual_write_enabled",
        enabled: false,
      });

      const result = await featureFlagService.isEnabled(
        CUSTOMER_A.id,
        "dual_write_enabled",
      );

      expect(result).toBe(false);
    });
  });

  describe("enableFlag", () => {
    it("should persist enabled flag in the database", async () => {
      await featureFlagService.enableFlag(
        CUSTOMER_A.id,
        "billing_service_enabled",
      );

      const result = await featureFlagService.isEnabled(
        CUSTOMER_A.id,
        "billing_service_enabled",
      );
      expect(result).toBe(true);
    });

    it("should upsert flag (enable an already-disabled flag)", async () => {
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000005",
        customerId: CUSTOMER_A.id,
        flagName: "billing_service_enabled",
        enabled: false,
      });

      await featureFlagService.enableFlag(
        CUSTOMER_A.id,
        "billing_service_enabled",
      );

      const result = await featureFlagService.isEnabled(
        CUSTOMER_A.id,
        "billing_service_enabled",
      );
      expect(result).toBe(true);
    });

    it("should store metadata with flag", async () => {
      await featureFlagService.enableFlag(
        CUSTOMER_A.id,
        "billing_service_enabled",
        { migrationBatch: 1 },
      );

      const flags = await featureFlagService.getFlags(CUSTOMER_A.id);
      expect(flags).toHaveLength(1);
      expect(flags[0].metadata).toEqual({ migrationBatch: 1 });
    });

    it("should preserve metadata when re-enabling without metadata parameter", async () => {
      // Enable with metadata first
      await featureFlagService.enableFlag(
        CUSTOMER_A.id,
        "billing_service_enabled",
        { migrationBatch: 1 },
      );

      // Re-enable WITHOUT metadata
      await featureFlagService.enableFlag(
        CUSTOMER_A.id,
        "billing_service_enabled",
      );

      // Verify metadata preserved
      const flags = await featureFlagService.getFlags(CUSTOMER_A.id);
      expect(flags).toHaveLength(1);
      expect(flags[0].metadata).toEqual({ migrationBatch: 1 });
    });
  });

  describe("disableFlag", () => {
    it("should disable an enabled flag", async () => {
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000006",
        customerId: CUSTOMER_A.id,
        flagName: "billing_service_enabled",
        enabled: true,
      });

      await featureFlagService.disableFlag(
        CUSTOMER_A.id,
        "billing_service_enabled",
      );

      const result = await featureFlagService.isEnabled(
        CUSTOMER_A.id,
        "billing_service_enabled",
      );
      expect(result).toBe(false);
    });
  });

  describe("enableFlagBulk", () => {
    it("should enable flag for multiple customers", async () => {
      await featureFlagService.enableFlagBulk(
        [CUSTOMER_A.id, CUSTOMER_B.id, CUSTOMER_C.id],
        "billing_service_enabled",
      );

      const resultA = await featureFlagService.isEnabled(
        CUSTOMER_A.id,
        "billing_service_enabled",
      );
      const resultB = await featureFlagService.isEnabled(
        CUSTOMER_B.id,
        "billing_service_enabled",
      );
      const resultC = await featureFlagService.isEnabled(
        CUSTOMER_C.id,
        "billing_service_enabled",
      );

      expect(resultA).toBe(true);
      expect(resultB).toBe(true);
      expect(resultC).toBe(true);
    });
  });

  describe("disableFlagBulk", () => {
    it("should disable flag for multiple customers", async () => {
      // First enable
      await featureFlagService.enableFlagBulk(
        [CUSTOMER_A.id, CUSTOMER_B.id],
        "dual_write_enabled",
      );

      // Then bulk disable
      await featureFlagService.disableFlagBulk(
        [CUSTOMER_A.id, CUSTOMER_B.id],
        "dual_write_enabled",
      );

      const resultA = await featureFlagService.isEnabled(
        CUSTOMER_A.id,
        "dual_write_enabled",
      );
      const resultB = await featureFlagService.isEnabled(
        CUSTOMER_B.id,
        "dual_write_enabled",
      );

      expect(resultA).toBe(false);
      expect(resultB).toBe(false);
    });
  });

  describe("getFlags", () => {
    it("should return all flags for a customer", async () => {
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000007",
        customerId: CUSTOMER_A.id,
        flagName: "billing_service_enabled",
        enabled: true,
      });
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000008",
        customerId: CUSTOMER_A.id,
        flagName: "dual_write_enabled",
        enabled: false,
      });

      const flags = await featureFlagService.getFlags(CUSTOMER_A.id);

      expect(flags).toHaveLength(2);
      const flagNames = flags.map((f) => f.flagName).sort();
      expect(flagNames).toEqual([
        "billing_service_enabled",
        "dual_write_enabled",
      ]);
    });

    it("adversarial: should not return flags from other customers", async () => {
      // Seed flags for Customer B
      await seedFeatureFlag({
        id: "f0000000-0000-4000-a000-000000000009",
        customerId: CUSTOMER_B.id,
        flagName: "billing_service_enabled",
        enabled: true,
      });

      // Query Customer A — should be empty
      const flags = await featureFlagService.getFlags(CUSTOMER_A.id);
      expect(flags).toHaveLength(0);
    });
  });
});
