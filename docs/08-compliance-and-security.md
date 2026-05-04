# 08 — Compliance and Security Framework

This doc captures the regulatory frameworks the platform must satisfy and the technical/operational controls that satisfy them. Treat every checklist item as a CI gate or release gate — code that can't pass these doesn't ship.

---

## Frameworks in scope

### Primary

1. **Digital Personal Data Protection Act 2023 (DPDP)** — Indian data protection law. Applies to all processing of personal data of Indian data principals.
2. **IRDAI Health Insurance Regulations 2016 (and updates)** — for claim records, retention, and portability.
3. **NHA NHCX participant terms** — contractual obligations for being an NHCX participant.
4. **NHA empanelment terms for PMJAY** — contractual obligations for PMJAY-empanelled hospitals (we inherit some via our customers).

### Aligned (not strictly required, but designed-in for HIPAA-aligned posture)

5. **HIPAA Privacy Rule + Security Rule** — Indian patients aren't covered persons, but HIPAA-aligned posture is sometimes a procurement requirement for hospitals serving foreign patients or chains with US ties. Designing for HIPAA-compatible from day 1 is cheaper than retrofitting.

### Sector-specific

6. **NDHM / ABDM standards** — when handling ABHA-linked data.
7. **MCI guidelines** for clinical record handling (now NMC).
8. **State-level health authority variations** — particularly for PMJAY claims data residency in some states.

### Future (not v1)

9. **ISO 27001** — for an enterprise customer demanding it.
10. **SOC 2 Type II** — for international expansion.

---

## DPDP Act 2023 — control matrix

| DPDP Requirement                              | How we satisfy it                                                                                                |
|------------------------------------------------|------------------------------------------------------------------------------------------------------------------|
| Lawful basis for processing                    | Patient consent captured per `ConsentRecord`. Hospital staff consent via employment contract.                    |
| Notice at the time of collection               | Consent screen shows purpose, retention, sharing. Stored in `ConsentRecord.evidence`.                           |
| Purpose limitation                             | Each consent has `consentType` (e.g., `nhcx_processing`, `pmjay_processing`). Code paths check before processing.|
| Data minimization                              | Schema collects only what's needed for the claim. PII fields are encrypted; logs are redacted.                  |
| Accuracy                                       | Patient can request corrections via the hospital admin (process documented in `docs/08-compliance-and-security.md`). |
| Storage limitation                             | Soft-delete + 7-year retention floor (IRDAI). Beyond that, automated archival → physical delete.                 |
| Right to erasure                               | Patient erasure request initiates `consent.revoked` event; data flagged for accelerated deletion subject to IRDAI floor. |
| Right of access                                | Patient or hospital admin can export the patient's record via `GET /patients/:id/export?format=...`.            |
| Notification of breach                         | Incident-response runbook in `infra/runbooks/breach.md`. DPI notified within 72 hours per DPDP.                 |
| Children's data (under 18)                     | Special consent flow; parental consent required. Flagged at intake.                                              |
| Cross-border transfer                          | All data resident in India (OVH India region). LLM API calls (OpenAI) processed via India-region endpoint when available; if not, only de-identified content sent. |
| Data Protection Officer                        | DigiSparsh-level DPO appointment recorded in tenant onboarding pack.                                            |

### Key code patterns

```ts
// Before any data access, check consent
const consent = await consentService.requireConsent(patientId, 'nhcx_processing');
if (!consent.granted) throw new ConsentNotGivenError();

// Before exporting, log
await auditService.log({
  actorUserId: user.id,
  action: 'EXPORTED',
  resourceType: 'Patient',
  resourceId: patientId,
});

// Before sending to LLM, redact
const redacted = piiRedactor.redact(eobText);
const parsed = await openaiClient.parse(redacted);
```

---

## IRDAI compliance

| IRDAI Requirement                              | Control                                                                                                          |
|------------------------------------------------|------------------------------------------------------------------------------------------------------------------|
| Claim record retention 7 years                 | `audit_log` and `claim_event` partitions retained 7 years on cold storage. Physical delete only after 7 years.   |
| Auditable trail of every claim transition      | `claim_event` is append-only with cryptographic chain (each event references prevEventId).                       |
| TPA notification SLAs                          | SLA timers enforce hospital-side TAT; payer SLAs tracked but not directly enforceable.                           |
| Adjudication transparency                      | EOB upload and parsing makes deduction reasons visible; short-pay workflow records categorised reasons.          |
| Grievance handling                             | Appeal workflow tracks every step; export-ready records for IRDAI inspection.                                    |
| Data security                                  | Encryption at rest, TLS 1.2+ in transit, RBAC, audit log.                                                        |

---

## NHCX participant compliance

Per NHCX participant terms each hospital tenant must:
- Maintain X.509 certificate (we manage on their behalf)
- Respond to callbacks within stated SLA
- Maintain audit trail of every transaction
- Implement consent flow per NHA spec
- Honor data exchange standards (FHIR R4 with Indian profiles)

We satisfy these by:
- HSM-backed (or KMS-wrapped, in v1) signing keys
- High-availability callback receiver + immediate 200 ack
- `integration_message` and `nhcx_bundle` tables capture every byte exchanged
- `ConsentRecord` model + UI consent flow before data exchange
- NA-published profile validation via the `fhir` npm package

---

## HIPAA-aligned posture

We don't claim HIPAA compliance (Indian patients ≠ HIPAA covered persons), but we build infrastructure that's compatible if a customer requires it:

| HIPAA Safeguard                | Our posture                                                                                       |
|--------------------------------|---------------------------------------------------------------------------------------------------|
| Administrative — workforce training | Onboarding training for all dev team; access policies documented.                            |
| Administrative — access control | RBAC, least-privilege, MFA for admin roles.                                                      |
| Physical — facility access     | OVH SOC2/ISO27001 compliant data center.                                                         |
| Physical — workstation/device  | Devs use full-disk-encrypted laptops; production access via bastion + MFA.                       |
| Technical — access control     | Unique user IDs, automatic logoff (15 min idle), encryption.                                     |
| Technical — audit controls     | AuditLog table, append-only, queryable by tenant admins.                                         |
| Technical — integrity          | DB backups + checksums; event-sourced claim aggregate is replayable.                              |
| Technical — transmission       | TLS 1.2+ everywhere; mTLS where mandated.                                                         |
| Technical — encryption at rest | Postgres column-level via pgcrypto; OVH KMS wrapping; OVH Object Storage server-side encryption.  |

If a customer needs a Business Associate Agreement (BAA), our parent entity can sign one. Operational controls support it.

---

## NDHM / ABDM standards

When handling ABHA-linked data:
- Use ABDM-published consent format
- Honor consent revocation immediately (consent revoked → no further data processing)
- Never store Aadhaar numbers (only ABHA IDs/addresses)
- Use ABDM-published FHIR profiles

---

## Encryption at rest

| Data class                | Mechanism                                                  |
|---------------------------|------------------------------------------------------------|
| PII columns (name, mobile, etc.) | `pgcrypto` symmetric encryption, key per tenant     |
| Aadhaar (we don't store, but if forced) | Envelope encryption, per-row data key          |
| Documents (in OVH Object Storage) | Server-side encryption with KMS-managed keys      |
| Tenant credentials (NHCX cert keys, portal passwords) | Wrapped by OVH KMS, stored in `tenant_secret` |
| Backups                   | Encrypted at rest by Postgres TDE or OVH Backup     |

Per-tenant key isolation: a key compromise affects one tenant, not all.

---

## Encryption in transit

- TLS 1.2 minimum, 1.3 preferred
- HSTS header with 1-year max-age
- Certificate pinning for outbound NHCX/NHA calls (NHA's cert)
- mTLS for inbound NHCX callbacks if/when NHA mandates

---

## Authentication and authorization

- Passwords: Argon2id, time = 3, memory = 64 MB, parallelism = 4
- Sessions: 15-minute access tokens, 7-day refresh tokens, refresh token rotation on use
- MFA: TOTP via authenticator app; required for admin roles
- Doctor signature: short-lived (10 min) signed JWT scoped to one preauth ID
- RBAC: role-based + per-permission
- ABAC: tenant scoping enforced by RLS + JWT tenant claim

---

## Audit log requirements

Every audit log entry has:
- `occurredAt` (UTC ISO timestamp)
- `actorUserId` (or "system")
- `actorType`
- `action` (CREATED, UPDATED, VIEWED, EXPORTED, DELETED, LOGGED_IN, LOGGED_OUT, FAILED_LOGIN, etc.)
- `resourceType`, `resourceId`
- `before`, `after` (for UPDATEs)
- `ipAddress`, `userAgent`
- `correlationId` (links to the originating request)
- `tenantId`

Append-only via RLS policies. Backed up separately. Retained 7 years.

Compliance officer can query their tenant's audit log via UI.

---

## Operational security

- **Dev access to prod**: zero direct access. Access via bastion + MFA + audited session recording.
- **Schema migrations**: reviewed in PR, applied via CI to staging first, manually approved for production.
- **Rotation**: passwords every 90 days for admin roles; certs when NHA refreshes.
- **Backup**: daily full + WAL-archived continuous, retained 30 days hot + 7 years cold.
- **Disaster recovery**: cross-region backup in another OVH India region; documented RTO/RPO.
- **Incident response**: runbook in `infra/runbooks/`; on-call rotation; post-mortem template.

---

## Data residency

All production data lives in OVH's India region. No cross-border transfer.

The one exception: **OpenAI for EOB parsing**. If OpenAI's India region isn't available, we either use the global region with redacted content (no PII), or build a per-payer regex parser as a fallback. This is captured as risk R-001 in the risk register.

---

## Vulnerability management

- Dependencies scanned by Snyk (or similar) on every PR
- Container images scanned by Trivy in CI
- Annual penetration test against staging environment
- Quarterly internal security review
- Bug bounty program post v1 launch

---

## Compliance checklist (release gate)

Before any release ships to production, all must be ✅:

- [ ] DPDP consent flows implemented and audited
- [ ] All PII fields encrypted at rest
- [ ] No PII in logs (verified by PII scanner CI step)
- [ ] RLS policies on every tenant-scoped table
- [ ] Cross-tenant access test passes
- [ ] Audit log captures the operation in scope
- [ ] Error responses don't leak internal data
- [ ] Rate limiting active
- [ ] Backups tested (restore drill ≤30 days old)
- [ ] All external API calls logged to `integration_message`
- [ ] Data retention policy enforceable (partition pruning runs)
- [ ] OpenAPI spec free of internal-only fields
- [ ] Documentation updated for new data classes

---

## Risk register (excerpt)

| ID    | Risk                                                | Likelihood | Impact | Mitigation                                                |
|-------|------------------------------------------------------|------------|--------|------------------------------------------------------------|
| R-001 | OpenAI India region unavailable                       | Medium     | Low    | Redact before send; fallback to manual parsing             |
| R-002 | NHCX portal change breaks our flow                   | Medium     | High   | Contract tests + circuit breaker; alerts                   |
| R-003 | PMJAY-MP portal redesign                              | High       | Medium | Assist mode in v1 unaffected; auto-mode mitigation in v2   |
| R-004 | Cross-tenant data leakage via app bug                | Low        | Critical| RLS hard floor + CI tests                                 |
| R-005 | Lost private NHCX cert                                | Low        | High   | Per-tenant keys in KMS; rotation runbook                   |
| R-006 | Bulk PII exfiltration via compromised admin           | Low        | Critical| MFA, session recording, anomaly detection                 |
| R-007 | DDoS on callback endpoint                            | Medium     | Medium | Nginx rate limit, DDoS protection at OVH edge              |

---

## DPI (Data Principal Issues)

**Right to erasure handling**:
1. Patient submits erasure request via hospital admin.
2. Hospital admin opens platform → Patient → "Erasure Request".
3. System captures justification, marks `Patient.erasureRequestedAt`.
4. Compliance officer reviews. If IRDAI 7-year retention has lapsed, fast-track delete. Else, schedule for end of retention period.
5. All actions logged with full audit trail.

**Right of access**:
- Patient submits request via hospital admin.
- Hospital admin exports record via UI (`GET /patients/:id/export`).
- Export captured in audit log.
- Delivered to patient via secure email or paper.
