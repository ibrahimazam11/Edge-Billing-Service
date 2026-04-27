import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { TimeMachineService } from "./time-machine.service";
import { CustomersService } from "../customers/customers.service";
import { SubscriptionsRepository } from "../subscriptions/subscriptions.repository";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicesRepository } from "../invoices/invoices.repository";
import { ChargesRepository } from "../charges/charges.repository";

describe("TimeMachineService", () => {
  let service: TimeMachineService;
  let configService: { get: jest.Mock };
  let customersService: { findByMonolithId: jest.Mock };
  let subscriptionsRepository: {
    findByCustomerAndStatuses: jest.Mock;
    update: jest.Mock;
    findById: jest.Mock;
  };
  let invoicesService: { generateInvoicesForDueSubscriptions: jest.Mock };
  let invoicesRepository: { findDuplicateForSubscription: jest.Mock };
  let chargesRepository: { findByInvoiceId: jest.Mock };

  const customerId = "c0000000-0000-4000-a000-000000000001";
  const subscriptionId = "sub00000-0000-4000-a000-000000000001";
  const invoiceId = "inv00000-0000-4000-a000-000000000001";
  const oldStart = new Date("2026-04-01T00:00:00.000Z");
  const oldEnd = new Date("2026-05-01T00:00:00.000Z");
  const oldNext = new Date("2026-04-30T00:00:00.000Z");
  const newStart = new Date("2026-05-01T00:00:00.000Z");
  const newEnd = new Date("2026-06-01T00:00:00.000Z");
  const newNext = new Date("2026-05-30T00:00:00.000Z");

  const activeSubscription = {
    id: subscriptionId,
    customerId,
    status: "active",
    billingPeriodStart: oldStart,
    billingPeriodEnd: oldEnd,
    nextBillingDate: oldNext,
  };

  const advancedSubscription = {
    ...activeSubscription,
    billingPeriodStart: newStart,
    billingPeriodEnd: newEnd,
    nextBillingDate: newNext,
  };

  beforeEach(async () => {
    configService = { get: jest.fn().mockReturnValue("development") };
    customersService = {
      findByMonolithId: jest.fn().mockResolvedValue({
        id: customerId,
        monolithCustomerId: "ext-123",
      }),
    };
    subscriptionsRepository = {
      findByCustomerAndStatuses: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn(),
    };
    invoicesService = {
      generateInvoicesForDueSubscriptions: jest
        .fn()
        .mockResolvedValue({ created: 1, skipped: 0, finalized: 0 }),
    };
    invoicesRepository = { findDuplicateForSubscription: jest.fn() };
    chargesRepository = { findByInvoiceId: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeMachineService,
        { provide: ConfigService, useValue: configService },
        { provide: CustomersService, useValue: customersService },
        {
          provide: SubscriptionsRepository,
          useValue: subscriptionsRepository,
        },
        { provide: InvoicesService, useValue: invoicesService },
        { provide: InvoicesRepository, useValue: invoicesRepository },
        { provide: ChargesRepository, useValue: chargesRepository },
      ],
    }).compile();

    service = module.get(TimeMachineService);
  });

  describe("env guard", () => {
    it("refuses to run when NODE_ENV is production", async () => {
      configService.get.mockReturnValue("production");

      await expect(service.advanceCycle("ext-123")).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(customersService.findByMonolithId).not.toHaveBeenCalled();
    });

    it("allows non-production values (dev/uat/staging/test)", async () => {
      subscriptionsRepository.findByCustomerAndStatuses.mockResolvedValue([
        activeSubscription,
      ]);
      subscriptionsRepository.findById.mockResolvedValue(advancedSubscription);
      invoicesRepository.findDuplicateForSubscription.mockResolvedValue([]);

      configService.get.mockReturnValue("uat");
      await expect(service.advanceCycle("ext-123")).resolves.toBeDefined();
    });
  });

  describe("lookup failures", () => {
    it("throws 404 when customer is missing", async () => {
      customersService.findByMonolithId.mockResolvedValue(null);

      await expect(service.advanceCycle("missing")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("throws 404 when no active subscription exists", async () => {
      subscriptionsRepository.findByCustomerAndStatuses
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(service.advanceCycle("ext-123")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("throws 409 when subscription is paused", async () => {
      subscriptionsRepository.findByCustomerAndStatuses
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ ...activeSubscription, status: "paused" }]);

      await expect(service.advanceCycle("ext-123")).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe("happy path", () => {
    beforeEach(() => {
      subscriptionsRepository.findByCustomerAndStatuses.mockResolvedValueOnce([
        activeSubscription,
      ]);
      subscriptionsRepository.findById.mockResolvedValue(advancedSubscription);
    });

    it("fast-forwards nextBillingDate and invokes the generator", async () => {
      invoicesRepository.findDuplicateForSubscription.mockResolvedValue([]);

      await service.advanceCycle("ext-123");

      expect(subscriptionsRepository.update).toHaveBeenCalledWith(
        subscriptionId,
        expect.objectContaining({
          nextBillingDate: expect.any(Date),
          updatedAt: expect.any(Date),
        }),
      );
      expect(
        invoicesService.generateInvoicesForDueSubscriptions,
      ).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^tm-/));
    });

    it("returns advanced after-state when billing period moved (card path)", async () => {
      invoicesRepository.findDuplicateForSubscription.mockResolvedValue([
        {
          id: invoiceId,
          status: "paid",
          type: "recurring",
          totalAmountCents: 10000,
          metadata: null,
          billingPeriodStart: oldStart,
          billingPeriodEnd: oldEnd,
        },
      ]);
      chargesRepository.findByInvoiceId.mockResolvedValue([
        {
          id: "ch-1",
          status: "succeeded",
          stripePaymentIntentId: "pi_test_123",
        },
      ]);

      const result = await service.advanceCycle("ext-123");

      expect(result.simulationId).toMatch(/^tm-/);
      expect(result.subscriptionId).toBe(subscriptionId);
      expect(result.beforeState.billingPeriodStart).toBe(
        oldStart.toISOString(),
      );
      expect(result.afterState.billingPeriodStart).toBe(newStart.toISOString());
      expect(result.afterState.advanceApplied).toBe(true);
      expect(result.invoice).toMatchObject({
        id: invoiceId,
        status: "paid",
        paymentStatus: "succeeded",
        stripePaymentIntentId: "pi_test_123",
      });
      expect(result.notes).toHaveLength(0);
    });

    it("reports advanceApplied true and no pending note for ACH path (advance now happens at finalization)", async () => {
      invoicesRepository.findDuplicateForSubscription.mockResolvedValue([
        {
          id: invoiceId,
          status: "finalized",
          type: "recurring",
          totalAmountCents: 10000,
          metadata: null,
          billingPeriodStart: oldStart,
          billingPeriodEnd: oldEnd,
        },
      ]);
      chargesRepository.findByInvoiceId.mockResolvedValue([
        { id: "ch-1", status: "pending", stripePaymentIntentId: "pi_ach_1" },
      ]);

      const result = await service.advanceCycle("ext-123");

      expect(result.afterState.advanceApplied).toBe(true);
      expect(result.invoice?.paymentStatus).toBe("pending");
      expect(result.notes).toHaveLength(0);
    });

    it("surfaces creditApplied from invoice metadata", async () => {
      invoicesRepository.findDuplicateForSubscription.mockResolvedValue([
        {
          id: invoiceId,
          status: "paid",
          type: "recurring",
          totalAmountCents: 9000,
          metadata: { creditAdjustmentCents: 1000 },
          billingPeriodStart: oldStart,
          billingPeriodEnd: oldEnd,
        },
      ]);
      chargesRepository.findByInvoiceId.mockResolvedValue([
        { id: "ch-1", status: "succeeded", stripePaymentIntentId: "pi_1" },
      ]);

      const result = await service.advanceCycle("ext-123");
      expect(result.invoice?.creditApplied).toBe(1000);
    });

    it("returns null invoice with a note when generator produced nothing", async () => {
      invoicesRepository.findDuplicateForSubscription.mockResolvedValue([]);
      invoicesService.generateInvoicesForDueSubscriptions.mockResolvedValue({
        created: 0,
        skipped: 0,
        finalized: 0,
      });

      const result = await service.advanceCycle("ext-123");

      expect(result.invoice).toBeNull();
      expect(result.notes.join(" ")).toMatch(/No invoice was produced/);
    });
  });
});
