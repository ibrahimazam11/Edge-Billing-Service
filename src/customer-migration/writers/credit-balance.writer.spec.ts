import {
  CreditBalanceWriter,
  MIGRATION_CREDIT_REASON,
} from "./credit-balance.writer";
import type { CreditsService } from "../../credits/credits.service";
import type { CreditNotesRepository } from "../../credits/credit-notes.repository";

describe("CreditBalanceWriter", () => {
  let writer: CreditBalanceWriter;
  let mockCreditsService: { issueCreditNote: jest.Mock };
  let mockCreditNotesRepo: { findByCustomerAndReason: jest.Mock };

  beforeEach(() => {
    mockCreditsService = {
      issueCreditNote: jest.fn().mockResolvedValue({ id: "cn-1" }),
    };
    mockCreditNotesRepo = {
      findByCustomerAndReason: jest.fn().mockResolvedValue(null),
    };
    writer = new CreditBalanceWriter(
      mockCreditsService as unknown as CreditsService,
      mockCreditNotesRepo as unknown as CreditNotesRepository,
    );
  });

  it("skips with no_credit when startingBalance is null", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        latestPayroll: { totalAmount: "100", payrollMonth: "2026-01-01" },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_credit");
  });

  it("skips with no_credit when startingBalance is 0", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        latestPayroll: {
          totalAmount: "100",
          startingBalance: "0",
          payrollMonth: "2026-01-01",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_credit");
  });

  it("skips with no_credit when startingBalance is positive (customer owes Stripe)", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        latestPayroll: {
          totalAmount: "100",
          startingBalance: "25.00",
          localCurrency: "usd",
          payrollMonth: "2026-01-01",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_credit");
    expect(mockCreditsService.issueCreditNote).not.toHaveBeenCalled();
  });

  it("issues credit note when startingBalance < 0 (Stripe sign convention — negative = customer has credit)", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        latestPayroll: {
          totalAmount: "100",
          startingBalance: "-50.00",
          localCurrency: "usd",
          payrollMonth: "2026-01-01",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect(mockCreditsService.issueCreditNote).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "bc-1",
        amountCents: 5000,
        reason: MIGRATION_CREDIT_REASON,
        createdBy: "migration",
      }),
      expect.any(String),
    );
  });

  it("B2: skips when a prior credit_notes row exists (even if balance consumed to 0)", async () => {
    mockCreditNotesRepo.findByCustomerAndReason.mockResolvedValueOnce({
      id: "cn-existing",
      amountCents: 5000,
    });
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        latestPayroll: {
          totalAmount: "100",
          startingBalance: "-50.00",
          payrollMonth: "2026-01-01",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("already_migrated");
    expect(mockCreditsService.issueCreditNote).not.toHaveBeenCalled();
  });

  it("Bug 2 fix: dry-run on already-existing target returns already_migrated", async () => {
    mockCreditNotesRepo.findByCustomerAndReason.mockResolvedValueOnce({
      id: "cn-existing",
      amountCents: 5000,
    });
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        latestPayroll: {
          totalAmount: "100",
          startingBalance: "-50.00",
          payrollMonth: "2026-01-01",
        },
      },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("already_migrated");
    expect(mockCreditsService.issueCreditNote).not.toHaveBeenCalled();
  });

  it("dry-run reports planned action without issuing credit", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        latestPayroll: {
          totalAmount: "100",
          startingBalance: "-50.00",
          payrollMonth: "2026-01-01",
        },
      },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect((result as { dryRun?: boolean }).dryRun).toBe(true);
    expect(mockCreditsService.issueCreditNote).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Dry-run sentinel guard
  // (spec-billing-migration-dry-run-sentinel-idempotency.md)
  // -------------------------------------------------------------------------

  it("dry-run with sentinel billingCustomerId and non-zero credit returns succeeded without crashing on UUID type", async () => {
    // Previously this throw'd because findByCustomerAndReason was issued with
    // "<dry-run>" against a UUID column. Verify it now skips the lookup and
    // returns the planned dry-run output.
    const result = await writer.write(
      {
        billingCustomerId: "<dry-run>",
        latestPayroll: {
          totalAmount: "100",
          startingBalance: "-50.00",
          localCurrency: "usd",
          payrollMonth: "2026-01-01",
        },
      },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect((result as { dryRun?: boolean }).dryRun).toBe(true);
    expect(mockCreditNotesRepo.findByCustomerAndReason).not.toHaveBeenCalled();
    expect(mockCreditsService.issueCreditNote).not.toHaveBeenCalled();
  });

  it("dry-run with real billingCustomerId still runs the BS-DB idempotency lookup", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "11111111-1111-1111-1111-111111111111",
        latestPayroll: {
          totalAmount: "100",
          startingBalance: "-50.00",
          payrollMonth: "2026-01-01",
        },
      },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect(mockCreditNotesRepo.findByCustomerAndReason).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      MIGRATION_CREDIT_REASON,
    );
  });

  // -------------------------------------------------------------------------
  // C3: live Stripe customer.balance preferred over latestPayroll.startingBalance
  // -------------------------------------------------------------------------

  it("C3: prefers stripeCustomerBalanceCents over latestPayroll.startingBalance when both present", async () => {
    // Live balance says customer has $75 credit; stale historical says $50.
    // The live value must win — historical drift is the whole reason for this field.
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        latestPayroll: {
          totalAmount: "100",
          startingBalance: "-50.00",
          localCurrency: "usd",
          payrollMonth: "2026-01-01",
        },
        stripeCustomerBalanceCents: -7500,
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect(mockCreditsService.issueCreditNote).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 7500 }),
      expect.any(String),
    );
  });

  it("C3: falls back to latestPayroll.startingBalance when stripeCustomerBalanceCents absent", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        latestPayroll: {
          totalAmount: "100",
          startingBalance: "-50.00",
          localCurrency: "usd",
          payrollMonth: "2026-01-01",
        },
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect(mockCreditsService.issueCreditNote).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5000 }),
      expect.any(String),
    );
  });

  it("C3: skips with no_credit when stripeCustomerBalanceCents is 0 (live override beats stale negative)", async () => {
    // Customer used to have credit (recorded on the historical row) but the live
    // Stripe balance is now zero — likely the credit was applied to a subsequent
    // invoice. We must NOT re-create the credit in BS.
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        latestPayroll: {
          totalAmount: "100",
          startingBalance: "-50.00",
          payrollMonth: "2026-01-01",
        },
        stripeCustomerBalanceCents: 0,
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_credit");
    expect(mockCreditsService.issueCreditNote).not.toHaveBeenCalled();
  });

  it("C3: skips with no_credit when stripeCustomerBalanceCents is positive (customer owes Stripe)", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        latestPayroll: {
          totalAmount: "100",
          startingBalance: "-50.00",
          payrollMonth: "2026-01-01",
        },
        stripeCustomerBalanceCents: 2500,
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_credit");
    expect(mockCreditsService.issueCreditNote).not.toHaveBeenCalled();
  });

  it("C3: fails with invalid_amount when stripeCustomerBalanceCents is not finite", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        latestPayroll: {
          totalAmount: "100",
          payrollMonth: "2026-01-01",
        },
        stripeCustomerBalanceCents: Number.NaN,
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("failed");
    expect((result as { reason?: string }).reason).toBe("invalid_amount");
  });
});
