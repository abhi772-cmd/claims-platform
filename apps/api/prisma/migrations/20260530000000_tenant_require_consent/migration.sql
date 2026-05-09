-- Slice CG — DPDP §6 hard-enforcement flag on tenant.
--
-- Default false so the rollout is opt-in per tenant. CB shipped
-- soft binding (consentGrantId=null when no grant exists, but the
-- read still proceeds); CG adds the throw-when-missing branch
-- gated by this column. Ops flips it once a tenant's BU dashboard
-- "unbound access in 24h" count is zero (i.e., every PII read on
-- that tenant is bound to an active grant).

ALTER TABLE "tenant"
  ADD COLUMN "requireConsent" BOOLEAN NOT NULL DEFAULT false;
