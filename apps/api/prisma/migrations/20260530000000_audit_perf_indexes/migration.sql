-- Slice CD — perf indexes on Sprint 8 tables for the BU dashboard
-- and the BP/BS sweepers.
--
-- Three additions, all CONCURRENTLY-safe in production. We don't
-- use CONCURRENTLY here (Prisma migrations run inside a single
-- migration transaction and CONCURRENTLY can't be in a tx); ops
-- replaying these on a hot prod table should re-create them with
-- CREATE INDEX CONCURRENTLY off-Prisma if downtime is a concern.
--
-- 1. audit_log(tenantId, retentionClass, occurredAt) — BU's
--    "past-floor count per tenant per class" query. The existing
--    (retentionClass, occurredAt) index lacks tenantId leading,
--    so PG either scans every tenant's rows or falls back to
--    (tenantId, occurredAt) and filters retentionClass on the
--    heap. Either way we burn IO. With this composite, the
--    "WHERE tenantId = T AND retentionClass = X AND occurredAt < cutoff"
--    pattern becomes a bounded index range scan.
--
-- 2. data_access_event(tenantId, action, occurredAt) — BU's
--    recent-decrypts list (`WHERE tenantId = T AND action = 'decrypt'
--    ORDER BY occurredAt DESC LIMIT 20`) and the unbound-count
--    query (`WHERE tenantId = T AND action = 'decrypt' AND
--    consentGrantId IS NULL AND occurredAt >= cutoff`). The
--    existing (tenantId, occurredAt) misses the action filter;
--    with action in the index PG can range-scan only decrypt rows.
--
-- 3. consent_record(tenantId, updatedAt) — BU's recent-changes
--    list orders by updatedAt to surface fresh withdrawals
--    alongside fresh grants. Without this index PG sorts the
--    full tenant slice on heap.

CREATE INDEX "audit_log_tenantId_retentionClass_occurredAt_idx"
  ON "audit_log"("tenantId", "retentionClass", "occurredAt");

CREATE INDEX "data_access_event_tenantId_action_occurredAt_idx"
  ON "data_access_event"("tenantId", "action", "occurredAt");

CREATE INDEX "consent_record_tenantId_updatedAt_idx"
  ON "consent_record"("tenantId", "updatedAt");
