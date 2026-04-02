# Materialized View Readiness Plan

## Current Dashboard Query Performance Assessment

### Dashboard Aggregation Queries (Story 6.3)
- **Dunning dashboard**: Raw SQL aggregation across `dunning_attempts` table with status grouping
- **Executive dashboard**: Multi-table aggregation across invoices, charges, subscriptions
- **Expected performance**: <50ms with current data volumes (hundreds of records)
- **Current indexes**: `idx_dunning_attempts_invoice_id`, `idx_charges_invoice_id`, `idx_invoices_customer_id`

### Revenue Reporting Queries (Story 6.2)
- **Revenue report**: Conditional aggregation on `ledger_entries` table with date range and account filters
- **Reconciliation summary**: Join between `reconciliation_runs` and `reconciliation_discrepancies`
- **Expected performance**: <50ms at current scale

### Reconciliation Queries (Story 6.1)
- **Daily reconciliation**: Comparison of internal ledger entries against Stripe balance transactions
- **Performance**: Dependent on Stripe API response time, not DB query time

## Candidate Materialized Views

### 1. Dashboard Aggregation View
- **Tables**: `invoices`, `charges`, `dunning_attempts`, `subscriptions`
- **Use case**: Executive dashboard showing total revenue, outstanding amounts, dunning status
- **Refresh strategy**: Event-triggered (after invoice creation, payment, dunning attempt)
- **Staleness tolerance**: 5 minutes acceptable for dashboard metrics

### 2. Revenue Summary View
- **Tables**: `ledger_entries` with account type filters
- **Use case**: Monthly/daily revenue reporting
- **Refresh strategy**: Scheduled (every 15 minutes during business hours, hourly otherwise)
- **Staleness tolerance**: 15 minutes acceptable for financial reporting

### 3. Reconciliation Summary View
- **Tables**: `reconciliation_runs`, `reconciliation_discrepancies`
- **Use case**: Quick reconciliation status overview
- **Refresh strategy**: After each reconciliation run completes
- **Staleness tolerance**: Real-time after run, stale data acceptable between runs

## Trigger Criteria

Materialized views should be implemented when:
- Any dashboard or reporting query consistently exceeds **50ms** response time (NFR7)
- Data volume exceeds **10,000 records** in aggregated tables
- Query patterns show repeated identical aggregations within short time windows
- Production monitoring shows database CPU pressure from reporting queries

## Refresh Strategy Options

### Event-Triggered Refresh
- **Mechanism**: `REFRESH MATERIALIZED VIEW CONCURRENTLY` called from service layer after relevant writes
- **Pros**: Near-real-time data, minimal staleness
- **Cons**: Write amplification, increased latency on write path
- **Candidate views**: Dashboard aggregation (writes are infrequent, reads are frequent)

### Scheduled Refresh
- **Mechanism**: PostgreSQL cron job or application-level scheduler (e.g., `@nestjs/schedule`)
- **Pros**: Predictable load, decoupled from write path
- **Cons**: Stale data between refreshes
- **Candidate views**: Revenue summary, reconciliation summary

### Hybrid Approach (Recommended)
- **Dashboard views**: Event-triggered with debounce (max 1 refresh per 30 seconds)
- **Revenue views**: Scheduled every 15 minutes
- **Reconciliation views**: Event-triggered after reconciliation run completion

## Implementation Plan

### Phase 1: Monitoring (Current)
1. Add query timing instrumentation to dashboard and reporting endpoints
2. Log query execution times with structured logging
3. Set up alerts for queries exceeding 50ms threshold
4. Collect baseline metrics for 2-4 weeks after migration wave completion

### Phase 2: Index Optimization (Pre-Materialized Views)
1. Analyze slow query logs to identify missing indexes
2. Add composite indexes for common filter combinations
3. Consider partial indexes for status-filtered queries (e.g., `WHERE status = 'paid'`)
4. Re-evaluate performance after index optimization

### Phase 3: Materialized View Implementation (When Triggered)
1. Create materialized views with `CREATE MATERIALIZED VIEW ... WITH DATA`
2. Add unique indexes on materialized views for `REFRESH CONCURRENTLY` support
3. Implement refresh mechanism (event-triggered or scheduled)
4. Update service layer to query materialized views instead of base tables
5. Add monitoring for materialized view staleness and refresh duration

### Migration Path
1. Create materialized views alongside existing queries (shadow mode)
2. Compare results between live queries and materialized views for accuracy
3. Switch reporting endpoints to materialized views
4. Monitor performance improvement
5. Remove redundant live query code paths

## Index vs Materialized View Tradeoffs

| Factor | Index | Materialized View |
|--------|-------|-------------------|
| Write overhead | Minimal | Significant (refresh) |
| Read performance | Good for filtered queries | Excellent for aggregations |
| Data staleness | None (always current) | Depends on refresh strategy |
| Storage overhead | Low-moderate | Moderate-high (full result set) |
| Maintenance | Automatic | Requires refresh management |
| Complexity | Low | Moderate |

**Recommendation**: Start with index optimization. Only introduce materialized views when indexes alone cannot meet the 50ms NFR7 threshold. Current data volumes (hundreds to low thousands of records) are well within index-only performance range.
