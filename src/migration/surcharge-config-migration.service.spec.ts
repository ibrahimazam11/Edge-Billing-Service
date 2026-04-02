import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import {
  SurchargeConfigMigrationService,
  convertSurchargeValue,
  mapSurchargeType,
} from "./surcharge-config-migration.service";
import type { MonolithCustomerCreditCardSettings } from "./surcharge-config-migration.service";
import { CustomersRepository } from "../customers/customers.repository";
import { SurchargeConfigRepository } from "../surcharges/surcharge-config.repository";
import { SurchargeConfigService } from "../surcharges/surcharge-config.service";
import { MigrationLogsRepository } from "./migration-logs.repository";
import { MONOLITH_DB_PROVIDER } from "./monolith-database.provider";

// --- Mock setup ---

const CUSTOMER_ID = "c0000000-0000-4000-a000-000000000001";
const MONOLITH_CUSTOMER_ID = "CUST-001";
const RUN_ID = "run00000-0000-4000-a000-000000000001";
const SCRIPT_NAME = "migrate-surcharge-configs";

function makeSettings(
  overrides: Partial<MonolithCustomerCreditCardSettings> = {},
): MonolithCustomerCreditCardSettings {
  return {
    Customer_ID: MONOLITH_CUSTOMER_ID,
    Allow_Credit_Card: true,
    Surcharge_Type: "percentage",
    Surcharge_Value: "3.50",
    Reason: "Credit card processing fee",
    Notes: "Standard surcharge",
    Enabled_By_User_ID: "user-123",
    ...overrides,
  };
}

describe("SurchargeConfigMigrationService", () => {
  let service: SurchargeConfigMigrationService;

  const mockCustomersRepo = {
    findAllForMigration: jest.fn().mockResolvedValue([]),
    findByMonolithId: jest.fn().mockResolvedValue(null),
  };

  const mockSurchargeConfigRepo = {
    findByCustomer: jest.fn().mockResolvedValue(null),
  };

  const mockMonolithPool = {
    query: jest.fn(),
  };

  const mockSurchargeConfigService = {
    upsertConfig: jest.fn().mockResolvedValue({
      id: "sc-001",
      customerId: CUSTOMER_ID,
      allowCreditCard: true,
      surchargeType: "percentage",
      surchargeValue: 350,
      reason: null,
      notes: null,
      enabledBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    getConfig: jest.fn(),
  };

  const mockMigrationLogsRepo = {
    createLog: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.restoreAllMocks();

    mockCustomersRepo.findAllForMigration.mockReset();
    mockCustomersRepo.findByMonolithId.mockReset();
    mockSurchargeConfigRepo.findByCustomer.mockReset();
    mockMonolithPool.query.mockReset();
    mockSurchargeConfigService.upsertConfig.mockReset();
    mockSurchargeConfigService.getConfig.mockReset();
    mockMigrationLogsRepo.createLog.mockReset();

    // Restore defaults
    mockCustomersRepo.findAllForMigration.mockResolvedValue([]);
    mockCustomersRepo.findByMonolithId.mockResolvedValue(null);
    mockSurchargeConfigRepo.findByCustomer.mockResolvedValue(null);
    mockSurchargeConfigService.upsertConfig.mockResolvedValue({
      id: "sc-001",
      customerId: CUSTOMER_ID,
      allowCreditCard: true,
      surchargeType: "percentage" as const,
      surchargeValue: 350,
      reason: null,
      notes: null,
      enabledBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockMigrationLogsRepo.createLog.mockResolvedValue(undefined);

    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const module = await Test.createTestingModule({
      providers: [
        SurchargeConfigMigrationService,
        { provide: MONOLITH_DB_PROVIDER, useValue: mockMonolithPool },
        { provide: CustomersRepository, useValue: mockCustomersRepo },
        {
          provide: SurchargeConfigRepository,
          useValue: mockSurchargeConfigRepo,
        },
        {
          provide: SurchargeConfigService,
          useValue: mockSurchargeConfigService,
        },
        {
          provide: MigrationLogsRepository,
          useValue: mockMigrationLogsRepo,
        },
      ],
    }).compile();

    service = module.get(SurchargeConfigMigrationService);
  });

  // --- Test 5.1: Happy path percentage ---

  describe("5.1: percentage surcharge config -> correct basis points", () => {
    it("should convert 3.50 -> 350 basis points", async () => {
      const settings = makeSettings();

      // Idempotency check: no existing config
      mockSurchargeConfigRepo.findByCustomer.mockResolvedValueOnce(null);

      const result = await service.migrateSingleConfig(
        settings,
        CUSTOMER_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.surchargeType).toBe("percentage");
      expect(mockSurchargeConfigService.upsertConfig).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.objectContaining({
          allowCreditCard: true,
          surchargeType: "percentage",
          surchargeValue: 350,
        }),
      );
    });
  });

  // --- Test 5.2: Happy path flat_fee ---

  describe("5.2: flat_fee surcharge config -> correct cents", () => {
    it("should convert flat 5.00 -> 500 cents", async () => {
      const settings = makeSettings({
        Surcharge_Type: "flat",
        Surcharge_Value: "5.00",
      });

      mockSurchargeConfigRepo.findByCustomer.mockResolvedValueOnce(null);

      const result = await service.migrateSingleConfig(
        settings,
        CUSTOMER_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.surchargeType).toBe("flat_fee");
      expect(mockSurchargeConfigService.upsertConfig).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.objectContaining({
          surchargeType: "flat_fee",
          surchargeValue: 500,
        }),
      );
    });
  });

  // --- Test 5.3: Customer not in billing DB ---

  describe("5.3: customer not in billing DB", () => {
    it("should fail in migrateByIds when customer not found", async () => {
      // Customer lookup returns null
      mockCustomersRepo.findByMonolithId.mockResolvedValueOnce(null);

      const summary = await service.migrateByIds(["NONEXISTENT-CUST"], {
        dryRun: false,
        batchSize: 50,
        batchDelayMs: 0,
      });

      expect(summary.failed).toBe(1);
    });
  });

  // --- Test 5.4: Idempotency ---

  describe("5.4: already-migrated config -> skip", () => {
    it("should skip when config already exists for customer", async () => {
      const settings = makeSettings();

      // Idempotency check: existing config found
      mockSurchargeConfigRepo.findByCustomer.mockResolvedValueOnce({
        id: "existing-config",
        customerId: CUSTOMER_ID,
      });

      const result = await service.migrateSingleConfig(
        settings,
        CUSTOMER_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("already_migrated");
      expect(mockSurchargeConfigService.upsertConfig).not.toHaveBeenCalled();
    });
  });

  // --- Test 5.5: Dry-run mode ---

  describe("5.5: dry-run mode", () => {
    it("should not write to surcharge_configs in dry-run", async () => {
      const settings = makeSettings();

      mockSurchargeConfigRepo.findByCustomer.mockResolvedValueOnce(null);

      const result = await service.migrateSingleConfig(
        settings,
        CUSTOMER_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: true, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("succeeded");
      expect(result.reason).toBe("dry_run");
      expect(mockSurchargeConfigService.upsertConfig).not.toHaveBeenCalled();
    });
  });

  // --- Test 5.6: Allow_Credit_Card boolean ---

  describe("5.6: Allow_Credit_Card boolean mapping", () => {
    it("should pass false when Allow_Credit_Card is false", async () => {
      const settings = makeSettings({ Allow_Credit_Card: false });

      mockSurchargeConfigRepo.findByCustomer.mockResolvedValueOnce(null);

      await service.migrateSingleConfig(
        settings,
        CUSTOMER_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(mockSurchargeConfigService.upsertConfig).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.objectContaining({ allowCreditCard: false }),
      );
    });

    it("should default to false when Allow_Credit_Card is null", async () => {
      const settings = makeSettings({ Allow_Credit_Card: null });

      mockSurchargeConfigRepo.findByCustomer.mockResolvedValueOnce(null);

      await service.migrateSingleConfig(
        settings,
        CUSTOMER_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(mockSurchargeConfigService.upsertConfig).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.objectContaining({ allowCreditCard: false }),
      );
    });
  });

  // --- Test 5.7: Null surcharge type/value ---

  describe("5.7: null surcharge type/value handling", () => {
    it("should pass undefined surchargeType/Value when null in monolith", async () => {
      const settings = makeSettings({
        Surcharge_Type: null,
        Surcharge_Value: null,
      });

      mockSurchargeConfigRepo.findByCustomer.mockResolvedValueOnce(null);

      await service.migrateSingleConfig(
        settings,
        CUSTOMER_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(mockSurchargeConfigService.upsertConfig).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.objectContaining({
          surchargeType: undefined,
          surchargeValue: undefined,
        }),
      );
    });
  });

  // --- Test 5.8: Summary output ---

  describe("5.8: summary output correctness", () => {
    it("should count percentage and flat_fee types in summary", async () => {
      // Customer 1 lookup
      mockCustomersRepo.findByMonolithId.mockResolvedValueOnce({
        id: CUSTOMER_ID,
        monolithCustomerId: MONOLITH_CUSTOMER_ID,
      });

      // Customer 1 monolith query
      mockMonolithPool.query.mockResolvedValueOnce({
        rows: [makeSettings()],
      });

      // Customer 1 idempotency (no existing)
      mockSurchargeConfigRepo.findByCustomer.mockResolvedValueOnce(null);

      // Customer 2 lookup
      mockCustomersRepo.findByMonolithId.mockResolvedValueOnce({
        id: "c0000000-0000-4000-a000-000000000002",
        monolithCustomerId: "CUST-002",
      });

      // Customer 2 monolith query
      mockMonolithPool.query.mockResolvedValueOnce({
        rows: [
          makeSettings({
            Customer_ID: "CUST-002",
            Surcharge_Type: "flat",
            Surcharge_Value: "5.00",
          }),
        ],
      });

      // Customer 2 idempotency (no existing)
      mockSurchargeConfigRepo.findByCustomer.mockResolvedValueOnce(null);

      const summary = await service.migrateByIds(
        [MONOLITH_CUSTOMER_ID, "CUST-002"],
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(summary.totalConfigs).toBe(2);
      expect(summary.succeeded).toBe(2);
      expect(summary.percentageType).toBe(1);
      expect(summary.flatFeeType).toBe(1);
    });
  });

  // --- Test 5.9: Migration log error resilience ---

  describe("5.9: migration log error resilience", () => {
    it("should not throw when migration log write fails in catch", async () => {
      const settings = makeSettings();

      // Idempotency check: no existing
      mockSurchargeConfigRepo.findByCustomer.mockResolvedValueOnce(null);

      // Make upsertConfig throw
      mockSurchargeConfigService.upsertConfig.mockRejectedValueOnce(
        new Error("DB error"),
      );

      // Make migration log write also throw
      mockMigrationLogsRepo.createLog.mockRejectedValueOnce(
        new Error("Log write failed"),
      );

      const result = await service.migrateSingleConfig(
        settings,
        CUSTOMER_ID,
        RUN_ID,
        SCRIPT_NAME,
        { dryRun: false, batchSize: 50, batchDelayMs: 0 },
      );

      expect(result.status).toBe("failed");
    });
  });
});

// --- Pure function tests ---

describe("convertSurchargeValue", () => {
  it("should convert 3.50 -> 350", () => {
    expect(convertSurchargeValue("3.50")).toBe(350);
  });

  it("should convert 5.00 -> 500", () => {
    expect(convertSurchargeValue("5.00")).toBe(500);
  });

  it("should convert number input", () => {
    expect(convertSurchargeValue(2.75)).toBe(275);
  });

  it("should return null for null input", () => {
    expect(convertSurchargeValue(null)).toBeNull();
  });

  it("should return null for NaN string", () => {
    expect(convertSurchargeValue("abc")).toBeNull();
  });

  it("should handle rounding correctly", () => {
    expect(convertSurchargeValue("3.999")).toBe(400);
  });
});

describe("mapSurchargeType", () => {
  it("should map percentage -> percentage", () => {
    expect(mapSurchargeType("percentage")).toBe("percentage");
  });

  it("should map flat -> flat_fee", () => {
    expect(mapSurchargeType("flat")).toBe("flat_fee");
  });

  it("should map flat_fee -> flat_fee", () => {
    expect(mapSurchargeType("flat_fee")).toBe("flat_fee");
  });

  it("should return null for unknown type", () => {
    expect(mapSurchargeType("unknown")).toBeNull();
  });

  it("should return null for null input", () => {
    expect(mapSurchargeType(null)).toBeNull();
  });

  it("should handle case insensitivity", () => {
    expect(mapSurchargeType("PERCENTAGE")).toBe("percentage");
    expect(mapSurchargeType("Flat")).toBe("flat_fee");
  });
});
