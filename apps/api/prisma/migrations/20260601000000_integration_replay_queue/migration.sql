-- Slice T1-5 — NHCX outbound replay queue.
--
-- Adds `next_retry_at` so the replay worker knows when each
-- `queued_for_retry` row becomes eligible for re-issue, plus an
-- index on (status, next_retry_at) so the poll query is fast.
--
-- The new 'queued_for_retry' status value lands without a migration
-- because `status` is already a String column. The application
-- enum in @claims/contracts is extended in the same PR.

ALTER TABLE "integration_message"
  ADD COLUMN "nextRetryAt" TIMESTAMP(3);

CREATE INDEX "integration_message_status_nextRetryAt_idx"
  ON "integration_message" ("status", "nextRetryAt");
