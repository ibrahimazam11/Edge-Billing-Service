INSERT INTO ledger_accounts (id, name, type, description)
VALUES
  (gen_random_uuid(), 'accounts_receivable', 'accounts_receivable', 'Money owed by customers for invoiced services'),
  (gen_random_uuid(), 'revenue', 'revenue', 'Income earned from billing subscriptions and charges'),
  (gen_random_uuid(), 'cash', 'cash', 'Payments received from customers via payment gateway'),
  (gen_random_uuid(), 'refunds', 'refunds', 'Money returned to customers for refunded charges'),
  (gen_random_uuid(), 'credits', 'credits', 'Credit balance owed to customers for future invoices')
ON CONFLICT (name) DO NOTHING;
