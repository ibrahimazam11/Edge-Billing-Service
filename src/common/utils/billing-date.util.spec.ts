import {
  getBillingCycleDay,
  calculateInvoiceDueDate,
  calculateNextBillingPeriod,
} from "./billing-date.util";

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d)); // month is 1-based for readability
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("getBillingCycleDay", () => {
  it.each([
    [1, 1],
    [2, 2],
    [10, 10],
    [15, 15],
    [27, 27],
  ])("mid-month chargeDay=%d → cycleDay=%d", (chargeDay, expected) => {
    expect(getBillingCycleDay(chargeDay)).toBe(expected);
  });

  it.each([28, 29, 30, 31])(
    "boundary chargeDay=%d → cycleDay=1",
    (chargeDay) => {
      expect(getBillingCycleDay(chargeDay)).toBe(1);
    },
  );
});

describe("calculateInvoiceDueDate", () => {
  describe("prepaid customers", () => {
    // April billing period (billingPeriodStart = April 1 for boundary, April X for mid-month)
    it.each([
      // [chargeDay, billingPeriodStart, expectedDueDate]
      [1, "2026-04-01", "2026-04-01"],
      [2, "2026-04-02", "2026-04-02"],
      [10, "2026-04-10", "2026-04-10"],
      [15, "2026-04-15", "2026-04-15"],
      [28, "2026-04-01", "2026-03-28"],
      [29, "2026-04-01", "2026-03-29"],
      [30, "2026-04-01", "2026-03-30"],
      [31, "2026-04-01", "2026-03-31"],
    ])(
      "chargeDay=%d, billingStart=%s → dueDate=%s",
      (chargeDay, bpStart, expected) => {
        const result = calculateInvoiceDueDate(
          new Date(bpStart + "T00:00:00.000Z"),
          chargeDay,
          true,
        );
        expect(fmt(result)).toBe(expected);
      },
    );
  });

  describe("postpaid customers", () => {
    it.each([
      [1, "2026-04-01", "2026-05-01"],
      [2, "2026-04-02", "2026-05-02"],
      [10, "2026-04-10", "2026-05-10"],
      [15, "2026-04-15", "2026-05-15"],
      [28, "2026-04-01", "2026-04-28"],
      [29, "2026-04-01", "2026-04-29"],
      [30, "2026-04-01", "2026-04-30"],
      [31, "2026-04-01", "2026-04-30"], // April has 30 days → clamped
    ])(
      "chargeDay=%d, billingStart=%s → dueDate=%s",
      (chargeDay, bpStart, expected) => {
        const result = calculateInvoiceDueDate(
          new Date(bpStart + "T00:00:00.000Z"),
          chargeDay,
          false,
        );
        expect(fmt(result)).toBe(expected);
      },
    );
  });

  describe("February clamping", () => {
    it("chargeDay=30, prepaid, March billing → Feb 28 (non-leap)", () => {
      const result = calculateInvoiceDueDate(utc(2026, 3, 1), 30, true);
      expect(fmt(result)).toBe("2026-02-28");
    });

    it("chargeDay=29, prepaid, March billing → Feb 28 (non-leap)", () => {
      const result = calculateInvoiceDueDate(utc(2026, 3, 1), 29, true);
      expect(fmt(result)).toBe("2026-02-28");
    });

    it("chargeDay=29, prepaid, March billing → Feb 29 (leap year 2028)", () => {
      const result = calculateInvoiceDueDate(utc(2028, 3, 1), 29, true);
      expect(fmt(result)).toBe("2028-02-29");
    });

    it("chargeDay=31, prepaid, March billing → Feb 28 (non-leap)", () => {
      const result = calculateInvoiceDueDate(utc(2026, 3, 1), 31, true);
      expect(fmt(result)).toBe("2026-02-28");
    });
  });

  describe("year boundary", () => {
    it("chargeDay=28, prepaid, January billing → Dec 28 of prior year", () => {
      const result = calculateInvoiceDueDate(utc(2026, 1, 1), 28, true);
      expect(fmt(result)).toBe("2025-12-28");
    });

    it("chargeDay=1, postpaid, December billing → Jan 1 of next year", () => {
      const result = calculateInvoiceDueDate(utc(2026, 12, 1), 1, false);
      expect(fmt(result)).toBe("2027-01-01");
    });
  });

  describe("day 31 in 30-day months", () => {
    it("chargeDay=31, postpaid, April billing (cycle 1st→1st) → April has 30 days → clamped to 30", () => {
      // billingPeriodStart = April 1, postpaid → due in April (boundary + postpaid = same month)
      const result = calculateInvoiceDueDate(utc(2026, 4, 1), 31, false);
      expect(fmt(result)).toBe("2026-04-30");
    });
  });
});

describe("calculateNextBillingPeriod", () => {
  describe("prepaid, mid-month (chargeDay=10)", () => {
    it("today=April 5 (before charge day) → billing starts April 10", () => {
      const result = calculateNextBillingPeriod(utc(2026, 4, 5), 10, true);
      expect(fmt(result.billingPeriodStart)).toBe("2026-04-10");
      expect(fmt(result.billingPeriodEnd)).toBe("2026-05-10");
      expect(fmt(result.dueDate)).toBe("2026-04-10");
    });

    it("today=April 10 (on charge day, >= means next) → billing starts May 10", () => {
      const result = calculateNextBillingPeriod(utc(2026, 4, 10), 10, true);
      expect(fmt(result.billingPeriodStart)).toBe("2026-05-10");
      expect(fmt(result.billingPeriodEnd)).toBe("2026-06-10");
      expect(fmt(result.dueDate)).toBe("2026-05-10");
    });

    it("today=April 15 (after charge day) → billing starts May 10", () => {
      const result = calculateNextBillingPeriod(utc(2026, 4, 15), 10, true);
      expect(fmt(result.billingPeriodStart)).toBe("2026-05-10");
      expect(fmt(result.billingPeriodEnd)).toBe("2026-06-10");
      expect(fmt(result.dueDate)).toBe("2026-05-10");
    });
  });

  describe("prepaid, boundary (chargeDay=30)", () => {
    it("today=March 25 (before charge day) → billing starts April 1, due March 30", () => {
      const result = calculateNextBillingPeriod(utc(2026, 3, 25), 30, true);
      expect(fmt(result.billingPeriodStart)).toBe("2026-04-01");
      expect(fmt(result.billingPeriodEnd)).toBe("2026-05-01");
      expect(fmt(result.dueDate)).toBe("2026-03-30");
    });

    it("today=March 31 (after charge day) → billing starts May 1, due April 30", () => {
      const result = calculateNextBillingPeriod(utc(2026, 3, 31), 30, true);
      expect(fmt(result.billingPeriodStart)).toBe("2026-05-01");
      expect(fmt(result.billingPeriodEnd)).toBe("2026-06-01");
      expect(fmt(result.dueDate)).toBe("2026-04-30");
    });
  });

  describe("prepaid, chargeDay=1", () => {
    it("today=April 1 (on charge day, >= means next) → billing starts May 1", () => {
      const result = calculateNextBillingPeriod(utc(2026, 4, 1), 1, true);
      expect(fmt(result.billingPeriodStart)).toBe("2026-05-01");
      expect(fmt(result.billingPeriodEnd)).toBe("2026-06-01");
      expect(fmt(result.dueDate)).toBe("2026-05-01");
    });
  });

  describe("postpaid, mid-month (chargeDay=10)", () => {
    it("today=April 5 → next payment April 10, postpaid shifts +1 month", () => {
      const result = calculateNextBillingPeriod(utc(2026, 4, 5), 10, false);
      expect(fmt(result.billingPeriodStart)).toBe("2026-05-10");
      expect(fmt(result.billingPeriodEnd)).toBe("2026-06-10");
      expect(fmt(result.dueDate)).toBe("2026-05-10");
    });
  });

  describe("postpaid, boundary (chargeDay=28)", () => {
    it("today=April 10 → next payment April 28, postpaid shifts billing +1 month", () => {
      const result = calculateNextBillingPeriod(utc(2026, 4, 10), 28, false);
      // Payment date = April 28, boundary → billingPeriodStart = May 1, postpaid → June 1
      expect(fmt(result.billingPeriodStart)).toBe("2026-06-01");
      expect(fmt(result.billingPeriodEnd)).toBe("2026-07-01");
      expect(fmt(result.dueDate)).toBe("2026-05-28");
    });
  });

  describe("year boundary", () => {
    it("prepaid, chargeDay=30, today=Dec 25 → billing Jan 1, due Dec 30", () => {
      const result = calculateNextBillingPeriod(utc(2026, 12, 25), 30, true);
      expect(fmt(result.billingPeriodStart)).toBe("2027-01-01");
      expect(fmt(result.billingPeriodEnd)).toBe("2027-02-01");
      expect(fmt(result.dueDate)).toBe("2026-12-30");
    });
  });

  describe("February clamping in reactivation", () => {
    it("prepaid, chargeDay=30, today=Jan 25 → next payment Jan 30 (still this month)", () => {
      const result = calculateNextBillingPeriod(utc(2026, 1, 25), 30, true);
      // Jan 25 < Jan 30, so next payment is this month
      expect(fmt(result.dueDate)).toBe("2026-01-30");
      expect(fmt(result.billingPeriodStart)).toBe("2026-02-01");
    });

    it("prepaid, chargeDay=30, today=Jan 31 → next payment Feb 28 (clamped, non-leap)", () => {
      const result = calculateNextBillingPeriod(utc(2026, 1, 31), 30, true);
      // Jan 31 >= Jan 30, so advance to Feb. chargeDay=30 clamped to Feb 28
      expect(fmt(result.dueDate)).toBe("2026-02-28");
      expect(fmt(result.billingPeriodStart)).toBe("2026-03-01");
    });
  });
});
