# IP allowlist — admin self-lockout

## Symptom

A tenant admin saved an IP allowlist that doesn't include their own
network. Every subsequent login attempt returns 403 `AUTH_IP_NOT_ALLOWED`.
The tenant has no way back in via the UI.

## Diagnosis

```sql
SELECT id, slug, "displayName", "ipAllowlist"
FROM tenant
WHERE slug = $tenantSlug;
```

Confirm the saved CIDRs do not cover the requesting IPs. The audit log
captures the change:

```sql
SELECT "occurredAt", "actorUserId", before, after, "ipAddress"
FROM audit_log
WHERE "tenantId" = $tenantId
  AND action = 'TENANT_IP_ALLOWLIST_UPDATED'
ORDER BY "occurredAt" DESC
LIMIT 5;
```

## Resolution

The platform_admin role bypasses the IP allowlist (see
`IpAllowlistService.assertAllowed`), so a platform-admin user can sign
in and reset the list via `/admin/security/ip-allowlist`.

If no platform admin is available, edit the column directly:

```sql
-- Reset to empty (no restriction) — usually the right thing for
-- recovery; the tenant admin can re-apply a corrected list afterwards.
UPDATE tenant SET "ipAllowlist" = '[]'::jsonb WHERE id = $tenantId;
```

Or add a single new CIDR to cover the user's current network without
wiping their other rules:

```sql
UPDATE tenant
SET "ipAllowlist" = (
  SELECT jsonb_agg(elem)
  FROM (
    SELECT jsonb_array_elements("ipAllowlist") AS elem FROM tenant WHERE id = $tenantId
    UNION ALL
    SELECT to_jsonb('203.0.113.0/24'::text)
  ) merged
)
WHERE id = $tenantId;
```

Always record the recovery as an audit row:

```sql
INSERT INTO audit_log
  (id, "tenantId", "actorUserId", "actorType", action, "resourceType",
   "resourceId", before, after)
VALUES
  (gen_random_uuid(), $tenantId, $oncallUserId, 'system',
   'TENANT_IP_ALLOWLIST_UPDATED', 'tenant', $tenantId,
   $beforeJsonb, $afterJsonb);
```

## Prevention (for next time)

The web editor should warn before saving a list that doesn't cover the
admin's current IP. Sprint 2 backlog item — note in `docs/sprint-1-exit.md`.
