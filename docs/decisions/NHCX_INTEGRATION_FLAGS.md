# NHCX integration flags — decision record

Three architectural decisions for talking to NHA's NHCX gateway cannot be settled offline against our spec corpus because the authoritative pages on `nhcx.abdm.gov.in/NHCX_Specifications/*` and `nhcx.abdm.gov.in/technical-specifications/open-protocol/*` are single-page-app shells with no captured body text. They were flagged in [GAP_ANALYSIS.md](../../../GAP_ANALYSIS.md) (rows 2.1, 2.10, 9.3).

Rather than wait for an authoritative answer, each decision is exposed as a runtime env flag so the platform can be flipped without a code change as soon as the first NHCX sandbox call comes back with a specific error class. This document captures what each flag controls, the current default, the evidence behind that default, and the symptoms that should trigger a flip.

All three flags are read by [`NhcxJweAdapter.callOperation`](../../apps/api/src/modules/nhcx/nhcx-jwe.adapter.ts) via `ConfigService` — flipping them requires only a restart, no rebuild.

---

## 1. `NHCX_HEADER_STYLE` — header naming convention

**Question.** Does NHA's gateway expect HTTP header names in hyphenated form (`x-hcx-correlation-id`) or underscored form (`x-hcx-correlation_id`)?

**Options.**
- `hyphenated` *(default)* — all 11 outbound headers use `x-hcx-foo-bar`.
- `underscored` — `correlation_id`, `request_id`, `recipient_code`, `sender_code`, `workflow_id`, `api_call_id`, `use_case` keep underscores; `ben-abha-id` / `timestamp` / `status` / `operation` stay hyphenated either way.

**Evidence for the default.**
- Our inbound HTTP Signature guard (`apps/api/src/modules/nhcx/inbound/http-signature.ts:13–16`) validates the hyphenated form and is presumed to have been tested against real NHA callbacks during Sprint 5.
- HCX 0.7.1 reference implementations on GitHub use the hyphenated form.

**Evidence pointing the other way.**
- `docs/07-nhcx-and-pmjay.md:42–53` reproduces the headers in the underscored form, attributing the table to DigiNode's earlier NHCX integration.

**Symptom that should flip the flag.**
- NHA's gateway returns HTTP 400 with a body mentioning "missing header" or "invalid header name" on the very first outbound call after sandbox cutover.

**Flip command:** `NHCX_HEADER_STYLE=underscored` then restart the API.

---

## 2. `NHCX_WIRE_FORMAT` — request body envelope

**Question.** What does NHA's gateway expect as the POST body — a bare compact JWE string with `content-type: application/jose`, or a JSON envelope `{"payload":"<jwe>","type":"JWEPayload"}` with `content-type: application/json`?

**Options.**
- `bare` — raw JWE compact string, `content-type: application/jose`.
- `envelope` — JSON object `{"payload":"<jwe>","type":"JWEPayload"}` for every operation.
- `envelope-omit-type-insurance-coverage` *(default)* — same as `envelope` except that `insuranceplan/*` and `coverageeligibility/*` operations omit the `type` field. This matches the documented DigiNode quirk.

**Evidence for the default.**
- `docs/07-nhcx-and-pmjay.md:55–66` reproduces the inherited DigiNode comment verbatim: *"NHCX microservices have inconsistent body contracts: insuranceplanhcxservice + coverageeligibilityhcxservice REJECT the `type` field. So omit `type` for insurance and coverage; include it for the rest."* This implies the JSON envelope is the production wire format and the conditional `type` field is the actual rule.

**Symptom that should flip the flag.**
- HTTP 400 with body mentioning "invalid payload", "payload missing", or schema-validation failure → check whether `bare` or `envelope` is the right shape. The two error bodies usually differ enough to tell.
- HTTP 400 specifically on `insuranceplan/request` or `coverageeligibility/check` mentioning an unexpected `type` field → revert to `envelope-omit-type-insurance-coverage` (the default), which already handles this.
- Both insurance/coverage and the rest of the operations succeed under plain `envelope` → simplify by setting `NHCX_WIRE_FORMAT=envelope` to remove the conditional.

**Response handling.** The adapter is forgiving on the response path: it detects JSON-envelope-wrapped responses by `Content-Type: application/json` (or a structural sniff for a `{` start) and unwraps the `.payload` field before decrypting. So the response can come back in either shape regardless of which request format we used.

**Flip command:** `NHCX_WIRE_FORMAT=bare` (or `envelope`) then restart the API.

---

## 3. `NHCX_MTLS_ENABLED` — outbound mutual TLS

**Question.** Does NHA's gateway require mutual TLS for outbound calls, or just one-way TLS with Cavage HTTP Signature on the application layer?

**Options.**
- `false` *(default)* — plain HTTPS, server cert verified against Node's system trust store. Application-level authentication via Cavage HTTP Signature (always on, see `NHCX_SIGN_OUTBOUND`).
- `true` — outbound calls present a client certificate. Requires `NHCX_MTLS_CLIENT_CERT_BASE64` + `NHCX_MTLS_CLIENT_KEY_BASE64`. Optional `NHCX_MTLS_CA_BASE64` pins the NHA CA bundle for server-cert verification.

**Evidence for the default.**
- `docs/08-compliance-and-security.md:152` literally says *"mTLS if/when NHA mandates"* — i.e. it was not required on the sandbox at the time the platform's compliance doc was written.
- Inbound callbacks are authenticated via Cavage HTTP Signature (Sprint 5 / Slice AO), which is the application-layer alternative to mTLS. NHA accepting unsigned-by-cert callbacks from us today implies they don't require mTLS the other direction either.

**Evidence pointing the other way.**
- Production-grade healthcare integrators (CKYC, GST) in India tend to mandate mTLS once they move past sandbox. NHA's posture may harden as production traffic grows.

**Symptom that should flip the flag.**
- Outbound `fetch` fails with `ECONNRESET` immediately after the TLS handshake, before any HTTP response → NHA closed the connection because no client cert was offered.
- The NHA's onboarding portal asks you to upload a "client certificate" rather than (or in addition to) the JWE signing public key.

**Flip command + config.**
```bash
NHCX_MTLS_ENABLED=true
NHCX_MTLS_CLIENT_CERT_BASE64=<base64-encoded PEM>
NHCX_MTLS_CLIENT_KEY_BASE64=<base64-encoded PEM>
# Optional but recommended for defence in depth:
NHCX_MTLS_CA_BASE64=<base64-encoded PEM bundle of NHA's CA chain>
```

The platform validates the cert + key presence at boot — a misconfiguration (e.g. `NHCX_MTLS_ENABLED=true` with no cert) refuses to start rather than silently degrading to plain HTTPS.

**Implementation note.** Outbound fetch uses an `undici.Agent` dispatcher when mTLS is enabled. The dispatcher is lazily constructed on the first outbound call and cached on the adapter instance so the TLS connection pool is reused across calls.

---

## How to decide what flipped first

When NHA's sandbox starts rejecting calls and you don't yet know which of the three is wrong, decide in this order:

1. **mTLS first** — if the failure is `ECONNRESET` or "TLS handshake failed" *before* any HTTP body comes back, it's a transport-layer rejection. Try `NHCX_MTLS_ENABLED=true`.
2. **Header style second** — if the failure is HTTP 400 with a body that names a specific header (e.g. "x-hcx-correlation_id required" or "unknown header x-hcx-correlation-id"), flip `NHCX_HEADER_STYLE`.
3. **Wire format last** — if the failure is HTTP 400 with a generic schema error and the headers don't look at fault, flip `NHCX_WIRE_FORMAT`. The default already encodes the DigiNode quirk; consider `envelope` (always include `type`) or `bare` (raw JWE).

Each flip is a restart, no rebuild. Capture the failing request + response in [`integration_message`](../../apps/api/prisma/schema.prisma) so the next operator has the diagnostic trail.

---

## Test surface

- The header-style switch is covered by [`outbound-http-signature.spec.ts`](../../apps/api/src/modules/nhcx/outbound-http-signature.spec.ts) via the inbound verifier round trip.
- Wire format + mTLS dispatcher branches don't have dedicated unit tests yet — the integration test that exercises them lives behind `NHCX_MODE=real`, which is the sandbox-cutover smoke test. Both branches typecheck and unit-test cleanly through the existing 389-test suite.

Once NHA's behaviour is observed on the first real outbound call, this doc should be updated with the locked-in default and the flag converted to a hardcoded constant (or removed entirely).
