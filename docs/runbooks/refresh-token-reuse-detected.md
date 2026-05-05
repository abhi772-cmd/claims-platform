# Refresh-token reuse detected

## Symptom

A user reports `Sign-in reset for safety` (HTTP 401,
`AUTH_REFRESH_TOKEN_REUSE_DETECTED`). All of their sessions across all
devices were force-logged-out. They want to know what happened.

## Background

When a refresh token is rotated, the previous hash is recorded in
`session_token_history`. If we ever see that previous hash again, it
means somebody other than the legitimate session is holding it (the
real session has long-since rotated past it). The platform treats this
as compromise: deletes every session for the user and forces re-login.

Code path: `AuthService.refresh` → `RefreshTokenReuseDetectedError`.

## Diagnosis

Find the trigger event:

```sql
SELECT "occurredAt", "actorUserId", "ipAddress", "userAgent", after
FROM audit_log
WHERE "tenantId" = $tenantId
  AND "actorUserId" = $userId
ORDER BY "occurredAt" DESC
LIMIT 50;
```

Look for the most recent `USER_LOGGED_OUT` rows clustered together
(one per evicted session). The `ipAddress` and `userAgent` of the
nearby `USER_LOGGED_IN` rows tell you which sessions existed.

Cross-check `session_token_history`:

```sql
SELECT s."sessionId", s."rotatedAt", h."refreshTokenHash"
FROM session_token_history h
LEFT JOIN session s ON s.id = h."sessionId"  -- NULL if session was deleted
WHERE h."userId" = $userId
ORDER BY h."rotatedAt" DESC
LIMIT 20;
```

If the same `refreshTokenHash` shows up twice, you've confirmed a
reuse event.

## Resolution

The platform has already done the right thing — all sessions are gone
and the user is forced to sign in again. The remaining work is:

1. **Talk to the user.** They likely just have a stale tab somewhere
   (an old browser process woke up and tried to refresh with a dead
   token). That's benign. The bigger concern is whether they still
   trust their devices.

2. **If compromise is plausible:**
   - Force a password change:
     ```sql
     UPDATE "user" SET "mustChangePassword" = true WHERE id = $userId;
     ```
   - Revoke all trusted devices:
     ```sql
     UPDATE trusted_device SET "revokedAt" = NOW()
     WHERE "userId" = $userId AND "revokedAt" IS NULL;
     ```
   - Recommend MFA enrolment if not already enabled.

3. **If reuse is recurring** (the same user trips this multiple times
   in a week): investigate the user's environment. Possible causes:
   - Browser extension that aggressively caches cookies.
   - Multiple browser profiles signed in concurrently.
   - Actual credential theft.

## Audit

The reuse detection itself doesn't write a dedicated audit row in
Sprint 1 — only the resulting session deletes. Sprint 2 will add a
`SECURITY_REFRESH_REUSE_DETECTED` event. Note the gap in
`docs/sprint-1-exit.md`.
