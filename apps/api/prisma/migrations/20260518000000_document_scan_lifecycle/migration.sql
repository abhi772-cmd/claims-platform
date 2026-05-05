-- Slice S — document virus-scan lifecycle.
-- Adds scanStatus + scan-result columns. Default 'skipped' so legacy
-- rows (created before this slice with stub storage) don't get
-- accidentally treated as scan-pending and hidden from consumers.

ALTER TABLE "document"
  ADD COLUMN "scanStatus"    TEXT NOT NULL DEFAULT 'skipped',
  ADD COLUMN "scanEngine"    TEXT,
  ADD COLUMN "scanSignature" TEXT,
  ADD COLUMN "scannedAt"     TIMESTAMP(3);

CREATE INDEX "document_tenantId_scanStatus_idx"
  ON "document"("tenantId", "scanStatus");

-- Composite index for the lifecycle worker's "pending too long" sweep.
CREATE INDEX "document_uploadStatus_finalizedAt_idx"
  ON "document"("uploadStatus", "finalizedAt");
