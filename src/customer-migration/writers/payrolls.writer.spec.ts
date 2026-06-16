import { PayrollsWriter } from "./payrolls.writer";
import type { InvoicesRepository } from "../../invoices/invoices.repository";
import type { PaymentMethodsRepository } from "../../payment-methods/payment-methods.repository";
import type { LedgerService } from "../../ledger/ledger.service";
import type { PayrollInputDto } from "../dto/migrate-customer-body.dto";

function makePayroll(over: Partial<PayrollInputDto> = {}): PayrollInputDto {
  // Default payrollMonth deliberately in the deep past so existing un-paid
  // tests assert "past → finalized" deterministically regardless of system clock.
  // spec-billing-migration-future-unpaid-as-draft.md
  return {
    customerPayrollId: "p1",
    payrollMonth: "2020-01-01",
    totalAmount: "1000",
    status: "paid",
    failure: false,
    employees: [
      {
        payrollId: "p1",
        employeeName: "Alice",
        baseSalary: "1000",
        paidGrossSalary: "900",
        bonus: "50",
        platformFee: "50",
      },
    ],
    ...over,
  };
}

describe("PayrollsWriter", () => {
  let writer: PayrollsWriter;
  let mockInvoicesRepo: { findByMonolithMetadata: jest.Mock };
  let mockPmRepo: { findAllByCustomerUnfiltered: jest.Mock };
  let mockLedger: {
    recordMigrationPayrollFinalized: jest.Mock;
    recordMigrationPayrollPayment: jest.Mock;
    recordInvoiceVoided: jest.Mock;
  };
  let mockDb: { transaction: jest.Mock };
  let inserts: Array<{ table: string; values: Record<string, unknown> }>;

  beforeEach(() => {
    inserts = [];
    mockInvoicesRepo = {
      findByMonolithMetadata: jest.fn().mockResolvedValue(null),
    };
    mockPmRepo = {
      findAllByCustomerUnfiltered: jest
        .fn()
        .mockResolvedValue([{ id: "pm-1", isDefault: true, type: "card" }]),
    };
    mockLedger = {
      recordMigrationPayrollFinalized: jest.fn().mockResolvedValue("ledger-1"),
      recordMigrationPayrollPayment: jest.fn().mockResolvedValue("ledger-2"),
      recordInvoiceVoided: jest.fn().mockResolvedValue("ledger-void"),
    };
    const tx = {
      insert: jest.fn((tbl: unknown) => ({
        values: jest.fn((v: Record<string, unknown>) => {
          const tableName =
            (tbl as { _?: { name?: string } })?._?.name ?? "unknown";
          inserts.push({ table: tableName, values: v });
          return Promise.resolve();
        }),
      })),
    };
    mockDb = {
      transaction: jest.fn((cb: (t: typeof tx) => Promise<void>) => cb(tx)),
    };
    writer = new PayrollsWriter(
      mockDb as never,
      mockInvoicesRepo as unknown as InvoicesRepository,
      mockPmRepo as unknown as PaymentMethodsRepository,
      mockLedger as unknown as LedgerService,
    );
  });

  it("skips when payrolls array empty", async () => {
    const r = await writer.write(
      { billingCustomerId: "bc-1", payrolls: [] },
      { dryRun: false, runId: "r1" },
    );
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("no_payrolls");
  });

  it("P4: paid status with no paidOn/paymentDate sets paidAt=null (not Date.now)", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        payrolls: [
          makePayroll({
            status: "paid",
            paidOn: null,
            paymentDate: null,
          }),
        ],
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    const invoiceInsert = inserts.find(
      (i) => (i.values as { type?: string }).type === "recurring",
    );
    expect(invoiceInsert).toBeDefined();
    expect(invoiceInsert!.values.paidAt).toBeNull();
  });

  it("dry-run reports planned action with no DB writes", async () => {
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        payrolls: [makePayroll()],
      },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect((result as { details?: unknown[] }).details).toHaveLength(1);
    expect(inserts).toHaveLength(0);
    expect(mockPmRepo.findAllByCustomerUnfiltered).not.toHaveBeenCalled();
  });

  it("P10: line items sum to 100.00 but totalAmount=101.00 → invoice uses authoritative totalCents and warns", async () => {
    const warnSpy = jest
      .spyOn(
        (writer as unknown as { logger: { warn: (...a: unknown[]) => void } })
          .logger,
        "warn",
      )
      .mockImplementation(() => undefined);
    const r = await writer.write(
      {
        billingCustomerId: "bc-1",
        payrolls: [
          makePayroll({
            totalAmount: "101.00",
            employees: [
              {
                payrollId: "p1",
                employeeName: "Alice",
                baseSalary: "100.00",
              },
            ],
          }),
        ],
      },
      { dryRun: false, runId: "r1" },
    );
    expect(r.status).toBe("succeeded");
    const invoiceInsert = inserts.find(
      (i) => (i.values as { type?: string }).type === "recurring",
    );
    expect(invoiceInsert).toBeDefined();
    expect(invoiceInsert!.values.totalAmountCents).toBe(10100);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "payrolls.writer.line_item_sum_mismatch",
        monolithPayrollId: "p1",
        lineItemSum: 10000,
        totalCents: 10100,
        delta: -100,
      }),
    );
    warnSpy.mockRestore();
  });

  it("P3: fails when totalAmount is non-numeric", async () => {
    const r = await writer.write(
      {
        billingCustomerId: "bc-1",
        payrolls: [makePayroll({ totalAmount: "abc" })],
      },
      { dryRun: false, runId: "r1" },
    );
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("invalid_total_amount");
  });

  it("Bug 2 fix: dry-run on already-migrated payroll row reports skipped per-row", async () => {
    mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce({
      id: "existing-invoice",
    });
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        payrolls: [makePayroll()],
      },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    const details = (
      result as { details?: Array<{ status: string; reason?: string }> }
    ).details!;
    expect(details).toHaveLength(1);
    expect(details[0]?.status).toBe("skipped");
    expect(details[0]?.reason).toBe("already_migrated");
    expect(inserts).toHaveLength(0);
  });

  it("Bug A: $0 payroll writes invoice but skips ledger (no phantom 1¢ entries)", async () => {
    const r = await writer.write(
      {
        billingCustomerId: "bc-1",
        payrolls: [
          makePayroll({
            totalAmount: "0",
            employees: [
              {
                payrollId: "p1",
                employeeName: "Alice",
                baseSalary: "0",
              },
            ],
          }),
        ],
      },
      { dryRun: false, runId: "r1" },
    );
    expect(r.status).toBe("succeeded");
    expect(mockLedger.recordMigrationPayrollFinalized).not.toHaveBeenCalled();
    expect(mockLedger.recordMigrationPayrollPayment).not.toHaveBeenCalled();
    expect(mockLedger.recordInvoiceVoided).not.toHaveBeenCalled();
  });

  it("persists startingBalance / monolith invoice provenance in invoice metadata", async () => {
    const r = await writer.write(
      {
        billingCustomerId: "bc-1",
        payrolls: [
          makePayroll({
            // Negative startingBalance = credit was applied on the original monolith invoice.
            startingBalance: "-25.50",
            invoiceId: "in_mono_1",
            invoiceUrl: "https://stripe.example/in_mono_1",
            referenceNumber: "REF-123",
          }),
        ],
      },
      { dryRun: false, runId: "r1" },
    );
    expect(r.status).toBe("succeeded");
    const invoiceInsert = inserts.find(
      (i) => (i.values as { type?: string }).type === "recurring",
    );
    expect(invoiceInsert).toBeDefined();
    const meta = (
      invoiceInsert!.values as { metadata: Record<string, unknown> }
    ).metadata;
    expect(meta.creditAdjustmentCents).toBe(-2550);
    expect(meta.monolith_invoice_id).toBe("in_mono_1");
    expect(meta.monolith_invoice_url).toBe("https://stripe.example/in_mono_1");
    expect(meta.monolith_reference_number).toBe("REF-123");
  });

  it("persists creditAdjustmentCents=null when startingBalance is absent", async () => {
    const r = await writer.write(
      { billingCustomerId: "bc-1", payrolls: [makePayroll()] },
      { dryRun: false, runId: "r1" },
    );
    expect(r.status).toBe("succeeded");
    const invoiceInsert = inserts.find(
      (i) => (i.values as { type?: string }).type === "recurring",
    );
    const meta = (
      invoiceInsert!.values as { metadata: Record<string, unknown> }
    ).metadata;
    expect(meta.creditAdjustmentCents).toBeNull();
    expect(meta.monolith_invoice_id).toBeNull();
  });

  it("emits cost-component breakdown on employee line items", async () => {
    const r = await writer.write(
      { billingCustomerId: "bc-1", payrolls: [makePayroll()] },
      { dryRun: false, runId: "r1" },
    );
    expect(r.status).toBe("succeeded");
    const lineItem = inserts.find(
      (i) => (i.values as { type?: string }).type === "employee_cost",
    );
    expect(lineItem).toBeDefined();
    const breakdown = (
      lineItem!.values as { breakdown: Record<string, unknown> }
    ).breakdown;
    expect(breakdown.baseSalaryCents).toBe(100000);
    expect(breakdown.paidGrossSalaryCents).toBe(90000);
    expect(breakdown.bonusCents).toBe(5000);
    expect(breakdown.platformFeeCents).toBe(5000);
  });

  // ---------------------------------------------------------------------------
  // Status preservation (spec-billing-migration-status-preservation.md)
  // ---------------------------------------------------------------------------

  it("status preservation: un-paid → finalized invoice with NO charge row + metadata.monolith_original_status='un-paid'", async () => {
    const r = await writer.write(
      {
        billingCustomerId: "bc-1",
        payrolls: [
          makePayroll({
            customerPayrollId: "p_unpaid",
            status: "un-paid",
            paidOn: null,
            paymentDate: null,
          }),
        ],
      },
      { dryRun: false, runId: "r1" },
    );
    expect(r.status).toBe("succeeded");
    const invoiceInsert = inserts.find(
      (i) => (i.values as { type?: string }).type === "recurring",
    );
    expect(invoiceInsert).toBeDefined();
    expect((invoiceInsert!.values as { status: string }).status).toBe(
      "finalized",
    );
    expect((invoiceInsert!.values as { paidAt: unknown }).paidAt).toBeNull();
    const meta = (
      invoiceInsert!.values as { metadata: Record<string, unknown> }
    ).metadata;
    expect(meta.monolith_original_status).toBe("un-paid");
    // No charge row should be inserted — un-paid placeholder never had a Stripe charge.
    const chargeInsert = inserts.find(
      (i) =>
        ["charges"].includes(i.table) ||
        (i.values as { stripePaymentIntentId?: unknown })
          .stripePaymentIntentId !== undefined,
    );
    expect(chargeInsert).toBeUndefined();
    // Ledger should record the finalize entry (single AR record, no payment).
    expect(mockLedger.recordMigrationPayrollFinalized).toHaveBeenCalledTimes(1);
    expect(mockLedger.recordMigrationPayrollPayment).not.toHaveBeenCalled();
  });

  it("status preservation: unpaid (no hyphen) also maps to finalized + no charge", async () => {
    const r = await writer.write(
      {
        billingCustomerId: "bc-1",
        payrolls: [
          makePayroll({
            customerPayrollId: "p_unpaid2",
            status: "unpaid",
            paidOn: null,
            paymentDate: null,
          }),
        ],
      },
      { dryRun: false, runId: "r1" },
    );
    expect(r.status).toBe("succeeded");
    const invoiceInsert = inserts.find(
      (i) => (i.values as { type?: string }).type === "recurring",
    );
    expect((invoiceInsert!.values as { status: string }).status).toBe(
      "finalized",
    );
    const meta = (
      invoiceInsert!.values as { metadata: Record<string, unknown> }
    ).metadata;
    expect(meta.monolith_original_status).toBe("unpaid");
    const chargeInsert = inserts.find(
      (i) =>
        (i.values as { stripePaymentIntentId?: unknown })
          .stripePaymentIntentId !== undefined,
    );
    expect(chargeInsert).toBeUndefined();
  });

  it("status preservation: pending → finalized invoice + charge pending + metadata.monolith_original_status='pending'", async () => {
    const r = await writer.write(
      {
        billingCustomerId: "bc-1",
        payrolls: [
          makePayroll({
            customerPayrollId: "p_pending",
            status: "pending",
            paidOn: null,
            paymentDate: null,
          }),
        ],
      },
      { dryRun: false, runId: "r1" },
    );
    expect(r.status).toBe("succeeded");
    const invoiceInsert = inserts.find(
      (i) => (i.values as { type?: string }).type === "recurring",
    );
    expect((invoiceInsert!.values as { status: string }).status).toBe(
      "finalized",
    );
    const meta = (
      invoiceInsert!.values as { metadata: Record<string, unknown> }
    ).metadata;
    expect(meta.monolith_original_status).toBe("pending");
    // pending DOES create a charge row (charge in flight).
    const chargeInsert = inserts.find(
      (i) =>
        (i.values as { stripePaymentIntentId?: unknown })
          .stripePaymentIntentId !== undefined,
    );
    expect(chargeInsert).toBeDefined();
    expect((chargeInsert!.values as { status: string }).status).toBe("pending");
  });

  it("status preservation: paid → metadata.monolith_original_status='paid' (verifies precedence does not regress paid rows)", async () => {
    const r = await writer.write(
      {
        billingCustomerId: "bc-1",
        payrolls: [
          makePayroll({
            customerPayrollId: "p_paid",
            status: "paid",
            paidOn: "2026-04-05T12:00:00Z",
          }),
        ],
      },
      { dryRun: false, runId: "r1" },
    );
    expect(r.status).toBe("succeeded");
    const invoiceInsert = inserts.find(
      (i) => (i.values as { type?: string }).type === "recurring",
    );
    expect((invoiceInsert!.values as { status: string }).status).toBe("paid");
    const meta = (
      invoiceInsert!.values as { metadata: Record<string, unknown> }
    ).metadata;
    expect(meta.monolith_original_status).toBe("paid");
  });

  it("status preservation: unknown status still per-row skipped (regression — does not silently migrate)", async () => {
    const r = await writer.write(
      {
        billingCustomerId: "bc-1",
        payrolls: [
          makePayroll({
            customerPayrollId: "p_weird",
            // some status the writer has never seen
            status: "weird-future-status",
          }),
        ],
      },
      { dryRun: false, runId: "r1" },
    );
    expect(r.status).toBe("succeeded");
    const details = (
      r as { details?: Array<{ status: string; reason?: string }> }
    ).details!;
    expect(details).toHaveLength(1);
    expect(details[0]?.status).toBe("skipped");
    expect(details[0]?.reason).toBe("unknown_status");
    expect(inserts).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Future-un-paid → draft refinement
  // spec-billing-migration-future-unpaid-as-draft.md
  // ---------------------------------------------------------------------------

  it("future un-paid placeholder (Payroll_Month > today) → invoice 'draft', no charge row, no ledger", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-05-25T00:00:00Z"));
    try {
      const r = await writer.write(
        {
          billingCustomerId: "bc-1",
          payrolls: [
            makePayroll({
              customerPayrollId: "p_future_unpaid",
              status: "un-paid",
              payrollMonth: "2026-07-31",
              paidOn: null,
              paymentDate: null,
            }),
          ],
        },
        { dryRun: false, runId: "r1" },
      );
      expect(r.status).toBe("succeeded");
      const invoiceInsert = inserts.find(
        (i) => (i.values as { type?: string }).type === "recurring",
      );
      expect(invoiceInsert).toBeDefined();
      expect((invoiceInsert!.values as { status: string }).status).toBe(
        "draft",
      );
      // No charge row (createCharge: false).
      const chargeInsert = inserts.find(
        (i) =>
          (i.values as { stripePaymentIntentId?: unknown })
            .stripePaymentIntentId !== undefined,
      );
      expect(chargeInsert).toBeUndefined();
      // No ledger entries (ledgerPairCount: 0).
      expect(mockLedger.recordMigrationPayrollFinalized).not.toHaveBeenCalled();
      expect(mockLedger.recordMigrationPayrollPayment).not.toHaveBeenCalled();
      // Metadata still stamped for adapter consistency.
      const meta = (
        invoiceInsert!.values as { metadata: Record<string, unknown> }
      ).metadata;
      expect(meta.monolith_original_status).toBe("un-paid");
    } finally {
      jest.useRealTimers();
    }
  });

  it("past un-paid placeholder (Payroll_Month <= today) → invoice 'finalized' (unchanged from previous behavior)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-05-25T00:00:00Z"));
    try {
      const r = await writer.write(
        {
          billingCustomerId: "bc-1",
          payrolls: [
            makePayroll({
              customerPayrollId: "p_past_unpaid",
              status: "un-paid",
              payrollMonth: "2026-04-30",
              paidOn: null,
              paymentDate: null,
            }),
          ],
        },
        { dryRun: false, runId: "r1" },
      );
      expect(r.status).toBe("succeeded");
      const invoiceInsert = inserts.find(
        (i) => (i.values as { type?: string }).type === "recurring",
      );
      expect((invoiceInsert!.values as { status: string }).status).toBe(
        "finalized",
      );
      const chargeInsert = inserts.find(
        (i) =>
          (i.values as { stripePaymentIntentId?: unknown })
            .stripePaymentIntentId !== undefined,
      );
      expect(chargeInsert).toBeUndefined();
      expect(mockLedger.recordMigrationPayrollFinalized).toHaveBeenCalledTimes(
        1,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("future un-paid + Failure=true → finalized + failed charge (Failure short-circuit wins)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-05-25T00:00:00Z"));
    try {
      const r = await writer.write(
        {
          billingCustomerId: "bc-1",
          payrolls: [
            makePayroll({
              customerPayrollId: "p_future_unpaid_failed",
              status: "un-paid",
              failure: true,
              payrollMonth: "2026-07-31",
              paidOn: null,
              paymentDate: null,
            }),
          ],
        },
        { dryRun: false, runId: "r1" },
      );
      expect(r.status).toBe("succeeded");
      const invoiceInsert = inserts.find(
        (i) => (i.values as { type?: string }).type === "recurring",
      );
      expect((invoiceInsert!.values as { status: string }).status).toBe(
        "finalized",
      );
      // Failure branch creates a failed charge row.
      const chargeInsert = inserts.find(
        (i) =>
          (i.values as { stripePaymentIntentId?: unknown })
            .stripePaymentIntentId !== undefined,
      );
      expect(chargeInsert).toBeDefined();
      expect((chargeInsert!.values as { status: string }).status).toBe(
        "failed",
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("un-paid + Payroll_Month exactly today → finalized (cutoff is strictly future)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-05-25T12:00:00Z"));
    try {
      const r = await writer.write(
        {
          billingCustomerId: "bc-1",
          payrolls: [
            makePayroll({
              customerPayrollId: "p_today_unpaid",
              status: "un-paid",
              payrollMonth: "2026-05-25T00:00:00Z",
              paidOn: null,
              paymentDate: null,
            }),
          ],
        },
        { dryRun: false, runId: "r1" },
      );
      expect(r.status).toBe("succeeded");
      const invoiceInsert = inserts.find(
        (i) => (i.values as { type?: string }).type === "recurring",
      );
      expect((invoiceInsert!.values as { status: string }).status).toBe(
        "finalized",
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("status preservation: status case + whitespace normalized in metadata (e.g. 'PENDING ' → 'pending')", async () => {
    const r = await writer.write(
      {
        billingCustomerId: "bc-1",
        payrolls: [
          makePayroll({
            customerPayrollId: "p_case",
            status: "  PENDING  ",
            paidOn: null,
            paymentDate: null,
          }),
        ],
      },
      { dryRun: false, runId: "r1" },
    );
    expect(r.status).toBe("succeeded");
    const invoiceInsert = inserts.find(
      (i) => (i.values as { type?: string }).type === "recurring",
    );
    const meta = (
      invoiceInsert!.values as { metadata: Record<string, unknown> }
    ).metadata;
    expect(meta.monolith_original_status).toBe("pending");
  });
});
