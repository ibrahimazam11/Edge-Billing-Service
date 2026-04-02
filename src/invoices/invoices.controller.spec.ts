import { Test } from "@nestjs/testing";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { InvoiceNotFoundException } from "./invoice-not-found.exception";
import type { InvoiceResponseDto } from "./dto/invoice-response.dto";

const mockInvoice: InvoiceResponseDto = {
  id: "inv-123",
  customerId: "cust-123",
  subscriptionId: "sub-123",
  status: "finalized",
  totalAmountCents: 5000,
  currency: "usd",
  billingPeriodStart: "2026-03-01T00:00:00.000Z",
  billingPeriodEnd: "2026-04-01T00:00:00.000Z",
  dueDate: "2026-04-01T00:00:00.000Z",
  paidAt: null,
  voidedAt: null,
  metadata: null,
  lineItems: [
    {
      id: "li-123",
      invoiceId: "inv-123",
      type: "base_fee",
      description: "standard-monthly - monthly subscription",
      amountCents: 5000,
      quantity: 1,
      createdAt: "2026-03-01T00:00:00.000Z",
    },
  ],
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
};

const mockVoidedInvoice: InvoiceResponseDto = {
  ...mockInvoice,
  status: "void",
  voidedAt: "2026-03-15T00:00:00.000Z",
};

const mockInvoicesService = {
  findById: jest.fn(),
  findAll: jest.fn(),
  voidInvoice: jest.fn(),
};

describe("InvoicesController", () => {
  let controller: InvoicesController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      controllers: [InvoicesController],
      providers: [{ provide: InvoicesService, useValue: mockInvoicesService }],
    }).compile();

    controller = module.get<InvoicesController>(InvoicesController);
  });

  describe("GET /v1/invoices/:id", () => {
    it("should return invoice with line items when found", async () => {
      mockInvoicesService.findById.mockResolvedValue(mockInvoice);

      const result = await controller.findById("inv-123");

      expect(result).toEqual(mockInvoice);
      expect(result.lineItems).toHaveLength(1);
    });

    it("should throw InvoiceNotFoundException when not found", async () => {
      mockInvoicesService.findById.mockResolvedValue(null);

      await expect(controller.findById("non-existent")).rejects.toThrow(
        InvoiceNotFoundException,
      );
    });
  });

  describe("GET /v1/invoices", () => {
    it("should return paginated invoices with filters", async () => {
      const paginatedResult = {
        data: [mockInvoice],
        cursor: null,
        hasMore: false,
      };
      mockInvoicesService.findAll.mockResolvedValue(paginatedResult);

      const result = await controller.findAll({
        customerId: "cust-123",
        status: "finalized",
      });

      expect(result).toEqual(paginatedResult);
      expect(mockInvoicesService.findAll).toHaveBeenCalledWith({
        customerId: "cust-123",
        status: "finalized",
      });
    });

    it("should return empty list when no matches", async () => {
      mockInvoicesService.findAll.mockResolvedValue({
        data: [],
        cursor: null,
        hasMore: false,
      });

      const result = await controller.findAll({});

      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
    });
  });

  describe("POST /v1/invoices/:id/void", () => {
    it("should return 200 with voided invoice", async () => {
      mockInvoicesService.voidInvoice.mockResolvedValue(mockVoidedInvoice);

      const result = await controller.voidInvoice("inv-123", "corr-123");

      expect(result).toEqual(mockVoidedInvoice);
      expect(result.status).toBe("void");
      expect(result.voidedAt).toBeDefined();
      expect(mockInvoicesService.voidInvoice).toHaveBeenCalledWith(
        "inv-123",
        "corr-123",
      );
    });

    it("should pass through exceptions from service", async () => {
      mockInvoicesService.voidInvoice.mockRejectedValue(
        new InvoiceNotFoundException("inv-999"),
      );

      await expect(
        controller.voidInvoice("inv-999", "corr-123"),
      ).rejects.toThrow(InvoiceNotFoundException);
    });
  });
});
