-- PRD-737 — one-shot backfill for the already-migrated Gibbel Insurance Agency
-- (monolith e-001415) draft. Brings its single open recurring draft in line with
-- what the migration code now produces going forward:
--   (1) Fix 3 — link the going-forward draft to the BS subscription.
--   (2) Fix 4 — rewrite the employee_cost breakdown JSONB to the BS-native shape.
--
-- Gibbel was migrated BEFORE these fixes landed, so its existing draft still has
-- subscription_id = NULL and the legacy migration breakdown shape. New migrations
-- need neither patch (PayrollsWriter + SubscriptionWriter handle both). This script
-- is a one-shot for this single pre-existing draft only.
--
-- The invoice is still `draft`, so rewriting it in place is safe; every statement
-- is guarded to fire only while it remains `draft`, and all are idempotent
-- (re-running links nothing new and re-sets identical breakdown values).
--
-- Identifiers
--   bs_customer_id      019efa5a-81ba-75d9-adc5-0bdbb21f1dd5
--   bs_subscription_id  019efa5a-837b-73e8-a88b-c4dfc2c6c942
--   draft invoice_id    019efa5a-833a-759f-92cc-b2b9efb8ec48  (2026-07-01 → 2026-08-01, 500000c)
--   line item (Shayan)  019efa5a-833a-759f-92cc-b5c1e89b9be1
--   line item (Naveen)  019efa5a-833a-759f-92cc-bbf83ddbcd82
--
-- breakdown before/after (salary = monolith Paid_Gross_Salary, NOT baseSalary which
-- already bundles fee+bonus; employeeId resolved from monolith Payroll A_glbMz0uY
-- by name — Customer_Cost / fee / gross all reconcile):
--   b5c1e89b9be1 (Shayan Iftikhar Chaudhry, amount_cents 275000)
--     before { "baseSalaryCents":275000, "paidGrossSalaryCents":165000, "bonusCents":0, "platformFeeCents":110000 }
--     after  { "employeeId":"edge-emp-243", "salary":165000, "platformFee":110000, "bonus":0, "raise":0, "discount":0 }
--   bbf83ddbcd82 (Naveen Chaudhry, amount_cents 225000)
--     before { "baseSalaryCents":225000, "paidGrossSalaryCents":75000, "bonusCents":0, "platformFeeCents":150000 }
--     after  { "employeeId":"wZDq6i59-", "salary":75000, "platformFee":150000, "bonus":0, "raise":0, "discount":0 }
--
-- Run against the database that holds the Gibbel draft (e.g. billing_qa):
--   psql "$BILLING_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/backfill-gibbel-draft.sql

BEGIN;

-- (1) Fix 3 — link ONLY the open recurring draft to the subscription. Historical
-- paid/finalized/void rows keep subscription_id = NULL (Stripe-managed cycles that
-- pre-date BS owning the subscription). Same predicate as
-- InvoicesRepository.linkOpenRecurringDraftToSubscription.
UPDATE invoices
SET subscription_id = '019efa5a-837b-73e8-a88b-c4dfc2c6c942',
    updated_at = now()
WHERE customer_id = '019efa5a-81ba-75d9-adc5-0bdbb21f1dd5'
  AND type = 'recurring'
  AND status = 'draft'
  AND subscription_id IS NULL;

-- (2) Fix 4 — rewrite the two employee_cost line-item breakdowns to native shape.
UPDATE invoice_line_items li
SET breakdown = jsonb_build_object(
      'employeeId', 'edge-emp-243',
      'salary',      165000,
      'platformFee', 110000,
      'bonus',       0,
      'raise',       0,
      'discount',    0
    )
FROM invoices i
WHERE li.id = '019efa5a-833a-759f-92cc-b5c1e89b9be1'
  AND li.invoice_id = '019efa5a-833a-759f-92cc-b2b9efb8ec48'
  AND li.type = 'employee_cost'
  AND i.id = li.invoice_id
  AND i.status = 'draft';

UPDATE invoice_line_items li
SET breakdown = jsonb_build_object(
      'employeeId', 'wZDq6i59-',
      'salary',      75000,
      'platformFee', 150000,
      'bonus',       0,
      'raise',       0,
      'discount',    0
    )
FROM invoices i
WHERE li.id = '019efa5a-833a-759f-92cc-bbf83ddbcd82'
  AND li.invoice_id = '019efa5a-833a-759f-92cc-b2b9efb8ec48'
  AND li.type = 'employee_cost'
  AND i.id = li.invoice_id
  AND i.status = 'draft';

-- Verification — expect exactly 1 row, reconstructed = amount_cents per line, and
-- the draft now linked to the subscription.
SELECT li.id,
       li.amount_cents,
       (li.breakdown->>'salary')::int
         + (li.breakdown->>'platformFee')::int
         + (li.breakdown->>'bonus')::int   AS reconstructed,
       li.breakdown->>'employeeId'         AS employee_id,
       i.subscription_id
FROM invoice_line_items li
JOIN invoices i ON i.id = li.invoice_id
WHERE li.invoice_id = '019efa5a-833a-759f-92cc-b2b9efb8ec48'
ORDER BY li.id;

COMMIT;
