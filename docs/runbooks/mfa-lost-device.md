# MFA — lost authenticator + no backup codes

## Symptom

User reports they reset their phone (or wiped the authenticator app)
and the backup codes we showed them at enrolment are gone. Login lands
at the MFA challenge but they can't complete it.

## Diagnosis

```sql
SELECT u.id, u.email, e."confirmedAt",
       (SELECT COUNT(*) FROM backup_code WHERE "userId" = u.id AND "usedAt" IS NULL)
         AS unused_backup_codes
FROM "user" u
JOIN mfa_enrollment e ON e."userId" = u.id
WHERE u.email = $email;
```

If `unused_backup_codes` is > 0, the user is wrong — guide them through
finding their printed sheet. If it's 0, they really are locked out.

## Resolution

**Identity verification is mandatory before this action.** Phone the
user on the number we have on file, confirm employee details. A reset
done blind is indistinguishable from a takeover by an attacker who
phished the password.

Once verified, run as `claims_migrator`:

```sql
-- 1. Drop the enrollment + all backup codes.
DELETE FROM mfa_challenge   WHERE "userId" = $userId;
DELETE FROM backup_code     WHERE "userId" = $userId;
DELETE FROM mfa_enrollment  WHERE "userId" = $userId;
-- 2. Flip mfa_enabled off so the user can sign in with password alone.
UPDATE "user" SET "mfaEnabled" = false, "mfaSecret" = NULL
WHERE id = $userId;
-- 3. Force a password change at next sign-in (defence in depth).
UPDATE "user" SET "mustChangePassword" = true WHERE id = $userId;
```

Audit row:

```sql
INSERT INTO audit_log
  (id, "tenantId", "actorUserId", "actorType", action, "resourceType",
   "resourceId", after)
VALUES
  (gen_random_uuid(), $tenantId, $oncallUserId, 'system',
   'USER_MFA_RESET_BY_ADMIN', 'user', $userId,
   '{"reason": "lost_device", "verified_via": "phone"}'::jsonb);
```

Tell the user to:

1. Sign in with their existing password.
2. Change the password on the prompt.
3. Re-enrol MFA at `/me/mfa`.
4. **Save the new backup codes** to a password manager this time.

## Audit

Always `USER_MFA_RESET_BY_ADMIN` (event already declared in
`audit.events.ts`). Note the verification method in the `after` payload.
