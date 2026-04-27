import { Test } from "@nestjs/testing";
import { InvoicesRepository } from "./invoices.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

const now = new Date("2026-03-01T00:00:00.000Z");

const mockInvoiceRow = {
  id: "inv-123",
  customerId: "cust-123",
  subscriptionId: "sub-123",
  status: "finalized",
  totalAmountCents: 5000,
  currency: "usd",
  billingPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
  dueDate: new Date("2026-04-01T00:00:00.000Z"),
  paidAt: null,
  voidedAt: null,
  metadata: null,
  createdAt: now,
  updatedAt: now,
};

const mockLineItemRow = {
  id: "li-123",
  invoiceId: "inv-123",
  type: "base_fee",
  description: "standard-monthly - monthly subscription",
  amountCents: 5000,
  quantity: 1,
  createdAt: now,
};

describe("InvoicesRepository", () => {
  let repository: InvoicesRepository;
  let selectChain: Record<string, jest.Mock>;
  let insertChain: Record<string, jest.Mock>;
  let updateChain: Record<string, jest.Mock>;
  let mockDb: Record<string, jest.Mock>;

  beforeEach(async () => {
    selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      orderBy: jest.fn().mockReturnThis(),
      then: jest.fn((resolve: (value: unknown[]) => void) => resolve([])),
    };

    insertChain = {
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([mockInvoiceRow]),
    };

    updateChain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([mockInvoiceRow]),
    };

    mockDb = {
      select: jest.fn(() => selectChain),
      insert: jest.fn(() => insertChain),
      update: jest.fn(() => updateChain),
      execute: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        InvoicesRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<InvoicesRepository>(InvoicesRepository);
  });

  describe("findById", () => {
    it("should return invoice when found", async () => {
      selectChain.limit.mockResolvedValueOnce([mockInvoiceRow]);

      const result = await repository.findById("inv-123");

      expect(result).toEqual(mockInvoiceRow);
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });

    it("should return null when not found", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findById("non-existent");

      expect(result).toBeNull();
    });

    it("should use tx when provided", async () => {
      const txMock = {
        select: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([mockInvoiceRow]),
      };

      const result = await repository.findById("inv-123", txMock as never);

      expect(result).toEqual(mockInvoiceRow);
      expect(txMock.select).toHaveBeenCalled();
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe("findByIdWithLineItems", () => {
    it("should return invoice with line items when found", async () => {
      selectChain.limit.mockResolvedValueOnce([mockInvoiceRow]);
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([mockLineItemRow]),
      );

      const result = await repository.findByIdWithLineItems("inv-123");

      expect(result).not.toBeNull();
      expect(result!.invoice).toEqual(mockInvoiceRow);
      expect(result!.lineItems).toEqual([mockLineItemRow]);
    });

    it("should return null when invoice not found", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findByIdWithLineItems("non-existent");

      expect(result).toBeNull();
    });

    it("should use transaction client when tx is provided", async () => {
      const txSelectChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([mockInvoiceRow]),
        then: jest.fn((resolve: (value: unknown[]) => void) =>
          resolve([mockLineItemRow]),
        ),
      };
      const txMock = {
        select: jest.fn(() => txSelectChain),
      };

      const result = await repository.findByIdWithLineItems(
        "inv-123",
        txMock as never,
      );

      expect(result).not.toBeNull();
      expect(result!.invoice).toEqual(mockInvoiceRow);
      expect(result!.lineItems).toEqual([mockLineItemRow]);
      // tx.select called twice: once for findById, once for line items
      expect(txMock.select).toHaveBeenCalledTimes(2);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe("findAll", () => {
    it("should return invoices with pagination", async () => {
      selectChain.limit.mockResolvedValueOnce([mockInvoiceRow]);

      const result = await repository.findAll({}, 20);

      expect(result).toEqual([mockInvoiceRow]);
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should apply filters", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.findAll(
        { customerId: "cust-123", status: "finalized", cursor: "id-1" },
        20,
      );

      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe("findPendingOnboarding", () => {
    it("should return pending onboarding invoices", async () => {
      const onboardingInvoice = {
        ...mockInvoiceRow,
        subscriptionId: null,
        status: "draft",
      };
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([onboardingInvoice]),
      );

      const result = await repository.findPendingOnboarding(new Date());

      expect(result).toEqual([onboardingInvoice]);
      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe("findDuplicateForSubscription", () => {
    it("should return existing invoices for the same period", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([mockInvoiceRow]),
      );

      const result = await repository.findDuplicateForSubscription(
        "sub-123",
        new Date("2026-03-01"),
        new Date("2026-04-01"),
      );

      expect(result).toEqual([mockInvoiceRow]);
    });

    it("should return empty when no duplicates", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([]),
      );

      const result = await repository.findDuplicateForSubscription(
        "sub-123",
        new Date("2026-03-01"),
        new Date("2026-04-01"),
      );

      expect(result).toEqual([]);
    });
  });

  describe("getLineItemsByInvoiceId", () => {
    it("should return line items for invoice", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([mockLineItemRow]),
      );

      const result = await repository.getLineItemsByInvoiceId("inv-123");

      expect(result).toEqual([mockLineItemRow]);
    });
  });

  describe("getLineItemsByInvoiceIds", () => {
    it("should return line items for multiple invoices", async () => {
      selectChain.then.mockImplementationOnce(
        (resolve: (value: unknown[]) => void) => resolve([mockLineItemRow]),
      );

      const result = await repository.getLineItemsByInvoiceIds(["inv-123"]);

      expect(result).toEqual([mockLineItemRow]);
    });

    it("should return empty for empty ids array", async () => {
      const result = await repository.getLineItemsByInvoiceIds([]);

      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe("create", () => {
    it("should insert and return invoice", async () => {
      insertChain.returning.mockResolvedValueOnce([mockInvoiceRow]);

      const result = await repository.create({
        id: "inv-123",
        customerId: "cust-123",
        status: "draft",
        totalAmountCents: 0,
        currency: "usd",
        billingPeriodStart: now,
        billingPeriodEnd: now,
        dueDate: now,
        createdAt: now,
        updatedAt: now,
      });

      expect(result).toEqual(mockInvoiceRow);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should use tx when provided", async () => {
      const txMock = {
        insert: jest.fn(() => ({
          values: jest.fn().mockReturnThis(),
          returning: jest.fn().mockResolvedValue([mockInvoiceRow]),
        })),
      };

      const result = await repository.create(
        {
          id: "inv-123",
          customerId: "cust-123",
          status: "draft",
          totalAmountCents: 0,
          currency: "usd",
          billingPeriodStart: now,
          billingPeriodEnd: now,
          dueDate: now,
          createdAt: now,
          updatedAt: now,
        },
        txMock as never,
      );

      expect(result).toEqual(mockInvoiceRow);
      expect(txMock.insert).toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("createLineItem", () => {
    it("should insert line item", async () => {
      await repository.createLineItem({
        id: "li-123",
        invoiceId: "inv-123",
        type: "base_fee",
        description: "test",
        amountCents: 5000,
        quantity: 1,
        createdAt: now,
      });

      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("should update and return invoice", async () => {
      const updated = { ...mockInvoiceRow, status: "finalized" };
      updateChain.returning.mockResolvedValueOnce([updated]);

      const result = await repository.update("inv-123", {
        status: "finalized",
      });

      expect(result).toEqual(updated);
      expect(updateChain.set).toHaveBeenCalledWith({ status: "finalized" });
    });
  });

  describe("updateWithConcurrencyCheck", () => {
    it("should return updated row when status matches", async () => {
      const voided = { ...mockInvoiceRow, status: "void" };
      updateChain.returning.mockResolvedValueOnce([voided]);

      const result = await repository.updateWithConcurrencyCheck(
        "inv-123",
        { status: "void" },
        "finalized",
      );

      expect(result).toEqual(voided);
      expect(updateChain.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should return null when status does not match (concurrent modification)", async () => {
      updateChain.returning.mockResolvedValueOnce([]);

      const result = await repository.updateWithConcurrencyCheck(
        "inv-123",
        { status: "void" },
        "finalized",
      );

      expect(result).toBeNull();
    });
  });

  describe("findForBillingHistory", () => {
    it("should return invoices for customer with filters", async () => {
      selectChain.limit.mockResolvedValueOnce([mockInvoiceRow]);

      const result = await repository.findForBillingHistory(
        "cust-123",
        { startDate: "2026-03-01" },
        20,
      );

      expect(result).toEqual([mockInvoiceRow]);
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should apply cursor as Date with lt for descending pagination", async () => {
      selectChain.limit.mockResolvedValueOnce([mockInvoiceRow]);

      const cursorDate = new Date("2026-03-15T00:00:00.000Z");
      const result = await repository.findForBillingHistory(
        "cust-123",
        { cursor: cursorDate },
        20,
      );

      expect(result).toEqual([mockInvoiceRow]);
      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
      expect(selectChain.orderBy).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should apply endDate with lt for half-open interval", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findForBillingHistory(
        "cust-123",
        { startDate: "2026-03-01", endDate: "2026-04-01" },
        20,
      );

      expect(result).toEqual([]);
      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe("searchForAdmin", () => {
    it("should return invoices with pagination", async () => {
      selectChain.limit.mockResolvedValueOnce([mockInvoiceRow]);

      const result = await repository.searchForAdmin({}, 20);

      expect(result).toEqual([mockInvoiceRow]);
      expect(selectChain.limit).toHaveBeenCalledWith(21);
      expect(selectChain.orderBy).toHaveBeenCalled();
    });

    it("should apply customerId filter", async () => {
      selectChain.limit.mockResolvedValueOnce([mockInvoiceRow]);

      const result = await repository.searchForAdmin(
        { customerId: "cust-123" },
        20,
      );

      expect(result).toEqual([mockInvoiceRow]);
      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should apply status filter", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.searchForAdmin({ status: "paid" }, 20);

      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should apply date range filters", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.searchForAdmin(
        { dateFrom: "2026-01-01", dateTo: "2026-02-01" },
        20,
      );

      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should apply amount range filters", async () => {
      selectChain.limit.mockResolvedValueOnce([mockInvoiceRow]);

      const result = await repository.searchForAdmin(
        { amountMin: 1000, amountMax: 10000 },
        20,
      );

      expect(result).toEqual([mockInvoiceRow]);
      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should accept amountMin = 0 as a valid filter", async () => {
      selectChain.limit.mockResolvedValueOnce([mockInvoiceRow]);

      const result = await repository.searchForAdmin({ amountMin: 0 }, 20);

      expect(result).toEqual([mockInvoiceRow]);
      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
    });

    it("should apply cursor filter with lt on id", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.searchForAdmin({ cursor: "inv-999" }, 20);

      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
      expect(selectChain.limit).toHaveBeenCalledWith(21);
    });

    it("should combine all filters", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.searchForAdmin(
        {
          customerId: "cust-123",
          status: "finalized",
          dateFrom: "2026-01-01",
          dateTo: "2026-02-01",
          amountMin: 1000,
          amountMax: 50000,
          cursor: "inv-999",
        },
        10,
      );

      expect(selectChain.where).toHaveBeenCalledWith(expect.anything());
      expect(selectChain.limit).toHaveBeenCalledWith(11);
    });
  });

  describe("findOpenRecurringDraft", () => {
    it("returns the recurring draft when one exists", async () => {
      const recurringDraft = {
        ...mockInvoiceRow,
        id: "inv-rec-draft",
        type: "recurring",
        status: "draft",
      };
      selectChain.limit.mockResolvedValueOnce([recurringDraft]);

      const result = await repository.findOpenRecurringDraft("cust-123");

      expect(result).toEqual(recurringDraft);
      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.orderBy).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });

    it("returns null when only a finalized invoice exists (filter excludes finalized)", async () => {
      // Repository's WHERE clause excludes status!=draft and type!=recurring;
      // the mock simulates that by returning empty.
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findOpenRecurringDraft("cust-only-finalized");

      expect(result).toBeNull();
    });

    it("returns null when only an onboarding draft exists (filter excludes type!=recurring)", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findOpenRecurringDraft("cust-onboarding-only");

      expect(result).toBeNull();
    });

    it("returns null when only a one-time invoice exists", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findOpenRecurringDraft("cust-onetime-only");

      expect(result).toBeNull();
    });

    it("returns null when no invoices exist for the customer", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findOpenRecurringDraft("cust-empty");

      expect(result).toBeNull();
    });

    it("uses orderBy DESC + limit(1) so most-recent draft wins on duplicate-draft anomalies", async () => {
      const newer = {
        ...mockInvoiceRow,
        id: "inv-newer",
        type: "recurring",
        status: "draft",
      };
      selectChain.limit.mockResolvedValueOnce([newer]);

      const result = await repository.findOpenRecurringDraft("cust-123");

      expect(result?.id).toBe("inv-newer");
      expect(selectChain.orderBy).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });
  });

  describe("countOpenRecurringDrafts", () => {
    it("returns 0 when no drafts exist", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.countOpenRecurringDrafts("cust-zero");

      expect(result).toBe(0);
    });

    it("returns 1 in the healthy case", async () => {
      selectChain.limit.mockResolvedValueOnce([{ id: "inv-rec-draft" }]);

      const result = await repository.countOpenRecurringDrafts("cust-one");

      expect(result).toBe(1);
      expect(selectChain.limit).toHaveBeenCalledWith(2);
    });

    it("returns 2 to surface the upstream invariant break (capped scan)", async () => {
      selectChain.limit.mockResolvedValueOnce([
        { id: "inv-1" },
        { id: "inv-2" },
      ]);

      const result = await repository.countOpenRecurringDrafts("cust-anomaly");

      expect(result).toBe(2);
      expect(selectChain.limit).toHaveBeenCalledWith(2);
    });
  });

  describe("findDraftByCustomerId", () => {
    it("should return draft invoice when one exists", async () => {
      const draftInvoice = {
        ...mockInvoiceRow,
        id: "inv-draft-1",
        status: "draft",
      };
      selectChain.limit.mockResolvedValueOnce([draftInvoice]);

      const result = await repository.findDraftByCustomerId("cust-123");

      expect(result).toEqual(draftInvoice);
      expect(mockDb.select).toHaveBeenCalled();
      expect(selectChain.from).toHaveBeenCalled();
      expect(selectChain.where).toHaveBeenCalled();
      expect(selectChain.orderBy).toHaveBeenCalled();
      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });

    it("should return null when only finalized invoices exist", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findDraftByCustomerId("cust-123");

      expect(result).toBeNull();
    });

    it("should return null when no invoices exist for customer", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      const result = await repository.findDraftByCustomerId("cust-no-invoices");

      expect(result).toBeNull();
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("should query with limit 1", async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await repository.findDraftByCustomerId("cust-123");

      expect(selectChain.limit).toHaveBeenCalledWith(1);
    });
  });

  describe("getBillingStatsForMigration", () => {
    it("should return billing stats for a customer and metadata key", async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ count: 5, paidCount: 3, totalCents: 50000 }],
      });

      const result = await repository.getBillingStatsForMigration(
        "cust-123",
        "monolith_charge_id",
      );

      expect(result).toEqual({ count: 5, paidCount: 3, totalCents: 50000 });
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("should return zeroes when no rows returned", async () => {
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

      const result = await repository.getBillingStatsForMigration(
        "cust-unknown",
        "monolith_charge_id",
      );

      expect(result).toEqual({ count: 0, paidCount: 0, totalCents: 0 });
    });

    it("should return zeroes when row has all zero values", async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ count: 0, paidCount: 0, totalCents: 0 }],
      });

      const result = await repository.getBillingStatsForMigration(
        "cust-123",
        "monolith_payroll_id",
      );

      expect(result).toEqual({ count: 0, paidCount: 0, totalCents: 0 });
    });
  });
});
