import { Test } from "@nestjs/testing";
import { CreditNotesRepository } from "./credit-notes.repository";
import { DRIZZLE_PROVIDER } from "../database/database.provider";

describe("CreditNotesRepository", () => {
  let repository: CreditNotesRepository;
  let mockDb: Record<string, jest.Mock>;

  const mockCreditNote = {
    id: "cn-001",
    customerId: "cust-001",
    invoiceId: "inv-001",
    amountCents: 2000,
    currency: "usd",
    reason: "Billing adjustment",
    status: "issued",
    createdBy: "admin",
    createdAt: new Date("2026-01-15T00:00:00Z"),
  };

  beforeEach(async () => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([mockCreditNote]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
    };

    const module = await Test.createTestingModule({
      providers: [
        CreditNotesRepository,
        { provide: DRIZZLE_PROVIDER, useValue: mockDb },
      ],
    }).compile();

    repository = module.get<CreditNotesRepository>(CreditNotesRepository);
  });

  describe("createInTx", () => {
    it("should insert credit note using provided transaction", async () => {
      const txMock = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        }),
      };

      await repository.createInTx(mockCreditNote as never, txMock as never);

      expect(txMock.insert).toHaveBeenCalled();
    });

    it("should not use the main db connection", async () => {
      const txMock = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        }),
      };

      await repository.createInTx(mockCreditNote as never, txMock as never);

      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("findByCustomer", () => {
    it("should return credit notes for a customer", async () => {
      // findByCustomer chain: select().from().where() — where is terminal
      mockDb.where.mockResolvedValueOnce([mockCreditNote]);

      const result = await repository.findByCustomer("cust-001");

      expect(result).toEqual([mockCreditNote]);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
    });

    it("should return empty array when no credit notes exist", async () => {
      mockDb.where.mockResolvedValueOnce([]);

      const result = await repository.findByCustomer("cust-999");

      expect(result).toEqual([]);
    });
  });

  describe("findForBillingHistory", () => {
    it("should return credit notes for a customer with pagination", async () => {
      mockDb.limit.mockResolvedValueOnce([mockCreditNote]);

      const result = await repository.findForBillingHistory("cust-001", {}, 20);

      expect(result).toEqual([mockCreditNote]);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
      expect(mockDb.orderBy).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(21);
    });

    it("should apply date range filters", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await repository.findForBillingHistory(
        "cust-001",
        {
          startDate: "2026-01-01T00:00:00.000Z",
          endDate: "2026-02-01T00:00:00.000Z",
        },
        10,
      );

      expect(mockDb.where).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(11);
    });

    it("should apply cursor filter using timestamp cursor", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await repository.findForBillingHistory(
        "cust-001",
        { cursor: new Date("2026-01-15T10:00:00.000Z") },
        20,
      );

      expect(mockDb.where).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(21);
    });
  });

  describe("inherited findById", () => {
    it("should find credit note by id", async () => {
      mockDb.limit.mockResolvedValueOnce([mockCreditNote]);

      const result = await repository.findById("cn-001");

      expect(result).toEqual(mockCreditNote);
    });

    it("should return null when not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await repository.findById("non-existent");

      expect(result).toBeNull();
    });
  });
});
