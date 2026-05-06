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
