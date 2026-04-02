import { INestApplication } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { createTestApp } from "./helpers/test-app";
import {
  setupTestDatabase,
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  seedLedgerAccounts,
} from "./helpers/database";
import { LedgerService } from "../src/ledger/ledger.service";

describe("Ledger (e2e)", () => {
  let app: INestApplication;
  let ledgerService: LedgerService;

  beforeAll(async () => {
    await setupTestDatabase();
    app = await createTestApp();
    ledgerService = app.get(LedgerService);
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedLedgerAccounts();
    // Re-init to load seeded accounts
    await ledgerService.onModuleInit();
  });

  describe("ledger_accounts table", () => {
    it("should contain 5 default seed accounts", async () => {
      const db = getTestDatabase();
      const accounts = await db.execute(
        sql`SELECT * FROM ledger_accounts ORDER BY name`,
      );
      expect(accounts.rows).toHaveLength(5);
      const names = accounts.rows.map((r: Record<string, unknown>) => r.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "accounts_receivable",
          "cash",
          "credits",
          "refunds",
          "revenue",
        ]),
      );
    });

    it("should enforce unique constraint on name", async () => {
      const db = getTestDatabase();
      await expect(
        db.execute(
          sql`INSERT INTO ledger_accounts (id, name, type, description)
              VALUES (gen_random_uuid(), 'accounts_receivable', 'accounts_receivable', 'duplicate')`,
        ),
      ).rejects.toThrow();
    });
  });

  describe("LedgerService.recordInvoiceFinalized", () => {
    it("should create a ledger entry in the database", async () => {
      const referenceId = "b0000000-0000-4000-a000-000000000001";
      const entryId = await ledgerService.recordInvoiceFinalized(
        referenceId,
        10050,
        "usd",
        "e2e-corr-001",
      );

      expect(entryId).toBeDefined();

      const db = getTestDatabase();
      const result = await db.execute(
        sql`SELECT * FROM ledger_entries WHERE id = ${entryId}`,
      );
      expect(result.rows).toHaveLength(1);

      const entry = result.rows[0];
      expect(entry.amount_cents).toBe(10050);
      expect(entry.currency).toBe("usd");
      expect(entry.reference_type).toBe("invoice");
      expect(entry.reference_id).toBe(referenceId);
      expect(entry.correlation_id).toBe("e2e-corr-001");
      expect(entry.description).toBe("Invoice finalized");
    });
  });

  describe("LedgerService.recordPaymentSucceeded", () => {
    it("should create a ledger entry in the database", async () => {
      const referenceId = "b0000000-0000-4000-a000-000000000002";
      const entryId = await ledgerService.recordPaymentSucceeded(
        referenceId,
        5000,
        "usd",
        "e2e-corr-002",
      );

      expect(entryId).toBeDefined();

      const db = getTestDatabase();
      const result = await db.execute(
        sql`SELECT * FROM ledger_entries WHERE id = ${entryId}`,
      );
      expect(result.rows).toHaveLength(1);

      const entry = result.rows[0];
      expect(entry.amount_cents).toBe(5000);
      expect(entry.reference_type).toBe("payment");
      expect(entry.reference_id).toBe(referenceId);
      expect(entry.description).toBe("Payment succeeded");
    });
  });

  describe("Immutability enforcement", () => {
    it("should reject UPDATE on ledger_entries via database trigger", async () => {
      const referenceId = "b0000000-0000-4000-a000-000000000003";
      const entryId = await ledgerService.recordInvoiceFinalized(
        referenceId,
        1000,
        "usd",
        "e2e-immutable-update",
      );

      const db = getTestDatabase();
      await expect(
        db.execute(
          sql`UPDATE ledger_entries SET amount_cents = 9999 WHERE id = ${entryId}`,
        ),
      ).rejects.toThrow();

      // Verify the entry was not modified
      const result = await db.execute(
        sql`SELECT amount_cents FROM ledger_entries WHERE id = ${entryId}`,
      );
      expect(result.rows[0].amount_cents).toBe(1000);
    });

    it("should reject DELETE on ledger_entries via database trigger", async () => {
      const referenceId = "b0000000-0000-4000-a000-000000000004";
      const entryId = await ledgerService.recordInvoiceFinalized(
        referenceId,
        2000,
        "usd",
        "e2e-immutable-delete",
      );

      const db = getTestDatabase();
      await expect(
        db.execute(sql`DELETE FROM ledger_entries WHERE id = ${entryId}`),
      ).rejects.toThrow();

      // Verify the entry still exists
      const result = await db.execute(
        sql`SELECT count(*) as cnt FROM ledger_entries WHERE id = ${entryId}`,
      );
      expect(Number(result.rows[0].cnt)).toBe(1);
    });
  });

  describe("Transaction atomicity", () => {
    it("should roll back on insert failure (invalid account FK)", async () => {
      const db = getTestDatabase();

      // Try to insert with a non-existent debit_account_id directly
      await expect(
        db.execute(
          sql`INSERT INTO ledger_entries (id, debit_account_id, credit_account_id, amount_cents, currency, reference_type, reference_id, description, correlation_id)
              VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1000, 'usd', 'invoice', gen_random_uuid(), 'test', 'corr')`,
        ),
      ).rejects.toThrow();

      // Verify no orphan entries exist
      const entries = await db.execute(
        sql`SELECT count(*) as cnt FROM ledger_entries WHERE correlation_id = 'corr'`,
      );
      expect(Number(entries.rows[0].cnt)).toBe(0);
    });
  });
});
