# Runbooks

Operational playbooks for common Sprint-1 incidents. Each runbook has the
same shape:

- **Symptom** — what the user / oncall sees.
- **Diagnosis** — quick checks to confirm the scenario.
- **Resolution** — concrete commands. SQL is run via the `claims_migrator`
  role unless noted.
- **Audit** — what to log after the action so the trail is intact.

Add a new runbook here whenever an incident requires an undocumented
manual step. A runbook is the canonical "we have a process for this"
artefact — Slack threads age out, runbooks don't.

## Index

- [locked-account-recovery.md](./locked-account-recovery.md) — user is locked out from too many failed logins.
- [mfa-lost-device.md](./mfa-lost-device.md) — user has lost their authenticator app + has no backup codes.
- [ip-allowlist-self-lockout.md](./ip-allowlist-self-lockout.md) — admin saved an allowlist that excludes their own IP.
- [refresh-token-reuse-detected.md](./refresh-token-reuse-detected.md) — the rotation guard fired; investigate.
