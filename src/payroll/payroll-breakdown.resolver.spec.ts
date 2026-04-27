import {
  CLOCK,
  Clock,
  PayrollBreakdownResolver,
  RawDiscountConfig,
  RawPayrollEmployee,
} from "./payroll-breakdown.resolver";
import { Test } from "@nestjs/testing";

const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

async function makeResolver(
  now: string = "2026-04-27T00:00:00.000Z",
): Promise<PayrollBreakdownResolver> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      PayrollBreakdownResolver,
      { provide: CLOCK, useValue: fixedClock(now) },
    ],
  }).compile();
  return moduleRef.get(PayrollBreakdownResolver);
}

// Fixture customer: Mark J. Pamer DO, LLC (Customer_ID Y9bJv_a8mL) — real 2025-prod customer.
// Single assigned employee Ar9vIPVQ7 Mahrukh Raza:
//   Gross_Salary $1000, Platform_Fee $1095, $300 flat discount, Duration=3, Start=2025-03-31T19:00Z.
// Discount window after UTC midnight normalization: [2025-03-31, 2025-06-30).
const PAMER_BASE_EMPLOYEE: Omit<RawPayrollEmployee, "bonuses"> = {
  employeeId: "Ar9vIPVQ7",
  employeeName: "Mahrukh Raza",
  salaryCents: 100000,
  platformFeeCents: 109500,
  discountConfig: {
    isDiscountedEmployee: true,
    flatRateCents: 30000,
    percentage: 0,
    startDate: "2025-03-31T19:00:00.000Z",
    durationMonths: 3,
  },
};

// Real bonus rows from Employee_Bonus for Ar9vIPVQ7 (truncated to those used by tests below).
const PAMER_BONUSES = [
  {
    bonusMonth: "2024-04-15T08:58:34.000Z",
    bonusCents: 50000,
    incrementAmountCents: 0,
    createdAt: "2024-05-15T09:05:46.156Z",
  },
  {
    bonusMonth: "2024-05-07T10:53:28.000Z",
    bonusCents: 2000,
    incrementAmountCents: 0,
    createdAt: "2024-06-13T15:06:10.890Z",
  },
  {
    bonusMonth: "2025-03-01T00:00:00.000Z",
    bonusCents: 0,
    incrementAmountCents: 0,
    createdAt: "2025-05-14T09:14:07.047Z",
  },
];

describe("PayrollBreakdownResolver", () => {
  describe("parity with monolith — Pamer DO LLC fixture", () => {
    it("pre-discount cycle with bonus in window: 2024-05 (cycleStart=May 1 2024)", async () => {
      const resolver = await makeResolver();
      const result = resolver.resolve(
        { employees: [{ ...PAMER_BASE_EMPLOYEE, bonuses: PAMER_BONUSES }] },
        new Date("2024-05-01T00:00:00.000Z"),
      );

      // Bonus window [Apr 1, May 1) UTC → 2024-04-15 row applies, $500 bonus
      // Discount inactive (cycleStart < discountStartDate)
      // customerCost = 1000 + 1095 + 500 = 2595
      expect(result.employees[0]).toEqual({
        employeeId: "Ar9vIPVQ7",
        employeeName: "Mahrukh Raza",
        customerCost: 259500,
        salary: 100000,
        platformFee: 109500,
        bonus: 50000,
        raise: 0,
        discount: 0,
      });
      expect(result.totalAmountCents).toBe(259500);
    });

    it("in-discount cycle, no bonus: 2025-06 (cycleStart=June 1 2025)", async () => {
      const resolver = await makeResolver();
      const result = resolver.resolve(
        { employees: [{ ...PAMER_BASE_EMPLOYEE, bonuses: PAMER_BONUSES }] },
        new Date("2025-06-01T00:00:00.000Z"),
      );

      // Bonus window [May 1, June 1) — no bonuses
      // Discount valid (cycleStart >= 2025-03-31 and < 2025-06-30)
      // discountedFee = 1095 - 300 = 795
      // customerCost = 1000 + 795 + 0 = 1795
      // discount = 1795 - (1000 + 1095 + 0) = -300
      expect(result.employees[0]).toEqual({
        employeeId: "Ar9vIPVQ7",
        employeeName: "Mahrukh Raza",
        customerCost: 179500,
        salary: 100000,
        platformFee: 109500,
        bonus: 0,
        raise: 0,
        discount: -30000,
      });
    });

    it("post-discount cycle, no bonus: 2025-07 (cycleStart=July 1 2025)", async () => {
      const resolver = await makeResolver();
      const result = resolver.resolve(
        { employees: [{ ...PAMER_BASE_EMPLOYEE, bonuses: PAMER_BONUSES }] },
        new Date("2025-07-01T00:00:00.000Z"),
      );

      // Bonus window [Jun 1, Jul 1) — no bonuses. Discount expired (cycleStart >= endDate=2025-06-30)
      expect(result.employees[0].customerCost).toBe(209500);
      expect(result.employees[0].discount).toBe(0);
      expect(result.employees[0].bonus).toBe(0);
    });

    it("in-discount cycle with zero-bonus row in window: 2025-04 (cycleStart=April 1 2025)", async () => {
      const resolver = await makeResolver();
      const result = resolver.resolve(
        { employees: [{ ...PAMER_BASE_EMPLOYEE, bonuses: PAMER_BONUSES }] },
        new Date("2025-04-01T00:00:00.000Z"),
      );

      // Bonus window [Mar 1, Apr 1) — 2025-03-01 row applies with Bonus=0
      // Discount valid → discountedFee = 795
      // customerCost = 1000 + 795 + 0 = 1795
      expect(result.employees[0].customerCost).toBe(179500);
      expect(result.employees[0].discount).toBe(-30000);
      expect(result.employees[0].bonus).toBe(0);
    });
  });

  describe("bonus window selection rules", () => {
    const baseEmpNoDiscount: Omit<RawPayrollEmployee, "bonuses"> = {
      employeeId: "E1",
      employeeName: "E One",
      salaryCents: 100000,
      platformFeeCents: 100000,
      discountConfig: null,
    };

    it("picks the row with the latest Bonus_Month when multiple rows fall in the window", async () => {
      const resolver = await makeResolver();
      const bonuses = [
        {
          bonusMonth: "2024-04-15T08:00:00.000Z",
          bonusCents: 50000,
          incrementAmountCents: 0,
          createdAt: "2024-04-15T08:00:01.000Z",
        },
        {
          bonusMonth: "2024-04-25T08:00:00.000Z",
          bonusCents: 20000,
          incrementAmountCents: 1000,
          createdAt: "2024-04-25T08:00:01.000Z",
        },
        {
          bonusMonth: "2024-04-05T08:00:00.000Z",
          bonusCents: 99900,
          incrementAmountCents: 0,
          createdAt: "2024-04-05T08:00:01.000Z",
        },
      ];
      const result = resolver.resolve(
        { employees: [{ ...baseEmpNoDiscount, bonuses }] },
        new Date("2024-05-01T00:00:00.000Z"),
      );
      expect(result.employees[0].bonus).toBe(20000);
      expect(result.employees[0].raise).toBe(1000);
    });

    it("breaks ties on identical Bonus_Month with later createdAt", async () => {
      const resolver = await makeResolver();
      const bonuses = [
        {
          bonusMonth: "2024-04-20T00:00:00.000Z",
          bonusCents: 30000,
          incrementAmountCents: 0,
          createdAt: "2024-04-20T08:00:00.000Z",
        },
        {
          bonusMonth: "2024-04-20T00:00:00.000Z",
          bonusCents: 60000,
          incrementAmountCents: 0,
          createdAt: "2024-04-20T09:00:00.000Z",
        },
      ];
      const result = resolver.resolve(
        { employees: [{ ...baseEmpNoDiscount, bonuses }] },
        new Date("2024-05-01T00:00:00.000Z"),
      );
      expect(result.employees[0].bonus).toBe(60000);
    });

    it("includes a bonus on the bonusMonthStart boundary (>=)", async () => {
      const resolver = await makeResolver();
      const bonuses = [
        {
          bonusMonth: "2024-04-01T00:00:00.000Z",
          bonusCents: 12300,
          incrementAmountCents: 0,
          createdAt: "2024-04-01T00:00:00.000Z",
        },
      ];
      const result = resolver.resolve(
        { employees: [{ ...baseEmpNoDiscount, bonuses }] },
        new Date("2024-05-01T00:00:00.000Z"),
      );
      expect(result.employees[0].bonus).toBe(12300);
    });

    it("excludes a bonus exactly on the bonusMonthEnd boundary (<)", async () => {
      const resolver = await makeResolver();
      const bonuses = [
        {
          bonusMonth: "2024-05-01T00:00:00.000Z",
          bonusCents: 12300,
          incrementAmountCents: 0,
          createdAt: "2024-05-01T00:00:00.000Z",
        },
      ];
      const result = resolver.resolve(
        { employees: [{ ...baseEmpNoDiscount, bonuses }] },
        new Date("2024-05-01T00:00:00.000Z"),
      );
      expect(result.employees[0].bonus).toBe(0);
    });
  });

  describe("discount validation branches", () => {
    const baseEmp: Omit<RawPayrollEmployee, "discountConfig" | "bonuses"> = {
      employeeId: "E1",
      employeeName: "E One",
      salaryCents: 100000,
      platformFeeCents: 100000,
    };

    it("perpetual discount (no Duration, no Start_Date) is always valid", async () => {
      const resolver = await makeResolver();
      const config: RawDiscountConfig = {
        isDiscountedEmployee: true,
        flatRateCents: 0,
        percentage: 50,
        startDate: null,
        durationMonths: null,
      };
      const result = resolver.resolve(
        { employees: [{ ...baseEmp, discountConfig: config, bonuses: [] }] },
        new Date("2024-01-01T00:00:00.000Z"),
      );
      // discount = ceil(0.5 * 1000) = 500. customerCost = 1000 + 500 = 1500
      expect(result.employees[0].customerCost).toBe(150000);
      expect(result.employees[0].discount).toBe(-50000);
    });

    it("perpetual-with-start: today >= start → valid", async () => {
      const resolver = await makeResolver("2026-04-27T00:00:00.000Z");
      const config: RawDiscountConfig = {
        isDiscountedEmployee: true,
        flatRateCents: 0,
        percentage: 20,
        startDate: "2025-01-01T00:00:00.000Z",
        durationMonths: null,
      };
      const result = resolver.resolve(
        { employees: [{ ...baseEmp, discountConfig: config, bonuses: [] }] },
        new Date("2026-05-01T00:00:00.000Z"),
      );
      // ceil(0.20 * 1000) = 200. customerCost = 1000 + 800 = 1800
      expect(result.employees[0].customerCost).toBe(180000);
      expect(result.employees[0].discount).toBe(-20000);
    });

    it("perpetual-with-start: today < start → invalid", async () => {
      const resolver = await makeResolver("2024-12-01T00:00:00.000Z");
      const config: RawDiscountConfig = {
        isDiscountedEmployee: true,
        flatRateCents: 0,
        percentage: 20,
        startDate: "2025-01-01T00:00:00.000Z",
        durationMonths: null,
      };
      const result = resolver.resolve(
        { employees: [{ ...baseEmp, discountConfig: config, bonuses: [] }] },
        new Date("2025-01-01T00:00:00.000Z"),
      );
      expect(result.employees[0].customerCost).toBe(200000);
      expect(result.employees[0].discount).toBe(0);
    });

    it("limited discount: payDate exactly on startDate → valid (>=)", async () => {
      const resolver = await makeResolver();
      const config: RawDiscountConfig = {
        isDiscountedEmployee: true,
        flatRateCents: 30000,
        percentage: 0,
        startDate: "2025-01-01T00:00:00.000Z",
        durationMonths: 2,
      };
      const result = resolver.resolve(
        { employees: [{ ...baseEmp, discountConfig: config, bonuses: [] }] },
        new Date("2025-01-01T00:00:00.000Z"),
      );
      // discountedFee = 1000 - 300 = 700. customerCost = 1000 + 700 = 1700
      expect(result.employees[0].customerCost).toBe(170000);
    });

    it("limited discount: payDate exactly on endDate → invalid (<)", async () => {
      const resolver = await makeResolver();
      const config: RawDiscountConfig = {
        isDiscountedEmployee: true,
        flatRateCents: 30000,
        percentage: 0,
        startDate: "2025-01-01T00:00:00.000Z",
        durationMonths: 2,
      };
      const result = resolver.resolve(
        { employees: [{ ...baseEmp, discountConfig: config, bonuses: [] }] },
        new Date("2025-03-01T00:00:00.000Z"),
      );
      expect(result.employees[0].customerCost).toBe(200000);
      expect(result.employees[0].discount).toBe(0);
    });

    it("Discounted_Employee=true but flatRate=0 and percentage=0 → no discount", async () => {
      const resolver = await makeResolver();
      const config: RawDiscountConfig = {
        isDiscountedEmployee: true,
        flatRateCents: 0,
        percentage: 0,
        startDate: null,
        durationMonths: null,
      };
      const result = resolver.resolve(
        { employees: [{ ...baseEmp, discountConfig: config, bonuses: [] }] },
        new Date("2024-01-01T00:00:00.000Z"),
      );
      expect(result.employees[0].customerCost).toBe(200000);
      expect(result.employees[0].discount).toBe(0);
    });

    it("discountConfig=null → no discount", async () => {
      const resolver = await makeResolver();
      const result = resolver.resolve(
        { employees: [{ ...baseEmp, discountConfig: null, bonuses: [] }] },
        new Date("2024-01-01T00:00:00.000Z"),
      );
      expect(result.employees[0].customerCost).toBe(200000);
    });
  });

  describe("rounding parity", () => {
    it("percentage discount uses dollar-level Math.ceil — fractional cents case", async () => {
      const resolver = await makeResolver();
      const emp: RawPayrollEmployee = {
        employeeId: "E1",
        employeeName: "E One",
        salaryCents: 10000, // $100
        platformFeeCents: 10050, // $100.50
        discountConfig: {
          isDiscountedEmployee: true,
          flatRateCents: 0,
          percentage: 10,
          startDate: null,
          durationMonths: null,
        },
        bonuses: [],
      };
      const result = resolver.resolve(
        { employees: [emp] },
        new Date("2024-01-01T00:00:00.000Z"),
      );
      // dollar-level: ceil(0.10 * 100.50) = ceil(10.05) = 11
      // discountedFee = 100.50 - 11 = 89.50
      // customerCost = 100 + 89.50 = 189.50 → 18950c
      expect(result.employees[0].customerCost).toBe(18950);
      expect(result.employees[0].discount).toBe(-1100);
    });

    it("flat discount > platform fee produces negative discountedFee (no floor)", async () => {
      const resolver = await makeResolver();
      const emp: RawPayrollEmployee = {
        employeeId: "E1",
        employeeName: "E One",
        salaryCents: 100000, // $1000
        platformFeeCents: 5000, // $50
        discountConfig: {
          isDiscountedEmployee: true,
          flatRateCents: 10000,
          percentage: 0,
          startDate: null,
          durationMonths: null,
        },
        bonuses: [],
      };
      const result = resolver.resolve(
        { employees: [emp] },
        new Date("2024-01-01T00:00:00.000Z"),
      );
      // discountedFee = 50 - 100 = -50
      // customerCost = 1000 - 50 = 950
      // discount = 950 - (1000 + 50 + 0) = -100
      expect(result.employees[0].customerCost).toBe(95000);
      expect(result.employees[0].discount).toBe(-10000);
    });
  });

  describe("input shape edge cases", () => {
    it("empty employees array → empty resolved breakdown", async () => {
      const resolver = await makeResolver();
      const result = resolver.resolve(
        { employees: [] },
        new Date("2025-01-01T00:00:00.000Z"),
      );
      expect(result.employees).toEqual([]);
      expect(result.totalAmountCents).toBe(0);
    });

    it("undefined employees → empty resolved breakdown", async () => {
      const resolver = await makeResolver();
      const result = resolver.resolve({}, new Date("2025-01-01T00:00:00.000Z"));
      expect(result.employees).toEqual([]);
      expect(result.totalAmountCents).toBe(0);
    });

    it("multiple employees: total is sum of customerCosts", async () => {
      const resolver = await makeResolver();
      const e1: RawPayrollEmployee = {
        employeeId: "E1",
        employeeName: "E One",
        salaryCents: 100000,
        platformFeeCents: 100000,
        discountConfig: null,
        bonuses: [],
      };
      const e2: RawPayrollEmployee = {
        employeeId: "E2",
        employeeName: "E Two",
        salaryCents: 200000,
        platformFeeCents: 50000,
        discountConfig: null,
        bonuses: [],
      };
      const result = resolver.resolve(
        { employees: [e1, e2] },
        new Date("2024-01-01T00:00:00.000Z"),
      );
      expect(result.employees).toHaveLength(2);
      expect(result.totalAmountCents).toBe(200000 + 250000);
    });
  });
});
