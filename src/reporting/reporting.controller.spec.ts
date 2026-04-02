import { Test } from "@nestjs/testing";
import { ReportingController } from "./reporting.controller";
import { ReportingService } from "./reporting.service";
import type { RevenueReportResponseDto } from "./dto/revenue-report-response.dto";
import type { DunningReportResponseDto } from "./dto/dunning-report-response.dto";
import type { DashboardReportResponseDto } from "./dto/dashboard-report-response.dto";

describe("ReportingController", () => {
  let controller: ReportingController;
  let service: ReportingService;

  const mockReportingService = {
    getRevenueReport: jest.fn(),
    getReconciliationReport: jest.fn(),
    getDunningReport: jest.fn(),
    getDashboardReport: jest.fn(),
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [ReportingController],
      providers: [
        { provide: ReportingService, useValue: mockReportingService },
      ],
    }).compile();

    controller = module.get<ReportingController>(ReportingController);
    service = module.get<ReportingService>(ReportingService);
    jest.clearAllMocks();
  });

  describe("GET /v1/reports/revenue", () => {
    it("should delegate to service with parsed dates", async () => {
      const mockResponse: RevenueReportResponseDto = {
        totalInvoiced: 50000,
        totalCollected: 30000,
        totalOutstanding: 13000,
        totalWriteOff: 5000,
        totalCreditsIssued: 2000,
        netRevenue: 25000,
        currency: "usd",
        periodStart: "2026-01-01",
        periodEnd: "2026-02-01",
      };

      mockReportingService.getRevenueReport.mockResolvedValueOnce(mockResponse);

      const result = await controller.getRevenueReport({
        startDate: "2026-01-01",
        endDate: "2026-02-01",
      });

      expect(service.getRevenueReport).toHaveBeenCalledWith(
        "2026-01-01",
        "2026-02-01",
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe("GET /v1/reports/reconciliation", () => {
    it("should delegate to service with query params", async () => {
      const mockResponse = {
        data: [],
        cursor: null,
        hasMore: false,
      };

      mockReportingService.getReconciliationReport.mockResolvedValueOnce(
        mockResponse,
      );

      const query = {
        status: "balanced",
        startDate: "2026-01-01",
        endDate: "2026-02-01",
        limit: 20,
      };

      const result = await controller.getReconciliationReport(query);

      expect(service.getReconciliationReport).toHaveBeenCalledWith(query);
      expect(result).toEqual(mockResponse);
    });
  });

  describe("GET /v1/reports/dunning", () => {
    it("should delegate to service with query params", async () => {
      const mockResponse: DunningReportResponseDto = {
        totalInvoicesInDunning: 5,
        totalRecovered: { count: 3, amountCents: 30000 },
        totalEscalated: { count: 1, amountCents: 10000 },
        recoveryRate: 60,
        averageRecoveryAttempts: 1.67,
        recoveryByAttempt: [{ attemptNumber: 1, count: 3 }],
        periodStart: "2026-01-01",
        periodEnd: "2026-02-01",
      };

      mockReportingService.getDunningReport.mockResolvedValueOnce(mockResponse);

      const result = await controller.getDunningReport({
        startDate: "2026-01-01",
        endDate: "2026-02-01",
      });

      expect(service.getDunningReport).toHaveBeenCalledWith(
        "2026-01-01",
        "2026-02-01",
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe("GET /v1/reports/dashboard", () => {
    it("should delegate to service with no params", async () => {
      const mockResponse: DashboardReportResponseDto = {
        activeSubscriptions: 10,
        monthlyRecurringRevenue: 100000,
        currentMonthInvoiced: 50000,
        currentMonthCollected: 30000,
        currentMonthOutstanding: 13000,
        paymentSuccessRate: 95,
        dunningRecoveryRate: 80,
        reconciliationStatus: "balanced",
        currency: "usd",
        periodStart: "2026-02-01T00:00:00.000Z",
        periodEnd: "2026-03-01T00:00:00.000Z",
      };

      mockReportingService.getDashboardReport.mockResolvedValueOnce(
        mockResponse,
      );

      const result = await controller.getDashboardReport();

      expect(service.getDashboardReport).toHaveBeenCalled();
      expect(result).toEqual(mockResponse);
    });
  });
});
