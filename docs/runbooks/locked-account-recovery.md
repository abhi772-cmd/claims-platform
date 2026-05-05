# Locked-account recovery

## Symptom

A user reports `Account temporarily locked` (HTTP 423, `AUTH_ACCOUNT_LOCKED`)
on sign-in. Triggered by 5 failed login attempts; auto-unlocks after 15
minutes.

## Diagnosis

```sql
SELECT id, email, "failedLoginAttempts", "lockedUntil", "lastLoginAt"
FROM "user"
WHERE email = $email;
```

If `lockedUntil` is in the past the user can already sign in (the cap
auto-clears on next attempt). If it's in the future and the user is
genuine, you can clear it early.

Check the audit trail to see whether the failed attempts came from a
single IP (likely typo / forgotten password) or many (likely credential
stuffing — see also: refresh-token-reuse-detected runbook):

```sql
SELECT "ipAddress", "occurredAt", after
FROM audit_log
WHERE "actorUserId" = $userId
  AND action IN ('USER_FAILED_LOGIN', 'USER_LOCKED')
ORDER BY "occurredAt" DESC
LIMIT 20;
```

## Resolution

### Option 1 — let it expire

15 minutes from the most recent failure. Tell the user to wait. This is
the right answer for a user who just typo'd their password.

### Option 2 — clear the lockout

Only when the user has verified identity through a side channel (call
their listed mobile, ask security questions, etc.). Run as
`claims_migrator`:

```sql
UPDATE "user"
SET "failedLoginAttempts" = 0, "lockedUntil" = NULL
WHERE id = $userId;
```

Then write an audit row so the action is traceable:

```sql
INSERT INTO audit_log
  (id, "tenantId", "actorUserId", "actorType", action, "resourceType",
   "resourceId", after)
VALUES
  (gen_random_uuid(), $tenantId, $oncallUserId, 'system',
   'USER_UNLOCKED', 'user', $userId,
   '{"reason": "manual_recovery", "verified_via": "phone"}'::jsonb);
```

### Option 3 — force password reset

If you suspect credential compromise:

1. Trigger a password reset via `/auth/password-reset/initiate` (or
   directly call the service from a one-shot ts-node script).
2. Optionally pre-emptively delete all sessions:
   ```sql
   DELETE FROM session WHERE "userId" = $userId;
   ```
3. Notify the user out-of-band.

## Audit

Whatever path you take, leave a `USER_UNLOCKED` row tied to the oncall
actor. The lockout itself produced a `USER_LOCKED` row already, so the
pair tells the full story.
