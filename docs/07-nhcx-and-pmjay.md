# 07 — NHCX and PMJAY Integration Specs

This doc captures the integration details for both rails: message types, headers, encryption, callbacks, correlation chaining, and the mode-router design for PMJAY.

---

## NHCX — National Health Claims Exchange

### Architecture

NHCX is operated by NHA. It's an asynchronous FHIR R4 messaging gateway. Every participant (provider, payer, TPA) has a unique participant code (`<id>@hcx`) and registers callback URLs for receiving responses.

For our platform, **the hospital is the participant**, not us. Each tenant onboards with their own HFR facility ID and NHCX participant code. We act as the technical integrator.

### Onboarding flow per hospital

1. Hospital registers HFR facility (one-time, done by hospital with NHA).
2. Hospital obtains NHCX participant code (`<sender_code>@hcx`).
3. Hospital generates X.509 cert and submits public key to NHA.
4. Hospital configures callback URL (points to our gateway, shared between DigiSparsh and the new platform).
5. We store the encrypted private key in tenant config.

### Message types in v1

| Message               | Purpose                                | Direction    | Endpoint                          |
|-----------------------|----------------------------------------|--------------|-----------------------------------|
| `insuranceplan/request` | Lookup policy details by policy number | Outbound     | `/api/insuranceplanhcxservice/insuranceplan/request` |
| `insuranceplan/on_request` | Response with policy details         | Inbound      | callback                          |
| `coverageeligibility/check` | Verify coverage for a service       | Outbound     | `/api/coverageeligibilityhcxservice/coverageeligibility/check` |
| `coverageeligibility/on_check` | Coverage verification response   | Inbound      | callback                          |
| `preauth/submit`      | Submit pre-authorization                | Outbound     | `/api/preauthhcxservice/preauth/submit` |
| `preauth/on_submit`   | Pre-auth response                       | Inbound      | callback                          |
| `claim/submit`        | Submit final claim                      | Outbound     | `/api/claimhcxservice/claim/submit` |
| `claim/on_submit`     | Claim response                          | Inbound      | callback                          |
| `communication/request` | Outbound query / response              | Both         | `/api/communicationhcxservice/communication/request`, `/communication/on_request` |
| `paymentnotice/request` | Payment notification                  | Inbound      | callback                          |
| `task/submit`         | Reprocess request                       | Outbound     | `/api/taskhcxservice/task/submit` |
| `task/on_submit`      | Reprocess response                      | Inbound      | callback                          |

### Required headers (every outbound)

```
x-hcx-correlation_id    Unique per chained operation
x-hcx-status            "request.initiated" for new, others for follow-ups
x-hcx-request_id        Unique per individual request
x-hcx-ben-abha-id       Beneficiary's ABHA ID (if available)
x-hcx-timestamp         Unix epoch ms
x-hcx-recipient_code    Payer's @hcx code
x-hcx-sender_code       Hospital's @hcx code
x-hcx-workflow_id       "1" for v1
x-hcx-api_call_id       Same as correlation_id for first call
x-hcx-use_case          "New" | "Enhancement" | etc.
```

### Body convention quirk

**Inherited from DigiNode** — the `nhcxfunctions.ts` `globalAxiosAPI` function carries this comment:

> NHCX microservices have inconsistent body contracts: insuranceplanhcxservice + coverageeligibilityhcxservice REJECT the `type` field. So omit `type` for insurance and coverage; include it for the rest.

```ts
const omitType = apiType === 'insurance' || apiType === 'coverage';
const body = omitType ? { payload: jwe } : { payload: jwe, type: 'JWEPayload' };
```

This is a known quirk; encode it in the adapter.

### Encryption

Every payload is JWE-encrypted using the recipient's (payer's) public certificate, RSA-OAEP-256 + A256GCM.

```ts
const jwe = await jose.JWE.createEncrypt(
  { format: 'compact', fields: headers, algorithms: ['RSA-OAEP-256', 'A256GCM'] },
  recipientPublicKey,
).update(JSON.stringify(payload), 'utf8').final();
```

Recipient certs are fetched from NHA's registry and cached per recipient code. Refresh cadence: weekly, or on signature failure.

### Inbound callback flow

1. NHA POSTs to our gateway URL (e.g., `https://gateway.digisparsh.in/callbackForNHCX/v1/preauth/on_submit`).
2. Gateway authenticates (TLS + future mTLS if NHA mandates).
3. Receiver persists raw payload to `integration_message` (direction: inbound, status: pending).
4. Receiver returns 200 immediately to NHA.
5. Receiver enqueues `nhcx.process-callback` job.
6. Worker decrypts JWE using our (sender's) private key.
7. Validates signature.
8. Updates `nhcx_bundle.bundleResponse` for the matching correlation_id.
9. Records appropriate `claim_event`.
10. Updates materialised `claim.status`.
11. Pushes SSE notification to connected frontend.

**Decoupling receipt from processing** is critical — even if our worker is slow or down, NHA gets its 200 within milliseconds.

### Correlation chain

Per the existing `NhcxBundlesSchema` in DigiNode, correlation IDs chain through the lifecycle:

```
insuranceCorrelationId
   ↓
coverageCorrelationId  (refers to insurance)
   ↓
preauthCorrelationId   (refers to coverage)
   ↓
enhancementCorrelationId  (refers to preauth)
   ↓
dischargeCorrelationId  (refers to preauth or enhancement)
   ↓
claimCorrelationId  (refers to discharge)
   ↓
paymentCorrelationId  (refers to claim)

communicationCorrelationId  (refers to whatever the query is about)
reprocessCorrelationId  (special)
```

The new platform stores this chain on the `Claim` row plus the full FHIR bundle history in `NhcxBundle`.

### NHA sandbox vs production

V1 builds against NHA sandbox. Cutover to production happens after:
- All message types pass contract tests against the sandbox.
- The dummy-payer harness (ported from DigiNode) confirms end-to-end flow.
- Hospital's HFR ID and participant code are production-registered.
- Callback URLs are registered with NHA.
- Cert is rotated to production.

---

## PMJAY — Pradhan Mantri Jan Arogya Yojana

### Architecture

PMJAY runs on NHA's National Transaction Management System (TMS). Provider workflow access varies by:
- **State** — each State Health Agency (SHA) configures TMS access for its empanelled hospitals
- **Operation** — some operations have APIs, others are portal-only
- **Co-existing state schemes** — MP, MH, TN, KA each run state-level schemes alongside PMJAY (e.g., MP's Mukhya Mantri schemes)

### Operations and modes

Every PMJAY operation is one of:

| Operation                      | What it does                                |
|--------------------------------|---------------------------------------------|
| `verify_beneficiary`           | Validate PMJAY card / family ID             |
| `lookup_packages`              | Search HBP package master                   |
| `submit_preauth`               | Submit pre-authorization                    |
| `respond_to_query`             | Reply to NHA medical auditor query          |
| `submit_claim`                 | Final claim submission                      |
| `upload_document`              | Attach a document                           |
| `fetch_status`                 | Poll claim status                           |
| `download_eob`                 | Get EOB / payment letter                    |

Each operation × state combination has a configured **mode**:

- `api` — operation has a working API; we use it
- `auto` — no API but Playwright automation defined and active (v2)
- `assist` — no API and no automation (v1 default for portal-only ops); platform pre-fills, executive submits in portal
- `manual` — no help; executive does it themselves and updates platform with result

### Mode router

```ts
class ModeRouter {
  routeFor(tenantId: string, state: string, operation: string): Mode {
    // 1. Check tenant's per-operation override
    const tenantMode = tenantConfig.pmjay[state]?.[operation];
    if (tenantMode) return tenantMode;

    // 2. Check system health — if portal/api degraded, fall back to assist
    if (healthMonitor.isDegraded(state, operation)) return 'assist';

    // 3. Check operation capability for state
    const capability = stateAdapter[state][operation];
    return capability.defaultMode;
  }
}
```

### V1 — manual + assist only

In v1 only `verify_beneficiary` and `lookup_packages` use real APIs (BIS API). Everything else is `assist` mode.

The assist payload is generated server-side and shown to the PMAM as a side panel:

```
ASSIST PANEL — PMJAY Pre-auth submission for case 9F2A...

Step 1. Open https://pmjay-mp.nha.gov.in (or your usual PMJAY portal)

Step 2. Click "New Pre-auth"

Step 3. Enter the following values:
  Patient PMJAY ID:    PMJM1234567890
  Family ID:           FAM-MP-2024-0123
  Package code:        SCC-001-A
  Procedure name:      Coronary Artery Bypass Graft
  Diagnosis (ICD-10):  I25.10
  Estimated amount:    ₹90,000
  Treating doctor:     Dr. <name>, MCI <number>

Step 4. Upload these documents (already prepared, downloadable):
  ✓ Pre-auth form (download)
  ✓ Investigation reports (download)
  ✓ Clinical summary (download)

Step 5. Submit on the portal.

Step 6. Paste the PMJAY reference number you received here:
  [____________]
  [Confirm]
```

After confirmation, the platform records the reference and treats the claim as `PREAUTH_SUBMITTED`. From there, PMAM checks the portal periodically and updates status manually until v2 automation lands.

### V2 — auto mode design (designed in v1, wired later)

The framework lives in code; only the activation flag is off in v1.

#### Per-state YAML flow definitions

```yaml
# apps/api/src/integrations/pmjay/flows/MP/submit_preauth.yaml
state: MP
operation: submit_preauth
portal_base: https://pmjay-mp.nha.gov.in
version: 1.0
credentials_ref: tenant.pmjay.mp.portal_credentials
steps:
  - action: navigate
    url: /provider/login
  - action: fill
    selector: "#username"
    value: "{{credentials.username}}"
  - action: fill
    selector: "#password"
    value: "{{credentials.password}}"
  - action: click
    selector: "button[type='submit']"
  - action: wait_for_navigation
    expect_url_pattern: "/provider/dashboard"
  - action: navigate
    url: /preauth/new
  - action: fill
    selector: "input[name='pmjay_id']"
    value: "{{patient.pmjay_id}}"
  - action: select
    selector: "select[name='package_code']"
    value: "{{claim.package_code}}"
  - action: fill
    selector: "textarea[name='clinical_summary']"
    value: "{{preauth.clinical_summary}}"
  - action: upload
    selector: "input[name='preauth_form']"
    file: "{{documents.preauth_form}}"
  - action: click
    selector: "button.submit-preauth"
  - action: wait_for
    selector: ".reference-number"
    timeout_ms: 15000
  - action: capture
    from: ".reference-number"
    as: pmjay_preauth_ref
  - action: capture_screenshot
    name: confirmation
on_failure:
  - capture_screenshot: failure
  - capture_dom: failure_dom
  - classify: |
      if .captcha-modal exists → "captcha"
      if .selector_not_found error → "selector_drift"
      else → "unknown"
```

#### Executor

A NestJS worker module:

```ts
@Injectable()
export class FlowExecutor {
  async execute(flow: Flow, context: FlowContext): Promise<FlowResult> {
    const browser = await chromium.launch({ headless: true });
    const browserContext = await browser.newContext({ recordVideo: { dir: '/tmp/' } });
    await browserContext.tracing.start({ screenshots: true, snapshots: true });
    const page = await browserContext.newPage();

    try {
      for (const step of flow.steps) {
        await this.executeStep(page, step, context);
      }
      const captured = this.captureValues(context);
      return { status: 'success', captured };
    } catch (e) {
      const failureClass = await this.classify(page, e);
      return { status: 'failed', failureClass, error: e.message };
    } finally {
      await browserContext.tracing.stop({ path: traceUrl });
      await browser.close();
      await uploadTrace(traceUrl);
    }
  }
}
```

#### Health monitoring

- Daily cron runs a smoke test per state per operation
- Smoke test = login + navigate + verify a known element + logout (no real submission)
- 3 consecutive failures → mode for that state-op flips to `assist` automatically
- Alert to engineering channel
- When fix lands and 2 smoke tests pass, mode flips back to configured default

### State expansion model

Adding UP after MP (in v2):
1. Create `apps/api/src/integrations/pmjay/flows/UP/*.yaml` for each operation
2. Register UP in `state-registry.ts` with capability matrix
3. Smoke tests start running automatically
4. Hospitals in UP can opt-in via tenant config

No core code change. Pure data work.

### Audit trail (v2)

Every automation run writes a `PmjayAutomationRun` row:

```
runId, submissionId, workerHost, browserVersion, flowVersion,
startedAt, endedAt, status, failureClass,
traceUrl (link to OVH Object Storage),
screenshotUrls: String[]
```

Any auditor can replay exactly what the bot did.

### State scheme co-existence

MP runs PMJAY plus state schemes (state-level Mukhya Mantri schemes). Hospitals route certain patient categories through the state scheme rather than PMJAY.

Data model: `Claim.rail = 'pmjay'` covers both; `pmjay_beneficiary.stateScheme` distinguishes ('PMJAY' vs 'MP-AB-NIRAMAYAM' vs 'MP-MMSY' etc.). Package master and submission flow vary; the integration adapter picks the right portal flow.

V1 supports PMJAY only; state schemes are flagged in data but not deeply integrated. V1.5 expands.

---

## Common patterns across both rails

### Idempotency

Every outbound message has an idempotency key. If retried, the gateway returns the original response without re-submitting.

### Retry budget

5 retries with exponential backoff: 1s, 4s, 16s, 64s, 256s. Then dead-letter.

### Circuit breaker

Per integration. Opens at >50% failure rate over 1-minute window. Half-open after 30s. Closes after 1 successful probe.

### Logging redaction

Never log:
- JWE-encrypted payloads (they're meaningless once decrypted out of context, and they contain PII)
- ABHA IDs
- Aadhaar numbers
- Policy numbers
- Card numbers

Log:
- Correlation IDs
- Status codes
- Timing
- Failure classes

Use the `RedactedLogger` decorator on integration services.
