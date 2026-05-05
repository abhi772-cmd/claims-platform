-- Slice P2 — document upload lifecycle.
-- Adds pending/completed/failed status tracking plus optional sha256.
-- Default 'completed' so existing rows (created via upload-stub) stay
-- valid as completed uploads.

ALTER TABLE "document"
  ADD COLUMN "uploadStatus"   TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN "contentSha256"  TEXT,
  ADD COLUMN "uploadError"    TEXT,
  ADD COLUMN "finalizedAt"    TIMESTAMP(3);

CREATE INDEX "document_tenantId_uploadStatus_idx"
  ON "document"("tenantId", "uploadStatus");

-- For existing rows, we backfill finalizedAt = uploadedAt so any
-- queries that look at "completed" rows treat them as finalized at the
-- same moment they were created (which is what the upload-stub flow
-- did de facto).
UPDATE "document"
SET "finalizedAt" = "uploadedAt"
WHERE "finalizedAt" IS NULL;
