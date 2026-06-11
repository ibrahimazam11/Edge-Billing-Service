import { ChargesWriter } from "./charges.writer";
import type { InvoicesRepository } from "../../invoices/invoices.repository";
import type { PaymentMethodsRepository } from "../../payment-methods/payment-methods.repository";
import type { LedgerService } from "../../ledger/ledger.service";
import type { ChargeInputDto } from "../dto/migrate-customer-body.dto";

function makeCharge(over: Partial<ChargeInputDto> = {}): ChargeInputDto {
  return {
    chargeId: 42,
    amount: "100",
    chargeType: "ONBOARDING",
    paymentStatus: "paid",
    paymentDate: "2026-03-01",
    lineItems: [],
    ...over,
  };
}

describe("ChargesWriter", () => {
  let writer: ChargesWriter;
  let mockInvoicesRepo: { findByMonolithMetadata: jest.Mock };
  let mockPmRepo: { findAllByCustomerUnfiltered: jest.Mock };
  let mockLedger: Record<string, jest.Mock>;
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
      recordMigrationInvoiceFinalized: jest.fn().mockResolvedValue("l1"),
      recordMigrationPayment: jest.fn().mockResolvedValue("l2"),
      recordMigrationVoidReversal: jest.fn().mockResolvedValue("l3"),
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
    writer = new ChargesWriter(
      mockDb as never,
      mockInvoicesRepo as unknown as InvoicesRepository,
      mockPmRepo as unknown as PaymentMethodsRepository,
      mockLedger as unknown as LedgerService,
    );
  });

  it("ONBOARDING maps to invoice.type='onboarding'", async () => {
    await writer.write(
      { billingCustomerId: "bc-1", charges: [makeCharge()] },
      { dryRun: false, runId: "r1" },
    );
    const invoiceInsert = inserts.find(
      (i) => (i.values as { type?: string }).type === "onboarding",
    );
    expect(invoiceInsert).toBeDefined();
  });

  it("ONE_TIME maps to invoice.type='one_time'", async () => {
    await writer.write(
      {
        billingCustomerId: "bc-1",
        charges: [makeCharge({ chargeType: "ONE_TIME" })],
      },
      { dryRun: false, runId: "r1" },
    );
    const invoiceInsert = inserts.find(
      (i) => (i.values as { type?: string }).type === "one_time",
    );
    expect(invoiceInsert).toBeDefined();
  });

  it("P4: paid status with no paymentDate sets paidAt=null", async () => {
    await writer.write(
      {
        billingCustomerId: "bc-1",
        charges: [makeCharge({ paymentDate: null })],
      },
      { dryRun: false, runId: "r1" },
    );
    const invoiceInsert = inserts.find((i) =>
      ["onboarding", "one_time"].includes(
        (i.values as { type?: string }).type ?? "",
      ),
    );
    expect(invoiceInsert!.values.paidAt).toBeNull();
  });

  it("P8: fails no_payment_method when customer has no PMs and status requires charges row", async () => {
    mockPmRepo.findAllByCustomerUnfiltered.mockResolvedValueOnce([]);
    const result = await writer.write(
      {
        billingCustomerId: "bc-1",
        charges: [makeCharge()],
      },
      { dryRun: false, runId: "r1" },
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("no_payment_method");
    // No invoice insert should have happened
    expect(inserts).toHaveLength(0);
  });

  it("P10: line items sum to 100.00 but totalAmount=101.00 → invoice uses authoritative totalCents and warns", async () => {
    const warnSpy = jest
      .spyOn(
        (writer as unknown as { logger: { warn: (...a: unknown[]) => void } })
          .logger,
        "warn",
      )
      .mockImplementation(() => undefined);
    await writer.write(
      {
        billingCustomerId: "bc-1",
        charges: [
          makeCharge({
            amount: "101.00",
            lineItems: [{ fee: "100.00", employeeName: "Alice" } as never],
          }),
        ],
      },
      { dryRun: false, runId: "r1" },
    );
    const invoiceInsert = inserts.find((i) =>
      ["onboarding", "one_time"].includes(
        (i.values as { type?: string }).type ?? "",
      ),
    );
    expect(invoiceInsert).toBeDefined();
    expect(invoiceInsert!.values.totalAmountCents).toBe(10100);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "charges.writer.line_item_sum_mismatch",
        monolithChargeId: 42,
        lineItemSum: 10000,
        totalCents: 10100,
        delta: -100,
      }),
    );
    warnSpy.mockRestore();
  });

  it("Bug 2 fix: dry-run on already-migrated charge row reports skipped per-row", async () => {
    mockInvoicesRepo.findByMonolithMetadata.mockResolvedValueOnce({
      id: "existing-invoice",
    });
    const result = await writer.write(
      { billingCustomerId: "bc-1", charges: [makeCharge()] },
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

  it("dry-run reports planned actions without DB writes", async () => {
    const result = await writer.write(
      { billingCustomerId: "bc-1", charges: [makeCharge()] },
      { dryRun: true, runId: "r1" },
    );
    expect(result.status).toBe("succeeded");
    expect((result as { details?: unknown[] }).details).toHaveLength(1);
    expect(inserts).toHaveLength(0);
  });
});
