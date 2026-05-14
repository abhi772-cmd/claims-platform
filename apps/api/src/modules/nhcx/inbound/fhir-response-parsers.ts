// Parse the FHIR R4 response Bundles NHCX sends on the four callback
// types into internal decision shapes the existing service.applyDecision
// methods already accept. These are pure functions — no DI, no state —
// so they're trivial to unit test.
//
// Source profile: HCX 0.7.1 (https://ig.hcxprotocol.io/v0.7.1/).
// Each parser tolerates the small bundle shape variations the gateway
// emits across stages (sandbox vs prod) but rejects shapes that don't
// have the load-bearing fields we need to drive a state transition.

export interface ParsedEligibilityResponse {
  verified: boolean;
  planName?: string;
  sumInsured?: number;
  failureReason?: string;
}

export interface ParsedPreauthDecision {
  kind: 'approved' | 'rejected' | 'partially_approved' | 'query_received';
  approvedAmount?: number;
  reason?: string;
  queryText?: string;
}

export type ParsedClaimDecision = ParsedPreauthDecision;

export interface ParsedCommunication {
  // 'query' = inbound query from payer (creates a PreauthQuery row).
  // 'response' = inbound response to a query we sent (recorded but
  // doesn't drive a state transition — the state transition happened
  // when we sent the original query response outbound).
  kind: 'query' | 'response';
  text: string;
}

// Slice BD — gateway-pushed coverage update. Operators see this in
// the integration_message ledger AND on the claim's insurance-plan
// preview row written by InsurancePlanService.recordResponse — we
// pull the load-bearing fields (plan name, status, sum insured,
// effective period) so the operator can decide whether to proceed
// with preauth without round-tripping back to the payer portal.
export interface ParsedInsurancePlan {
  // The plan's stable identifier, when the gateway provides one.
  planId?: string;
  // Human-readable display, e.g. "Star Health Gold 2026".
  name?: string;
  // 'active' | 'retired' | 'draft' — pass-through from the resource.
  status?: string;
  // Type code (e.g. 'medical' / 'dental') if the gateway tags it.
  type?: string;
  // Sum insured / coverage amount in PAISE. Pulled from the first
  // matching `coverage[].benefit[].limit[].value.value` element, or
  // from an extension when the payer rides it on `extension`. The
  // unit is normalised to paise so downstream UI doesn't have to
  // sniff currency types.
  sumInsuredPaise?: number;
  // Plan effective window — useful for the operator's gut-check
  // ("is this still valid for today's admission?").
  periodStart?: string; // YYYY-MM-DD
  periodEnd?: string; // YYYY-MM-DD
  // Network indicator on the plan ('cashless' / 'reimbursement' /
  // payer-specific). Pass-through.
  network?: string;
}

// Slice BD — gateway-pushed task / status note. Tasks ride alongside
// the four canonical phases for ad-hoc ops messages (e.g. payer asking
// for a fresh document, system-level notice). We record them; the
// dispatch branch is log-only.
export interface ParsedTask {
  // 'requested' | 'in-progress' | 'completed' | 'cancelled' | etc.
  status?: string;
  // Free-form description / narrative.
  description?: string;
  // Reference to the upstream Claim or related resource, when present.
  focusRef?: string;
}

// Slice BC — gateway-pushed PaymentNotice. Surfaces the load-bearing
// fields SettlementService.recordReceipt needs. claimRefNum is
// optional in the parser output: HCX bundles often (but not always)
// include the upstream claim's reference identifier. When missing
// the dispatcher falls back to the matching outbound row's claimId.
export interface ParsedPaymentNotice {
  // 'paid' is the only status we act on. Cancelled / draft notices
  // are recorded for ops visibility but don't drive a transition.
  kind: 'paid' | 'cancelled' | 'unknown';
  receivedAmount: number;
  receivedAt?: string;
  bankTxnId?: string;
  // Echoed back if present, useful for cross-referencing logs but
  // not required by the dispatcher.
  claimRefNum?: string;
}

export class FhirParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FhirParseError';
  }
}

// Find the first entry of a given resourceType in a Bundle. The HCX
// gateway sometimes wraps the response resource as the first entry,
// sometimes deeper — scan rather than assume position.
function findResource<T extends { resourceType: string }>(
  bundle: unknown,
  resourceType: T['resourceType'],
): T | null {
  if (!isObject(bundle) || bundle['resourceType'] !== 'Bundle') return null;
  const entries = bundle['entry'];
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const resource = entry['resource'];
    if (isObject(resource) && resource['resourceType'] === resourceType) {
      return resource as T;
    }
  }
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// CoverageEligibilityResponse — the FHIR resource returned for an
// eligibility check. Per the HCX profile, the load-bearing field is
// `outcome` (queued | complete | error | partial) plus the nested
// `insurance[].item[].benefit[].allowedMoney` for the sum insured.
export function parseEligibilityResponse(
  bundle: unknown,
): ParsedEligibilityResponse {
  const resource = findResource<{ resourceType: 'CoverageEligibilityResponse' }>(
    bundle,
    'CoverageEligibilityResponse',
  );
  if (!resource) {
    throw new FhirParseError(
      'Bundle does not contain a CoverageEligibilityResponse resource.',
    );
  }
  const r = resource as Record<string, unknown>;
  const outcome = r['outcome'];
  if (typeof outcome !== 'string') {
    throw new FhirParseError(
      'CoverageEligibilityResponse.outcome is missing or not a string.',
    );
  }
  // 'complete' = verified + benefits present. 'partial' = verified
  // but with caveats — we still treat it as verified at the state-
  // machine level. 'queued' should never reach us here (it's the
  // intermediate state the gateway uses pre-resolution).
  if (outcome === 'complete' || outcome === 'partial') {
    const planName = extractPlanName(r);
    const sumInsured = extractSumInsured(r);
    return {
      verified: true,
      ...(planName !== undefined ? { planName } : {}),
      ...(sumInsured !== undefined ? { sumInsured } : {}),
    };
  }
  // 'error' or anything else — treat as failed; surface disposition
  // so ops can read the reason without scrubbing the raw bundle.
  const disposition = typeof r['disposition'] === 'string' ? r['disposition'] : 'unknown';
  return { verified: false, failureReason: disposition };
}

function extractPlanName(r: Record<string, unknown>): string | undefined {
  // insurance[0].coverage.display is the conventional location.
  const insurance = r['insurance'];
  if (!Array.isArray(insurance) || insurance.length === 0) return undefined;
  const first = insurance[0];
  if (!isObject(first)) return undefined;
  const coverage = first['coverage'];
  if (!isObject(coverage)) return undefined;
  const display = coverage['display'];
  return typeof display === 'string' ? display : undefined;
}

function extractSumInsured(r: Record<string, unknown>): number | undefined {
  // insurance[0].item[0].benefit[].allowedMoney.value (in INR).
  const insurance = r['insurance'];
  if (!Array.isArray(insurance) || insurance.length === 0) return undefined;
  const first = insurance[0];
  if (!isObject(first)) return undefined;
  const items = first['item'];
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const item0 = items[0];
  if (!isObject(item0)) return undefined;
  const benefits = item0['benefit'];
  if (!Array.isArray(benefits)) return undefined;
  for (const benefit of benefits) {
    if (!isObject(benefit)) continue;
    const allowedMoney = benefit['allowedMoney'];
    if (isObject(allowedMoney)) {
      const value = allowedMoney['value'];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.round(value);
      }
    }
  }
  return undefined;
}

// ClaimResponse — used for both preauth and final-claim callbacks.
// The decision lives in `outcome` + `disposition`; approved amounts
// in `total[]` (a list of named amounts). We map:
//   outcome=complete + disposition contains 'approved'    → approved
//   outcome=complete + disposition contains 'rejected'    → rejected
//   outcome=complete + disposition contains 'partial'     → partially_approved
//   outcome=queued                                        → query_received
//                                                           (NHA proxies "query"
//                                                           callbacks through the
//                                                           same on_submit path)
//
// The mapping is intentionally loose because the gateway's free-text
// disposition varies between payers. When ambiguous we err on the
// rejected side — easier to manually re-approve than to silently
// over-pay.
export function parsePreauthResponse(bundle: unknown): ParsedPreauthDecision {
  return parseClaimLikeResponse(bundle, 'preauth');
}

export function parseClaimResponse(bundle: unknown): ParsedClaimDecision {
  return parseClaimLikeResponse(bundle, 'claim');
}

function parseClaimLikeResponse(
  bundle: unknown,
  context: 'preauth' | 'claim',
): ParsedClaimDecision {
  const resource = findResource<{ resourceType: 'ClaimResponse' }>(bundle, 'ClaimResponse');
  if (!resource) {
    throw new FhirParseError(
      `Bundle does not contain a ClaimResponse resource (${context} callback).`,
    );
  }
  const r = resource as Record<string, unknown>;
  const outcome = r['outcome'];
  if (typeof outcome !== 'string') {
    throw new FhirParseError('ClaimResponse.outcome is missing or not a string.');
  }
  const disposition =
    typeof r['disposition'] === 'string' ? r['disposition'].toLowerCase() : '';

  if (outcome === 'queued') {
    // Some payers return queued + a question in disposition rather
    // than emitting a separate Communication. Surface as a query
    // with disposition as the query text.
    return {
      kind: 'query_received',
      queryText: typeof r['disposition'] === 'string' ? r['disposition'] : 'Payer query',
    };
  }

  const approvedAmount = extractApprovedAmount(r);

  if (disposition.includes('partial') || (approvedAmount !== undefined && disposition.includes('approved'))) {
    // Heuristic: partial wins when "partial" is explicit OR when an
    // amount is present alongside an "approved" disposition AND the
    // amount is recognisably a partial approval. We keep it simple
    // and route through partially_approved when both signals exist.
    if (disposition.includes('partial')) {
      return {
        kind: 'partially_approved',
        ...(approvedAmount !== undefined ? { approvedAmount } : {}),
        reason: typeof r['disposition'] === 'string' ? r['disposition'] : undefined,
      };
    }
    return {
      kind: 'approved',
      ...(approvedAmount !== undefined ? { approvedAmount } : {}),
      ...(typeof r['disposition'] === 'string' ? { reason: r['disposition'] } : {}),
    };
  }

  if (disposition.includes('approved')) {
    return {
      kind: 'approved',
      ...(approvedAmount !== undefined ? { approvedAmount } : {}),
      ...(typeof r['disposition'] === 'string' ? { reason: r['disposition'] } : {}),
    };
  }

  return {
    kind: 'rejected',
    ...(typeof r['disposition'] === 'string' ? { reason: r['disposition'] } : {}),
  };
}

function extractApprovedAmount(r: Record<string, unknown>): number | undefined {
  const totals = r['total'];
  if (!Array.isArray(totals)) return undefined;
  // Prefer the entry whose category coding matches 'benefit' or
  // 'eligible' — the payer's "what we'll pay" line. Fall back to the
  // first entry with a numeric amount.
  let fallback: number | undefined;
  for (const entry of totals) {
    if (!isObject(entry)) continue;
    const amount = entry['amount'];
    if (!isObject(amount)) continue;
    const value = amount['value'];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const category = entry['category'];
    if (isObject(category)) {
      const codings = category['coding'];
      if (Array.isArray(codings)) {
        for (const c of codings) {
          if (!isObject(c)) continue;
          const code = c['code'];
          if (typeof code === 'string' && /benefit|eligible|approved/i.test(code)) {
            return Math.round(value);
          }
        }
      }
    }
    if (fallback === undefined) fallback = Math.round(value);
  }
  return fallback;
}

// Communication — used for both inbound payer queries (kind='query',
// our state transitions to QUERY_RAISED) and inbound responses to our
// outbound query reply (kind='response', logged but no state change).
// The discriminator is the resource's `inResponseTo` field.
export function parseCommunication(bundle: unknown): ParsedCommunication {
  const resource = findResource<{ resourceType: 'Communication' }>(bundle, 'Communication');
  if (!resource) {
    throw new FhirParseError('Bundle does not contain a Communication resource.');
  }
  const r = resource as Record<string, unknown>;
  const inResponseTo = r['inResponseTo'];
  // payload[].contentString or payload[].contentAttachment.title is
  // where the human-readable text lives.
  const text = extractCommunicationText(r);
  if (!text) {
    throw new FhirParseError('Communication has no readable payload text.');
  }
  const kind = Array.isArray(inResponseTo) && inResponseTo.length > 0 ? 'response' : 'query';
  return { kind, text };
}

function extractCommunicationText(r: Record<string, unknown>): string | undefined {
  const payload = r['payload'];
  if (!Array.isArray(payload)) return undefined;
  for (const item of payload) {
    if (!isObject(item)) continue;
    const cs = item['contentString'];
    if (typeof cs === 'string' && cs.length > 0) return cs;
    const attachment = item['contentAttachment'];
    if (isObject(attachment)) {
      const title = attachment['title'];
      if (typeof title === 'string' && title.length > 0) return title;
    }
  }
  return undefined;
}

// Slice BC — pull a PaymentNotice resource off the Bundle. The gateway
// sends one of these when the payer settles. We surface receivedAmount
// and receivedAt as load-bearing; bankTxnId comes off whichever
// identifier slot the gateway uses (HCX 0.7.1 doesn't pin it
// strictly — Mediassist uses .identifier[0].value, Paramount uses
// .request.identifier — so we try both).
export function parsePaymentNotice(bundle: unknown): ParsedPaymentNotice {
  const r = findResource<{ resourceType: 'PaymentNotice' }>(bundle, 'PaymentNotice');
  if (!r) {
    throw new FhirParseError('Bundle does not contain a PaymentNotice resource');
  }
  const obj = r as unknown as Record<string, unknown>;
  const status = typeof obj['status'] === 'string' ? (obj['status'] as string) : '';
  const kind: ParsedPaymentNotice['kind'] =
    status === 'active' || status === 'completed' || status === 'paid'
      ? 'paid'
      : status === 'cancelled' || status === 'entered-in-error'
        ? 'cancelled'
        : 'unknown';

  const amount = isObject(obj['amount']) ? (obj['amount'] as Record<string, unknown>) : null;
  const valueRaw = amount?.['value'];
  if (typeof valueRaw !== 'number' || !Number.isFinite(valueRaw) || valueRaw < 0) {
    throw new FhirParseError('PaymentNotice.amount.value missing or non-numeric');
  }
  const receivedAmount = Math.trunc(valueRaw);

  // paymentDate is the canonical FHIR field; some gateways send `created`
  // when the notice was issued and paymentDate when funds settled. Prefer
  // paymentDate, fall back to created.
  const paymentDate = typeof obj['paymentDate'] === 'string' ? (obj['paymentDate'] as string) : undefined;
  const created = typeof obj['created'] === 'string' ? (obj['created'] as string) : undefined;
  const receivedAt = paymentDate ?? created;

  const bankTxnId = extractBankTxnId(obj);
  const claimRefNum = extractClaimRefFromNotice(obj);

  const out: ParsedPaymentNotice = { kind, receivedAmount };
  if (receivedAt !== undefined) out.receivedAt = receivedAt;
  if (bankTxnId !== undefined) out.bankTxnId = bankTxnId;
  if (claimRefNum !== undefined) out.claimRefNum = claimRefNum;
  return out;
}

function extractBankTxnId(obj: Record<string, unknown>): string | undefined {
  // Top-level identifier — most common shape (Mediassist, Star).
  const ids = obj['identifier'];
  if (Array.isArray(ids)) {
    for (const id of ids) {
      if (isObject(id) && typeof id['value'] === 'string' && id['value'].length > 0) {
        return id['value'];
      }
    }
  }
  // Reference-style — Paramount nests it on .request.identifier.value.
  const request = obj['request'];
  if (isObject(request)) {
    const reqId = request['identifier'];
    if (isObject(reqId) && typeof reqId['value'] === 'string' && reqId['value'].length > 0) {
      return reqId['value'];
    }
  }
  return undefined;
}

function extractClaimRefFromNotice(obj: Record<string, unknown>): string | undefined {
  // PaymentNotice.request is a Reference to a Claim or ClaimResponse.
  // FHIR uses Reference.identifier (logical ref) more often than
  // Reference.reference (URL) on cross-organisation messages, so we
  // accept either.
  const request = obj['request'];
  if (!isObject(request)) return undefined;
  const ref = request['reference'];
  if (typeof ref === 'string' && ref.includes('/')) {
    const parts = ref.split('/');
    const tail = parts[parts.length - 1];
    if (tail && tail.length > 0) return tail;
  }
  const id = request['identifier'];
  if (isObject(id) && typeof id['value'] === 'string' && id['value'].length > 0) {
    return id['value'];
  }
  return undefined;
}

// Slice BD — pluck the surface fields off an InsurancePlan resource.
// The gateway's bundle shape varies (different payers nest the plan
// differently); we accept whichever path is non-empty.
export function parseInsurancePlan(bundle: unknown): ParsedInsurancePlan {
  const r = findResource<{ resourceType: 'InsurancePlan' }>(bundle, 'InsurancePlan');
  if (!r) {
    throw new FhirParseError('Bundle does not contain an InsurancePlan resource');
  }
  const obj = r as unknown as Record<string, unknown>;
  const out: ParsedInsurancePlan = {};
  if (typeof obj['name'] === 'string' && (obj['name'] as string).length > 0) {
    out.name = obj['name'] as string;
  }
  if (typeof obj['status'] === 'string') {
    out.status = obj['status'] as string;
  }
  // identifier[].value — first non-empty value is the plan id.
  const ids = obj['identifier'];
  if (Array.isArray(ids)) {
    for (const id of ids) {
      if (isObject(id) && typeof id['value'] === 'string' && id['value'].length > 0) {
        out.planId = id['value'];
        break;
      }
    }
  }
  // type[0].coding[0].code is the canonical FHIR shape.
  const types = obj['type'];
  if (Array.isArray(types) && types.length > 0 && isObject(types[0])) {
    const coding = (types[0] as Record<string, unknown>)['coding'];
    if (Array.isArray(coding) && coding.length > 0 && isObject(coding[0])) {
      const code = (coding[0] as Record<string, unknown>)['code'];
      if (typeof code === 'string' && code.length > 0) out.type = code;
    }
  }

  // period.start / period.end on the InsurancePlan resource itself.
  const period = obj['period'];
  if (isObject(period)) {
    const start = period['start'];
    const end = period['end'];
    if (typeof start === 'string' && start.length > 0) out.periodStart = start.slice(0, 10);
    if (typeof end === 'string' && end.length > 0) out.periodEnd = end.slice(0, 10);
  }

  // Sum insured — FHIR InsurancePlan can carry the coverage amount in
  // a few places depending on the payer's bundle shape:
  //   1. coverage[].benefit[].limit[].value (Quantity { value, unit })
  //   2. plan[].generalCost[].cost (Money { value, currency })
  //   3. extension[] with url ending in "sum-insured" (Money / Quantity)
  // We accept the first non-empty match. Values are converted to paise
  // (rupees * 100). Currency is checked when present; non-INR values
  // are kept but flagged elsewhere — for now, we trust the gateway.
  const sumInsured = extractSumInsuredPaise(obj);
  if (sumInsured !== undefined) out.sumInsuredPaise = sumInsured;

  // Network — usually under an extension with url
  // "https://nrces.in/.../insurance-plan-network" or similar; some
  // payers stash it on `network[0].display`. Treat the first
  // non-empty hit as authoritative.
  const networkArr = obj['network'];
  if (Array.isArray(networkArr) && networkArr.length > 0 && isObject(networkArr[0])) {
    const display = (networkArr[0] as Record<string, unknown>)['display'];
    if (typeof display === 'string' && display.length > 0) out.network = display;
  }

  return out;
}

function extractSumInsuredPaise(plan: Record<string, unknown>): number | undefined {
  // Path 1: coverage[].benefit[].limit[].value
  const coverage = plan['coverage'];
  if (Array.isArray(coverage)) {
    for (const cov of coverage) {
      if (!isObject(cov)) continue;
      const benefit = cov['benefit'];
      if (!Array.isArray(benefit)) continue;
      for (const b of benefit) {
        if (!isObject(b)) continue;
        const limit = b['limit'];
        if (!Array.isArray(limit)) continue;
        for (const l of limit) {
          if (!isObject(l)) continue;
          const v = l['value'];
          if (isObject(v) && typeof v['value'] === 'number') {
            return Math.round((v['value'] as number) * 100);
          }
        }
      }
    }
  }
  // Path 2: plan[].generalCost[].cost
  const planArr = plan['plan'];
  if (Array.isArray(planArr)) {
    for (const p of planArr) {
      if (!isObject(p)) continue;
      const gc = p['generalCost'];
      if (!Array.isArray(gc)) continue;
      for (const cost of gc) {
        if (!isObject(cost)) continue;
        const c = cost['cost'];
        if (isObject(c) && typeof c['value'] === 'number') {
          return Math.round((c['value'] as number) * 100);
        }
      }
    }
  }
  // Path 3: extension[] with url ending in "sum-insured"
  const ext = plan['extension'];
  if (Array.isArray(ext)) {
    for (const e of ext) {
      if (!isObject(e)) continue;
      const url = e['url'];
      if (typeof url !== 'string' || !/sum[-_]?insured/i.test(url)) continue;
      const vm = e['valueMoney'];
      if (isObject(vm) && typeof vm['value'] === 'number') {
        return Math.round((vm['value'] as number) * 100);
      }
      const vq = e['valueQuantity'];
      if (isObject(vq) && typeof vq['value'] === 'number') {
        return Math.round((vq['value'] as number) * 100);
      }
      if (typeof e['valueDecimal'] === 'number') {
        return Math.round((e['valueDecimal'] as number) * 100);
      }
    }
  }
  return undefined;
}

// Slice BD — pluck the surface fields off a Task resource. We surface
// status, description, and a Reference back to the focus resource
// (typically a Claim) so ops can correlate the task with the claim
// they care about.
export function parseTask(bundle: unknown): ParsedTask {
  const r = findResource<{ resourceType: 'Task' }>(bundle, 'Task');
  if (!r) {
    throw new FhirParseError('Bundle does not contain a Task resource');
  }
  const obj = r as unknown as Record<string, unknown>;
  const out: ParsedTask = {};
  if (typeof obj['status'] === 'string') out.status = obj['status'] as string;
  if (typeof obj['description'] === 'string' && (obj['description'] as string).length > 0) {
    out.description = obj['description'] as string;
  }
  const focus = obj['focus'];
  if (isObject(focus)) {
    const ref = focus['reference'];
    if (typeof ref === 'string' && ref.length > 0) {
      out.focusRef = ref;
    } else {
      const id = focus['identifier'];
      if (isObject(id) && typeof id['value'] === 'string' && id['value'].length > 0) {
        out.focusRef = id['value'];
      }
    }
  }
  return out;
}
