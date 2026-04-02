import { INestApplication } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { createTestApp } from "./helpers/test-app";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  seedCustomer,
  seedSubscription,
  seedLedgerAccounts,
  seedInvoice,
  seedCreditBalance,
} from "./helpers/database";
import { InvoicesService } from "../src/invoices/invoices.service";
import type { App } from "supertest/types";

const CUSTOMER_1 = {
  id: "c0000000-0000-4000-a000-000000000001",
  monolithCustomerId: "mono-ca-001",
  name: "Credit Application Customer",
  email: "credit-app@example.com",
};

const CUSTOMER_2 = {
  id: "c0000000-0000-4000-a000-000000000002",
  monolithCustomerId: "mono-ca-002",
  name: "Second Credit Customer",
  email: "credit-app-2@example.com",
};

const SUBSCRIPTION_1 = {
  id: "d0000000-0000-4000-a000-000000000001",
  customerId: CUSTOMER_1.id,
  planName: "standard-monthly",
  amountCents: 5000,
  billingPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
  nextBillingDate: new Date("2026-03-01T00:00:00.000Z"),
  status: "active",
};

const SUBSCRIPTION_2 = {
  id: "d0000000-0000-4000-a000-000000000002",
  customerId: CUSTOMER_2.id,
  planName: "pro-monthly",
  amountCents: 8000,
  billingPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
  billingPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
  nextBillingDate: new Date("2026-03-01T00:00:00.000Z"),
  status: "active",
};

describe("Credit Application on Invoice Generation (e2e)", () => {
  let app: INestApplication<App>;
  let invoicesService: InvoicesService;

  beforeAll(async () => {
    await setupTestDatabase();
    await cleanDatabase();
    await seedLedgerAccounts();
    app = await createTestApp();
    invoicesService = app.get(InvoicesService);
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedLedgerAccounts();
  });

  describe("Partial credit application", () => {
    it("should apply partial credit and reduce invoice total", async () => {
      await seedCustomer(CUSTOMER_1);
      await seedSubscription(SUBSCRIPTION_1);
      await seedCreditBalance({
        id: "b0000000-0000-4000-a000-000000000001",
        customerId: CUSTOMER_1.id,
        balanceCents: 3000,
        currency: "usd",
      });

      const result = await invoicesService.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "e2e-partial-credit",
      );

      expect(result.created).toBe(1);

      const testDb = getTestDatabase();

      // Find the created invoice
      const invoiceRows = await testDb.execute(
        sql`SELECT * FROM invoices WHERE customer_id = ${CUSTOMER_1.id} AND subscription_id = ${SUBSCRIPTION_1.id}`,
      );
      expect(invoiceRows.rows).toHaveLength(1);
      const invoice = invoiceRows.rows[0];
      expect(invoice.total_amount_cents).toBe(2000); // 5000 - 3000

      // Verify credit_applied line item with negative amount
      const lineItems = await testDb.execute(
        sql`SELECT * FROM invoice_line_items WHERE invoice_id = ${invoice.id as string} ORDER BY created_at`,
      );
      const creditLineItem = lineItems.rows.find(
        (li) => li.type === "credit_applied",
      );
      expect(creditLineItem).toBeDefined();
      expect(creditLineItem!.amount_cents).toBe(-3000);
      expect(creditLineItem!.description).toBe("Credit applied from balance");

      // Verify credit balance reduced to 0
      const balanceRows = await testDb.execute(
        sql`SELECT * FROM credit_balances WHERE customer_id = ${CUSTOMER_1.id}`,
      );
      expect(balanceRows.rows).toHaveLength(1);
      expect(balanceRows.rows[0].balance_cents).toBe(0);

      // Verify ledger entry for credit application
      const ledgerRows = await testDb.execute(
        sql`SELECT le.*, da.name as debit_name, ca.name as credit_name
            FROM ledger_entries le
            JOIN ledger_accounts da ON le.debit_account_id = da.id
            JOIN ledger_accounts ca ON le.credit_account_id = ca.id
            WHERE le.reference_type = 'credit_application' AND le.reference_id = ${invoice.id as string}`,
      );
      expect(ledgerRows.rows).toHaveLength(1);
      const ledger = ledgerRows.rows[0];
      expect(ledger.amount_cents).toBe(3000);
      expect(ledger.debit_name).toBe("accounts_receivable");
      expect(ledger.credit_name).toBe("credits");
    });
  });

  describe("Full credit coverage", () => {
    it("should mark invoice as paid when credits fully cover it", async () => {
      await seedCustomer(CUSTOMER_1);
      await seedSubscription(SUBSCRIPTION_1);
      await seedCreditBalance({
        id: "b0000000-0000-4000-a000-000000000002",
        customerId: CUSTOMER_1.id,
        balanceCents: 5000, // Exactly matches subscription amount
        currency: "usd",
      });

      const result = await invoicesService.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "e2e-full-credit",
      );

      expect(result.created).toBe(1);

      const testDb = getTestDatabase();

      const invoiceRows = await testDb.execute(
        sql`SELECT * FROM invoices WHERE customer_id = ${CUSTOMER_1.id} AND subscription_id = ${SUBSCRIPTION_1.id}`,
      );
      expect(invoiceRows.rows).toHaveLength(1);
      const invoice = invoiceRows.rows[0];
      expect(invoice.total_amount_cents).toBe(0);
      expect(invoice.status).toBe("paid");
      expect(invoice.paid_at).not.toBeNull();

      // Verify credit_applied line item
      const lineItems = await testDb.execute(
        sql`SELECT * FROM invoice_line_items WHERE invoice_id = ${invoice.id as string}`,
      );
      const creditLineItem = lineItems.rows.find(
        (li) => li.type === "credit_applied",
      );
      expect(creditLineItem).toBeDefined();
      expect(creditLineItem!.amount_cents).toBe(-5000);

      // Verify credit balance reduced to 0
      const balanceRows = await testDb.execute(
        sql`SELECT * FROM credit_balances WHERE customer_id = ${CUSTOMER_1.id}`,
      );
      expect(balanceRows.rows[0].balance_cents).toBe(0);
    });
  });

  describe("Zero credit balance", () => {
    it("should process invoice normally when no credits exist", async () => {
      await seedCustomer(CUSTOMER_1);
      await seedSubscription(SUBSCRIPTION_1);
      // No credit balance seeded

      const result = await invoicesService.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "e2e-zero-credit",
      );

      expect(result.created).toBe(1);

      const testDb = getTestDatabase();

      const invoiceRows = await testDb.execute(
        sql`SELECT * FROM invoices WHERE customer_id = ${CUSTOMER_1.id} AND subscription_id = ${SUBSCRIPTION_1.id}`,
      );
      const invoice = invoiceRows.rows[0];
      expect(invoice.total_amount_cents).toBe(5000);
      expect(invoice.status).toBe("finalized"); // Not paid

      // No credit_applied line item
      const lineItems = await testDb.execute(
        sql`SELECT * FROM invoice_line_items WHERE invoice_id = ${invoice.id as string}`,
      );
      const creditLineItem = lineItems.rows.find(
        (li) => li.type === "credit_applied",
      );
      expect(creditLineItem).toBeUndefined();
    });
  });

  describe("Credits exceeding invoice total", () => {
    it("should apply only invoice amount and preserve remaining balance", async () => {
      await seedCustomer(CUSTOMER_1);
      await seedSubscription(SUBSCRIPTION_1);
      await seedCreditBalance({
        id: "b0000000-0000-4000-a000-000000000003",
        customerId: CUSTOMER_1.id,
        balanceCents: 12000, // More than subscription amount (5000)
        currency: "usd",
      });

      const result = await invoicesService.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "e2e-excess-credit",
      );

      expect(result.created).toBe(1);

      const testDb = getTestDatabase();

      const invoiceRows = await testDb.execute(
        sql`SELECT * FROM invoices WHERE customer_id = ${CUSTOMER_1.id} AND subscription_id = ${SUBSCRIPTION_1.id}`,
      );
      const invoice = invoiceRows.rows[0];
      expect(invoice.total_amount_cents).toBe(0);
      expect(invoice.status).toBe("paid");

      // Only applied 5000 (invoice total), not 12000
      const lineItems = await testDb.execute(
        sql`SELECT * FROM invoice_line_items WHERE invoice_id = ${invoice.id as string}`,
      );
      const creditLineItem = lineItems.rows.find(
        (li) => li.type === "credit_applied",
      );
      expect(creditLineItem!.amount_cents).toBe(-5000);

      // Remaining balance preserved: 12000 - 5000 = 7000
      const balanceRows = await testDb.execute(
        sql`SELECT * FROM credit_balances WHERE customer_id = ${CUSTOMER_1.id}`,
      );
      expect(balanceRows.rows[0].balance_cents).toBe(7000);
    });
  });

  describe("Onboarding invoice with credits", () => {
    it("should apply credits to onboarding invoices during finalization", async () => {
      await seedCustomer(CUSTOMER_1);

      // Create a draft onboarding invoice (subscriptionId IS NULL)
      await seedInvoice({
        id: "e0000000-0000-4000-a000-000000000010",
        customerId: CUSTOMER_1.id,
        subscriptionId: undefined, // Onboarding invoice
        status: "draft",
        totalAmountCents: 15000,
        billingPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
        billingPeriodEnd: new Date("2026-04-01T00:00:00.000Z"),
        dueDate: new Date("2026-02-28T00:00:00.000Z"), // Due before scheduledDate
        lineItems: [
          {
            id: "f0000000-0000-4000-a000-000000000010",
            type: "implementation_fee",
            description: "Implementation fee",
            amountCents: 15000,
            quantity: 1,
          },
        ],
      });

      await seedCreditBalance({
        id: "b0000000-0000-4000-a000-000000000004",
        customerId: CUSTOMER_1.id,
        balanceCents: 6000,
        currency: "usd",
      });

      const result = await invoicesService.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "e2e-onboarding-credit",
      );

      expect(result.finalized).toBe(1);

      const testDb = getTestDatabase();

      // Verify invoice was finalized and credits applied
      const invoiceRows = await testDb.execute(
        sql`SELECT * FROM invoices WHERE id = 'e0000000-0000-4000-a000-000000000010'`,
      );
      const invoice = invoiceRows.rows[0];
      expect(invoice.total_amount_cents).toBe(9000); // 15000 - 6000
      expect(invoice.status).toBe("finalized"); // Partially covered, still finalized

      // Verify credit_applied line item
      const lineItems = await testDb.execute(
        sql`SELECT * FROM invoice_line_items WHERE invoice_id = 'e0000000-0000-4000-a000-000000000010' AND type = 'credit_applied'`,
      );
      expect(lineItems.rows).toHaveLength(1);
      expect(lineItems.rows[0].amount_cents).toBe(-6000);

      // Verify credit balance reduced to 0
      const balanceRows = await testDb.execute(
        sql`SELECT * FROM credit_balances WHERE customer_id = ${CUSTOMER_1.id}`,
      );
      expect(balanceRows.rows[0].balance_cents).toBe(0);
    });
  });

  describe("Atomicity", () => {
    it("should have all credit application artifacts within transaction", async () => {
      await seedCustomer(CUSTOMER_1);
      await seedSubscription(SUBSCRIPTION_1);
      await seedCreditBalance({
        id: "b0000000-0000-4000-a000-000000000005",
        customerId: CUSTOMER_1.id,
        balanceCents: 2000,
        currency: "usd",
      });

      await invoicesService.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "e2e-atomicity",
      );

      const testDb = getTestDatabase();

      // Verify all artifacts exist together: invoice, line item, ledger entry, balance update
      const invoiceRows = await testDb.execute(
        sql`SELECT * FROM invoices WHERE customer_id = ${CUSTOMER_1.id} AND subscription_id = ${SUBSCRIPTION_1.id}`,
      );
      expect(invoiceRows.rows).toHaveLength(1);
      const invoice = invoiceRows.rows[0];

      // Credit line item
      const creditLineItems = await testDb.execute(
        sql`SELECT * FROM invoice_line_items WHERE invoice_id = ${invoice.id as string} AND type = 'credit_applied'`,
      );
      expect(creditLineItems.rows).toHaveLength(1);

      // Ledger entry for credit application
      const creditLedger = await testDb.execute(
        sql`SELECT * FROM ledger_entries WHERE reference_type = 'credit_application' AND reference_id = ${invoice.id as string}`,
      );
      expect(creditLedger.rows).toHaveLength(1);

      // Ledger entry for invoice finalized also exists
      const invoiceLedger = await testDb.execute(
        sql`SELECT * FROM ledger_entries WHERE reference_type = 'invoice' AND reference_id = ${invoice.id as string}`,
      );
      expect(invoiceLedger.rows).toHaveLength(1);

      // Balance deducted
      const balanceRows = await testDb.execute(
        sql`SELECT * FROM credit_balances WHERE customer_id = ${CUSTOMER_1.id}`,
      );
      expect(balanceRows.rows[0].balance_cents).toBe(0);
    });
  });

  describe("Batch invoice generation with independent credits", () => {
    it("should apply each customer credits independently", async () => {
      await seedCustomer(CUSTOMER_1);
      await seedCustomer(CUSTOMER_2);
      await seedSubscription(SUBSCRIPTION_1);
      await seedSubscription(SUBSCRIPTION_2);

      // Customer 1: $30 credit (partial for $50 invoice)
      await seedCreditBalance({
        id: "b0000000-0000-4000-a000-000000000006",
        customerId: CUSTOMER_1.id,
        balanceCents: 3000,
        currency: "usd",
      });

      // Customer 2: $80 credit (full coverage for $80 invoice)
      await seedCreditBalance({
        id: "b0000000-0000-4000-a000-000000000007",
        customerId: CUSTOMER_2.id,
        balanceCents: 8000,
        currency: "usd",
      });

      const result = await invoicesService.generateInvoicesForDueSubscriptions(
        "2026-03-01",
        "e2e-batch-credits",
      );

      expect(result.created).toBe(2);

      const testDb = getTestDatabase();

      // Customer 1: partial credit applied (5000 - 3000 = 2000)
      const inv1Rows = await testDb.execute(
        sql`SELECT * FROM invoices WHERE customer_id = ${CUSTOMER_1.id}`,
      );
      expect(inv1Rows.rows).toHaveLength(1);
      expect(inv1Rows.rows[0].total_amount_cents).toBe(2000);
      expect(inv1Rows.rows[0].status).toBe("finalized");

      // Customer 2: full credit applied (8000 - 8000 = 0)
      const inv2Rows = await testDb.execute(
        sql`SELECT * FROM invoices WHERE customer_id = ${CUSTOMER_2.id}`,
      );
      expect(inv2Rows.rows).toHaveLength(1);
      expect(inv2Rows.rows[0].total_amount_cents).toBe(0);
      expect(inv2Rows.rows[0].status).toBe("paid");

      // Verify independent balance updates
      const bal1 = await testDb.execute(
        sql`SELECT * FROM credit_balances WHERE customer_id = ${CUSTOMER_1.id}`,
      );
      expect(bal1.rows[0].balance_cents).toBe(0);

      const bal2 = await testDb.execute(
        sql`SELECT * FROM credit_balances WHERE customer_id = ${CUSTOMER_2.id}`,
      );
      expect(bal2.rows[0].balance_cents).toBe(0);
    });
  });
});
