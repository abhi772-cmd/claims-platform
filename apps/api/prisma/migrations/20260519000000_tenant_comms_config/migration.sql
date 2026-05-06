-- Per-tenant communication channel config (SMTP + SMS).
-- Empty JSON object means "use the platform env defaults".
-- Reads are RLS-gated by the existing tenant policy; secrets in
-- the JSON (smtp.password, sms.apiKey) are never returned to
-- non-platform-admin callers — the controller redacts them.

ALTER TABLE "tenant"
  ADD COLUMN "commsConfig" JSONB NOT NULL DEFAULT '{}'::jsonb;
