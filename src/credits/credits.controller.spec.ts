import { Test } from "@nestjs/testing";
import { CreditsController } from "./credits.controller";
import { CreditsService } from "./credits.service";
import { CustomerNotFoundException } from "../common/exceptions/customer-not-found.exception";
import { CreditExceedsInvoiceException } from "../common/exceptions/credit-exceeds-invoice.exception";
import type { IssueCreditNoteDto } from "./dto/issue-credit-note.dto";
import type { CreditNoteResponseDto } from "./dto/credit-note-response.dto";
import type { CreditBalanceResponseDto } from "./dto/credit-balance-response.dto";

describe("CreditsController", () => {
  let controller: CreditsController;
  let mockCreditsService: {
    issueCreditNote: jest.Mock;
    getCreditBalance: jest.Mock;
  };

  const MOCK_CREDIT_NOTE_RESPONSE: CreditNoteResponseDto = {
    id: "cn-001",
    customerId: "c0000000-0000-4000-a000-000000000001",
    invoiceId: "a0000000-0000-4000-a000-000000000010",
    amountCents: 2000,
    currency: "usd",
    reason: "Billing adjustment",
    status: "issued",
    createdBy: "admin",
    createdAt: "2026-01-15T00:00:00.000Z",
  };

  const MOCK_BALANCE_RESPONSE: CreditBalanceResponseDto = {
    customerId: "c0000000-0000-4000-a000-000000000001",
    balanceCents: 5000,
    currency: "usd",
    updatedAt: "2026-01-15T00:00:00.000Z",
  };

  beforeEach(async () => {
    mockCreditsService = {
      issueCreditNote: jest.fn().mockResolvedValue(MOCK_CREDIT_NOTE_RESPONSE),
      getCreditBalance: jest.fn().mockResolvedValue(MOCK_BALANCE_RESPONSE),
    };

    const module = await Test.createTestingModule({
      controllers: [CreditsController],
      providers: [{ provide: CreditsService, useValue: mockCreditsService }],
    }).compile();

    controller = module.get<CreditsController>(CreditsController);
  });

  describe("POST /v1/credit-notes", () => {
    const dto: IssueCreditNoteDto = {
      customerId: "c0000000-0000-4000-a000-000000000001",
      invoiceId: "a0000000-0000-4000-a000-000000000010",
      amountCents: 2000,
      reason: "Billing adjustment",
      createdBy: "admin",
    };

    it("should return 201 with credit note response", async () => {
      const result = await controller.createCreditNote(dto, "corr-001");

      expect(result).toEqual(MOCK_CREDIT_NOTE_RESPONSE);
      expect(mockCreditsService.issueCreditNote).toHaveBeenCalledWith(
        dto,
        "corr-001",
      );
    });

    it("should use 'unknown' as correlationId when header is missing", async () => {
      await controller.createCreditNote(dto, undefined);

      expect(mockCreditsService.issueCreditNote).toHaveBeenCalledWith(
        dto,
        "unknown",
      );
    });

    it("should propagate CustomerNotFoundException", async () => {
      mockCreditsService.issueCreditNote.mockRejectedValue(
        new CustomerNotFoundException(dto.customerId),
      );

      await expect(
        controller.createCreditNote(dto, "corr-001"),
      ).rejects.toThrow(CustomerNotFoundException);
    });

    it("should propagate CreditExceedsInvoiceException", async () => {
      mockCreditsService.issueCreditNote.mockRejectedValue(
        new CreditExceedsInvoiceException(10000, 5000),
      );

      await expect(
        controller.createCreditNote(dto, "corr-001"),
      ).rejects.toThrow(CreditExceedsInvoiceException);
    });
  });

  describe("GET /v1/customers/:id/credit-balance", () => {
    it("should return 200 with balance", async () => {
      const result = await controller.getCreditBalance(
        "c0000000-0000-4000-a000-000000000001",
      );

      expect(result).toEqual(MOCK_BALANCE_RESPONSE);
      expect(mockCreditsService.getCreditBalance).toHaveBeenCalledWith(
        "c0000000-0000-4000-a000-000000000001",
      );
    });

    it("should propagate CustomerNotFoundException", async () => {
      mockCreditsService.getCreditBalance.mockRejectedValue(
        new CustomerNotFoundException("invalid-id"),
      );

      await expect(controller.getCreditBalance("invalid-id")).rejects.toThrow(
        CustomerNotFoundException,
      );
    });
  });
});
