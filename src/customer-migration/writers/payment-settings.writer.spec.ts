import { PaymentSettingsWriter } from "./payment-settings.writer";
import type { CustomersRepository } from "../../customers/customers.repository";
import type { PaymentGateway } from "../../gateway/gateway.interface";
import type {
  CustomerInputDto,
  PaymentSettingsInputDto,
} from "../dto/migrate-customer-body.dto";

describe("PaymentSettingsWriter", () => {
  let writer: PaymentSettingsWriter;
  let mockGateway: { getCustomer: jest.Mock; listPaymentMethods: jest.Mock };
  let mockCustomersRepo: { findByMonolithId: jest.Mock };

  let inserts: Array<{ table: unknown; values: unknown }>;
  let mockDb: { transaction: jest.Mock };

  const baseCustomer: CustomerInputDto = {
    monolithCustomerId: "mono-cust-1",
    companyName: "Acme",
    contactEmail: "a@a.com",
    trialEndDate: 15,
    isPrepaid: true,
    status: "enabled",
  };

  const baseSettings: PaymentSettingsInputDto = {
    stripeCustomerId: "cus_123",
    paymentMethodType: "ACH",
    mandateId: "mandate_abc",
    subscriptionId: "sub_999",
    subscriptionItemId: "si_888",
  };

  beforeEach(() => {
    inserts = [];
    mockGateway = {
      getCustomer: jest.fn().mockResolvedValue({
        id: "cus_123",
        email: "stripe@x.com",
        name: "Stripe Name",
        metadata: {},
        createdAt: new Date(),
        defaultPaymentMethodId: "pm_default",
      }),
      listPaymentMethods: jest.fn().mockResolvedValue([
        {
          id: "pm_default",
          customerId: "cus_123",
          type: "us_bank_account",
          last4: "6789",
          brand: null,
          bankName: "Bank",
          expiryMonth: null,
          expiryYear: null,
          isDefault: true,
        },
      ]),
    };
    mockCustomersRepo = { findByMonolithId: jest.fn().mockResolvedValue(null) };

    const tx = {
      insert: jest.fn((table: unknown) => ({
        values: jest.fn((values: unknown) => {
          inserts.push({ table, values });
          return Promise.resolve();
        }),
      })),
    };
    mockDb = {
      transaction: jest.fn((cb: (t: typeof tx) => Promise<void>) => cb(tx)),
    };

    writer = new PaymentSettingsWriter(
      mockDb as never,
      mockGateway as unknown as PaymentGateway,
      mockCustomersRepo as unknown as CustomersRepository,
    );
  });

  it("rejects CHEQUE payment method type", async () => {
    const result = await writer.write(
      {
        customer: baseCustomer,
        paymentSettings: { ...baseSettings, paymentMethodType: "CHEQUE" },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("payment_method_type_unsupported");
  });

  it("skips when customer already migrated", async () => {
    mockCustomersRepo.findByMonolithId.mockResolvedValueOnce({
      id: "existing-id",
    });
    const result = await writer.write(
      { customer: baseCustomer, paymentSettings: baseSettings },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.billingCustomerId).toBe("existing-id");
  });

  it("fails when stripe customer fetch throws", async () => {
    mockGateway.getCustomer.mockRejectedValueOnce(new Error("404"));
    const result = await writer.write(
      { customer: baseCustomer, paymentSettings: baseSettings },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("stripe_customer_unreachable");
  });

  it("persists mandate_id when paymentMethodType=ACH (P1: positive case)", async () => {
    const result = await writer.write(
      { customer: baseCustomer, paymentSettings: baseSettings },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    const pmInsert = inserts.find(
      (i) =>
        (i.values as { stripePaymentMethodId?: string })
          .stripePaymentMethodId === "pm_default",
    );
    expect(pmInsert).toBeDefined();
    expect(
      (pmInsert!.values as { metadata: { mandate_id?: string } | null })
        .metadata,
    ).toEqual({ mandate_id: "mandate_abc" });
  });

  it("P1: does NOT persist mandate_id when paymentMethodType=CREDIT_CARD even if default PM is bank account", async () => {
    const result = await writer.write(
      {
        customer: baseCustomer,
        paymentSettings: {
          ...baseSettings,
          paymentMethodType: "CREDIT_CARD",
          mandateId: "mandate_xyz",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    const pmInsert = inserts.find(
      (i) =>
        (i.values as { stripePaymentMethodId?: string })
          .stripePaymentMethodId === "pm_default",
    );
    expect(pmInsert).toBeDefined();
    expect((pmInsert!.values as { metadata: unknown }).metadata).toBeNull();
  });

  it("Bug 2 fix: dry-run on already-migrated customer returns already_migrated", async () => {
    mockCustomersRepo.findByMonolithId.mockResolvedValueOnce({
      id: "existing-id",
    });
    const result = await writer.write(
      { customer: baseCustomer, paymentSettings: baseSettings },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("already_migrated");
    expect(result.billingCustomerId).toBe("existing-id");
    // Stripe should not be queried, no inserts attempted.
    expect(mockGateway.getCustomer).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("succeeds with dry-run and reports planned action without inserts", async () => {
    const result = await writer.write(
      { customer: baseCustomer, paymentSettings: baseSettings },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect((result as { dryRun?: boolean }).dryRun).toBe(true);
    expect(result.billingCustomerId).toBe("<dry-run>");
    expect(inserts).toHaveLength(0);
  });

  it("C1: legacy ba_ default PM gets isDefault=true (pairs with mapStripeCustomer default_source fallback)", async () => {
    // Adapter resolves defaultPaymentMethodId from customer.default_source for legacy
    // customers; the writer must then tag the matching ba_ row — not the pm_ row.
    mockGateway.getCustomer.mockResolvedValueOnce({
      id: "cus_123",
      email: "stripe@x.com",
      name: "Legacy",
      metadata: {},
      createdAt: new Date(),
      defaultPaymentMethodId: "ba_legacy_999",
    });
    mockGateway.listPaymentMethods.mockResolvedValueOnce([
      {
        id: "pm_modern_otherwise",
        customerId: "cus_123",
        type: "card",
        last4: "4242",
        brand: "visa",
        bankName: null,
        expiryMonth: 12,
        expiryYear: 2030,
        isDefault: false,
      },
      {
        id: "ba_legacy_999",
        customerId: "cus_123",
        type: "us_bank_account",
        last4: "6789",
        brand: null,
        bankName: "Legacy Bank",
        expiryMonth: null,
        expiryYear: null,
        isDefault: false,
      },
    ]);

    const result = await writer.write(
      { customer: baseCustomer, paymentSettings: baseSettings },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");

    const pmInserts = inserts.filter(
      (i) =>
        (i.values as { stripePaymentMethodId?: string }).stripePaymentMethodId,
    );
    const legacyRow = pmInserts.find(
      (i) =>
        (i.values as { stripePaymentMethodId?: string })
          .stripePaymentMethodId === "ba_legacy_999",
    );
    const modernRow = pmInserts.find(
      (i) =>
        (i.values as { stripePaymentMethodId?: string })
          .stripePaymentMethodId === "pm_modern_otherwise",
    );
    expect((legacyRow!.values as { isDefault: boolean }).isDefault).toBe(true);
    expect((modernRow!.values as { isDefault: boolean }).isDefault).toBe(false);
    // Mandate metadata should attach to the legacy default (ACH path).
    expect((legacyRow!.values as { metadata: unknown }).metadata).toEqual({
      mandate_id: "mandate_abc",
    });
  });
});
