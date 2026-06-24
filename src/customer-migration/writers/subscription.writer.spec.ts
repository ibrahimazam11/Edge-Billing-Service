import {
  SubscriptionWriter,
  computeBillingCycle,
  computeDueDate,
} from "./subscription.writer";
import type { SubscriptionsRepository } from "../../subscriptions/subscriptions.repository";
import type { CustomersRepository } from "../../customers/customers.repository";
import type { InvoicesRepository } from "../../invoices/invoices.repository";

describe("computeBillingCycle", () => {
  // -----------------------------------------------------------------------
  // Original two cases — pre-existing prepaid behavior (unchanged by the
  // prepaid/postpaid spec, since prepaid still uses m+1).
  // -----------------------------------------------------------------------
  it("prepaid + chargeDay=15 → next 15th→15th after-next", () => {
    const r = computeBillingCycle(15, new Date(Date.UTC(2026, 4, 1)), true);
    expect(r.billingPeriodStart.toISOString()).toContain("2026-06-15");
    expect(r.billingPeriodEnd.toISOString()).toContain("2026-07-15");
  });
  it("prepaid + chargeDay=30 (∈[28..31]) → next 1st→1st after-next", () => {
    const r = computeBillingCycle(30, new Date(Date.UTC(2026, 4, 15)), true);
    expect(r.billingPeriodStart.toISOString()).toContain("2026-06-01");
    expect(r.billingPeriodEnd.toISOString()).toContain("2026-07-01");
  });

  // -----------------------------------------------------------------------
  // Prepaid vs postpaid branching
  // spec-billing-migration-subscription-cycle-prepaid-postpaid.md
  // -----------------------------------------------------------------------
  it("prepaid + chargeDay=1 + today=2026-05-25 → June 1 → July 1", () => {
    const r = computeBillingCycle(1, new Date(Date.UTC(2026, 4, 25)), true);
    expect(r.billingPeriodStart.toISOString()).toContain("2026-06-01");
    expect(r.billingPeriodEnd.toISOString()).toContain("2026-07-01");
  });
  it("postpaid + chargeDay=1 + today=2026-05-25 → May 1 → June 1", () => {
    const r = computeBillingCycle(1, new Date(Date.UTC(2026, 4, 25)), false);
    expect(r.billingPeriodStart.toISOString()).toContain("2026-05-01");
    expect(r.billingPeriodEnd.toISOString()).toContain("2026-06-01");
  });
  it("postpaid + chargeDay=15 + today=2026-05-25 → May 15 → June 15", () => {
    const r = computeBillingCycle(15, new Date(Date.UTC(2026, 4, 25)), false);
    expect(r.billingPeriodStart.toISOString()).toContain("2026-05-15");
    expect(r.billingPeriodEnd.toISOString()).toContain("2026-06-15");
  });
  it("prepaid + chargeDay=28 + today=2026-05-25 → June 1 → July 1 (day normalized)", () => {
    const r = computeBillingCycle(28, new Date(Date.UTC(2026, 4, 25)), true);
    expect(r.billingPeriodStart.toISOString()).toContain("2026-06-01");
    expect(r.billingPeriodEnd.toISOString()).toContain("2026-07-01");
  });
  it("postpaid + chargeDay=28 + today=2026-05-25 → May 1 → June 1 (day normalized)", () => {
    const r = computeBillingCycle(28, new Date(Date.UTC(2026, 4, 25)), false);
    expect(r.billingPeriodStart.toISOString()).toContain("2026-05-01");
    expect(r.billingPeriodEnd.toISOString()).toContain("2026-06-01");
  });
  it("postpaid + chargeDay=31 + today=2026-05-25 → May 1 → June 1 (day normalized)", () => {
    const r = computeBillingCycle(31, new Date(Date.UTC(2026, 4, 25)), false);
    expect(r.billingPeriodStart.toISOString()).toContain("2026-05-01");
    expect(r.billingPeriodEnd.toISOString()).toContain("2026-06-01");
  });
  // Year rollover
  it("prepaid + chargeDay=1 + today=2026-12-15 → 2027-01-01 → 2027-02-01 (year rollover)", () => {
    const r = computeBillingCycle(1, new Date(Date.UTC(2026, 11, 15)), true);
    expect(r.billingPeriodStart.toISOString()).toContain("2027-01-01");
    expect(r.billingPeriodEnd.toISOString()).toContain("2027-02-01");
  });
  it("postpaid + chargeDay=1 + today=2026-12-15 → 2026-12-01 → 2027-01-01 (year rollover at end)", () => {
    const r = computeBillingCycle(1, new Date(Date.UTC(2026, 11, 15)), false);
    expect(r.billingPeriodStart.toISOString()).toContain("2026-12-01");
    expect(r.billingPeriodEnd.toISOString()).toContain("2027-01-01");
  });
});

describe("computeDueDate", () => {
  // spec-billing-migration-due-date-from-chargeday.md
  it("chargeDay=1 + today=2026-05-25 → 2026-06-01", () => {
    expect(
      computeDueDate(1, new Date(Date.UTC(2026, 4, 25))).toISOString(),
    ).toContain("2026-06-01");
  });
  it("chargeDay=15 + today=2026-05-25 → 2026-06-15", () => {
    expect(
      computeDueDate(15, new Date(Date.UTC(2026, 4, 25))).toISOString(),
    ).toContain("2026-06-15");
  });
  it("chargeDay=27 + today=2026-05-25 → 2026-06-27", () => {
    expect(
      computeDueDate(27, new Date(Date.UTC(2026, 4, 25))).toISOString(),
    ).toContain("2026-06-27");
  });
  it("chargeDay=28 + today=2026-05-25 → 2026-05-28 (current month, before cycle)", () => {
    expect(
      computeDueDate(28, new Date(Date.UTC(2026, 4, 25))).toISOString(),
    ).toContain("2026-05-28");
  });
  it("chargeDay=29 + today=2026-05-25 → 2026-05-29", () => {
    expect(
      computeDueDate(29, new Date(Date.UTC(2026, 4, 25))).toISOString(),
    ).toContain("2026-05-29");
  });
  it("chargeDay=30 + today=2026-05-25 → 2026-05-30", () => {
    expect(
      computeDueDate(30, new Date(Date.UTC(2026, 4, 25))).toISOString(),
    ).toContain("2026-05-30");
  });
  it("chargeDay=31 + today=2026-05-25 (May has 31) → 2026-05-31", () => {
    expect(
      computeDueDate(31, new Date(Date.UTC(2026, 4, 25))).toISOString(),
    ).toContain("2026-05-31");
  });
  it("chargeDay=31 + today=2026-04-15 (April has 30) → 2026-05-01", () => {
    expect(
      computeDueDate(31, new Date(Date.UTC(2026, 3, 15))).toISOString(),
    ).toContain("2026-05-01");
  });
  it("chargeDay=31 + today=2026-06-15 (June has 30) → 2026-07-01", () => {
    expect(
      computeDueDate(31, new Date(Date.UTC(2026, 5, 15))).toISOString(),
    ).toContain("2026-07-01");
  });
  it("chargeDay=31 + today=2026-02-15 (Feb 28) → 2026-03-01", () => {
    expect(
      computeDueDate(31, new Date(Date.UTC(2026, 1, 15))).toISOString(),
    ).toContain("2026-03-01");
  });
  it("chargeDay=31 + today=2024-02-15 (Feb 29, leap year) → 2024-03-01 (still <31)", () => {
    expect(
      computeDueDate(31, new Date(Date.UTC(2024, 1, 15))).toISOString(),
    ).toContain("2024-03-01");
  });
  it("chargeDay=31 + today=2026-12-15 (Dec has 31) → 2026-12-31", () => {
    expect(
      computeDueDate(31, new Date(Date.UTC(2026, 11, 15))).toISOString(),
    ).toContain("2026-12-31");
  });
  it("chargeDay=1 + today=2026-12-15 → 2027-01-01 (year rollover)", () => {
    expect(
      computeDueDate(1, new Date(Date.UTC(2026, 11, 15))).toISOString(),
    ).toContain("2027-01-01");
  });

  // -----------------------------------------------------------------------
  // 28..30 + short-month edge cases (Feb)
  // Closes silent JS date-overflow bug surfaced by reviewer 2026-05-25.
  // -----------------------------------------------------------------------
  it("chargeDay=29 + today=2026-02-15 (Feb 28, non-leap) → 2026-03-01 (default)", () => {
    expect(
      computeDueDate(29, new Date(Date.UTC(2026, 1, 15))).toISOString(),
    ).toContain("2026-03-01");
  });
  it("chargeDay=29 + today=2024-02-15 (Feb 29, leap year) → 2024-02-29 (Feb 29 exists)", () => {
    expect(
      computeDueDate(29, new Date(Date.UTC(2024, 1, 15))).toISOString(),
    ).toContain("2024-02-29");
  });
  it("chargeDay=30 + today=2026-02-15 (Feb 28) → 2026-03-01 (default)", () => {
    expect(
      computeDueDate(30, new Date(Date.UTC(2026, 1, 15))).toISOString(),
    ).toContain("2026-03-01");
  });
  it("chargeDay=30 + today=2024-02-15 (Feb 29, leap — still 29 < 30) → 2024-03-01 (default)", () => {
    expect(
      computeDueDate(30, new Date(Date.UTC(2024, 1, 15))).toISOString(),
    ).toContain("2024-03-01");
  });
  it("chargeDay=30 + today=2026-04-15 (April has 30) → 2026-04-30 (literal day exists)", () => {
    expect(
      computeDueDate(30, new Date(Date.UTC(2026, 3, 15))).toISOString(),
    ).toContain("2026-04-30");
  });
  it("chargeDay=30 + today=2026-06-15 (June has 30) → 2026-06-30 (literal day exists)", () => {
    expect(
      computeDueDate(30, new Date(Date.UTC(2026, 5, 15))).toISOString(),
    ).toContain("2026-06-30");
  });
  it("chargeDay=28 + today=2026-02-15 (Feb 28) → 2026-02-28 (literal day exists)", () => {
    expect(
      computeDueDate(28, new Date(Date.UTC(2026, 1, 15))).toISOString(),
    ).toContain("2026-02-28");
  });
});

describe("SubscriptionWriter", () => {
  let writer: SubscriptionWriter;
  let mockSubsRepo: { findByCustomerAndStatuses: jest.Mock };
  let mockCustRepo: { findById: jest.Mock };
  let mockInvoicesRepo: { linkOpenRecurringDraftToSubscription: jest.Mock };
  let inserts: unknown[];
  let mockDb: { insert: jest.Mock; transaction: jest.Mock };

  beforeEach(() => {
    inserts = [];
    mockSubsRepo = {
      findByCustomerAndStatuses: jest.fn().mockResolvedValue([]),
    };
    mockCustRepo = {
      findById: jest.fn().mockResolvedValue({
        id: "bc-1",
        chargeDay: 15,
        isPrepaid: true,
      }),
    };
    mockInvoicesRepo = {
      // Default: exactly one open recurring draft linked (the normal case).
      linkOpenRecurringDraftToSubscription: jest.fn().mockResolvedValue(1),
    };
    // The real-run insert + draft-link run inside db.transaction(cb). The mock
    // tx exposes insert(...).values(...) and is passed straight through to the
    // (mocked) invoicesRepository.linkOpenRecurringDraftToSubscription.
    const txMock = {
      insert: jest.fn(() => ({
        values: jest.fn((v: unknown) => {
          inserts.push(v);
          return Promise.resolve();
        }),
      })),
    };
    mockDb = {
      insert: jest.fn(() => ({
        values: jest.fn((v: unknown) => {
          inserts.push(v);
          return Promise.resolve();
        }),
      })),
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb(txMock),
      ),
    };
    writer = new SubscriptionWriter(
      mockDb as never,
      mockSubsRepo as unknown as SubscriptionsRepository,
      mockCustRepo as unknown as CustomersRepository,
      mockInvoicesRepo as unknown as InvoicesRepository,
    );
  });

  it("fails no_run_rate when latestPayroll is missing", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
        },
        latestPayroll: null,
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("no_run_rate");
  });

  it("writes subscription with metadata.monolith_subscription_id + stripe_subscription_id", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: {
          totalAmount: "1000",
          localCurrency: "usd",
          payrollMonth: "2026-05-01",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect(inserts).toHaveLength(1);
    const md = (inserts[0] as { metadata: Record<string, unknown> }).metadata;
    expect(md.monolith_subscription_id).toBe("sub_xyz");
    expect(md.stripe_subscription_id).toBe("sub_xyz");
  });

  it("Fix 3: back-links the open recurring draft to the new subscription", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: {
          totalAmount: "1000",
          localCurrency: "usd",
          payrollMonth: "2026-05-01",
        },
      },
      { dryRun: false, runId: "r1" },
    );

    expect(result.status).toBe("succeeded");
    // Linked to the subscription that was just inserted — never null, never a
    // pre-existing id.
    const insertedSubId = (inserts[0] as { id: string }).id;
    expect(
      mockInvoicesRepo.linkOpenRecurringDraftToSubscription,
    ).toHaveBeenCalledTimes(1);
    expect(
      mockInvoicesRepo.linkOpenRecurringDraftToSubscription,
    ).toHaveBeenCalledWith("bc-1", insertedSubId, expect.anything());
    expect(
      (result as unknown as { data: { linkedDraftCount: number } }).data
        .linkedDraftCount,
    ).toBe(1);
  });

  it("Fix 3: does NOT back-link on dry-run (no subscription is written)", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: { totalAmount: "1000", payrollMonth: "2026-05-01" },
      },
      { dryRun: true, runId: "r1" },
    );

    expect(result.status).toBe("succeeded");
    expect(inserts).toHaveLength(0);
    expect(
      mockInvoicesRepo.linkOpenRecurringDraftToSubscription,
    ).not.toHaveBeenCalled();
  });

  it("Fix 3: surfaces linkedDraftCount=0 without failing the step (warns on anomaly)", async () => {
    mockInvoicesRepo.linkOpenRecurringDraftToSubscription.mockResolvedValueOnce(
      0,
    );
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: { totalAmount: "1000", payrollMonth: "2026-05-01" },
      },
      { dryRun: false, runId: "r1" },
    );

    // Missing placeholder is an anomaly worth surfacing, but it must not roll
    // back an otherwise-successful subscription write.
    expect(result.status).toBe("succeeded");
    expect(
      (result as unknown as { data: { linkedDraftCount: number } }).data
        .linkedDraftCount,
    ).toBe(0);
  });

  it("B3: skips when existing active sub has matching monolith_subscription_id", async () => {
    mockSubsRepo.findByCustomerAndStatuses.mockResolvedValueOnce([
      {
        id: "existing-sub",
        status: "active",
        metadata: { monolith_subscription_id: "sub_xyz" },
      },
    ]);
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: {
          totalAmount: "1000",
          payrollMonth: "2026-05-01",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("already_migrated");
  });

  it("B3: FAILS subscription_conflict when active sub has different/missing monolith_subscription_id", async () => {
    mockSubsRepo.findByCustomerAndStatuses.mockResolvedValueOnce([
      {
        id: "existing-sub",
        status: "active",
        metadata: { monolith_subscription_id: "sub_OTHER" },
      },
    ]);
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: {
          totalAmount: "1000",
          payrollMonth: "2026-05-01",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("subscription_conflict");
  });

  it("B3/P11: FAILS existing_sub_without_metadata when active sub has no monolith_subscription_id at all", async () => {
    // P11 split this case out from the generic subscription_conflict reason
    // so operators can distinguish "non-migration sub already exists" from
    // "monolith id mismatch".
    mockSubsRepo.findByCustomerAndStatuses.mockResolvedValueOnce([
      {
        id: "existing-sub",
        status: "active",
        metadata: {},
      },
    ]);
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: {
          totalAmount: "1000",
          payrollMonth: "2026-05-01",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("existing_sub_without_metadata");
  });

  it("P6: fails invalid_charge_day when chargeDay=0", async () => {
    mockCustRepo.findById.mockResolvedValueOnce({
      id: "bc-1",
      chargeDay: 0,
      isPrepaid: true,
    });
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: {
          totalAmount: "1000",
          payrollMonth: "2026-05-01",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("invalid_charge_day");
  });

  it("P11: fails multiple_active_subscriptions when more than one active sub exists", async () => {
    mockSubsRepo.findByCustomerAndStatuses.mockResolvedValueOnce([
      {
        id: "sub-A",
        status: "active",
        metadata: { monolith_subscription_id: "sub_xyz" },
      },
      {
        id: "sub-B",
        status: "active",
        metadata: { monolith_subscription_id: "sub_xyz" },
      },
    ]);
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: { totalAmount: "1000", payrollMonth: "2026-05-01" },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("multiple_active_subscriptions");
  });

  it("P11: fails incoming_subscription_id_null when body has null subscriptionId but active sub exists", async () => {
    mockSubsRepo.findByCustomerAndStatuses.mockResolvedValueOnce([
      {
        id: "sub-A",
        status: "active",
        metadata: { monolith_subscription_id: "sub_xyz" },
      },
    ]);
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: null,
        },
        latestPayroll: { totalAmount: "1000", payrollMonth: "2026-05-01" },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("incoming_subscription_id_null");
  });

  it("P11: fails existing_sub_without_metadata when active sub has no monolith_subscription_id", async () => {
    mockSubsRepo.findByCustomerAndStatuses.mockResolvedValueOnce([
      { id: "sub-A", status: "active", metadata: { other_key: "x" } },
    ]);
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: { totalAmount: "1000", payrollMonth: "2026-05-01" },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("existing_sub_without_metadata");
  });

  it("Bug 2 fix: dry-run on existing customer with matching active sub returns already_migrated", async () => {
    // Non-placeholder billingCustomerId → idempotency check runs even in dry-run.
    mockSubsRepo.findByCustomerAndStatuses.mockResolvedValueOnce([
      {
        id: "existing-sub",
        status: "active",
        metadata: { monolith_subscription_id: "sub_xyz" },
      },
    ]);
    const result = await writer.write(
      {
        billingCustomerId: "bc-existing",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: {
          totalAmount: "1000",
          payrollMonth: "2026-05-01",
        },
      },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("already_migrated");
  });

  it("P13: dry-run preview uses body.customer.trialEndDate (chargeDay=15 → 15th-to-15th cycle)", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "<dry-run>",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: { totalAmount: "1000", payrollMonth: "2026-05-01" },
        customer: {
          monolithCustomerId: "mono-1",
          companyName: "Acme",
          contactEmail: "a@a.com",
          trialEndDate: 15,
          isPrepaid: false,
          status: "enabled",
        },
      },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    const planned = (
      result as {
        planned?: {
          chargeDay: number;
          isPrepaid: boolean;
          billingPeriodStart: string;
          billingPeriodEnd: string;
          nextBillingDate: string;
        };
      }
    ).planned!;
    expect(planned.chargeDay).toBe(15);
    expect(planned.isPrepaid).toBe(false);
    // 15th→15th cycle, not 1st→1st.
    expect(planned.billingPeriodStart).toContain("-15T");
    expect(planned.billingPeriodEnd).toContain("-15T");
    // spec-billing-migration-due-date-from-chargeday.md: chargeDay=15 → 15th of next month.
    expect(planned.nextBillingDate).toContain("-15T");
  });

  it("dry-run nextBillingDate uses computeDueDate (chargeDay=28 prepaid → 28th of CURRENT month, before cycle starts)", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "<dry-run>",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: { totalAmount: "1000", payrollMonth: "2026-05-01" },
        customer: {
          monolithCustomerId: "mono-1",
          companyName: "Acme",
          contactEmail: "a@a.com",
          trialEndDate: 28,
          isPrepaid: true,
          status: "enabled",
        },
      },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    const planned = (
      result as {
        planned?: {
          chargeDay: number;
          isPrepaid: boolean;
          billingPeriodStart: string;
          nextBillingDate: string;
        };
      }
    ).planned!;
    expect(planned.chargeDay).toBe(28);
    expect(planned.isPrepaid).toBe(true);
    // billingPeriodStart: day normalized to 1 of next month.
    expect(planned.billingPeriodStart).toContain("-01T");
    // nextBillingDate: literal 28th of CURRENT month — BEFORE billingPeriodStart.
    expect(planned.nextBillingDate).toContain("-28T");
    expect(new Date(planned.nextBillingDate).getTime()).toBeLessThan(
      new Date(planned.billingPeriodStart).getTime(),
    );
  });

  it("P6: fails invalid_charge_day when chargeDay=32", async () => {
    mockCustRepo.findById.mockResolvedValueOnce({
      id: "bc-1",
      chargeDay: 32,
      isPrepaid: true,
    });
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        paymentSettings: {
          stripeCustomerId: "cus_1",
          paymentMethodType: "ACH",
          subscriptionId: "sub_xyz",
        },
        latestPayroll: {
          totalAmount: "1000",
          payrollMonth: "2026-05-01",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("invalid_charge_day");
  });
});
