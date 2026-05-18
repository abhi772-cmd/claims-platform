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
  // P2.16 — typed benefits when the payer returns Coverage.benefit[]
  // entries with the documented type codes. Populated only when the
  // gateway surfaced them (PMJAY policy callbacks always include
  // these for the discovery / benefits purpose; private rails omit
  // them on the validation purpose).
  benefits?: ParsedBenefits;
  // P2.16 — wallet usedMoney / remaining balance for PMJAY. Reported
  // in rupees because the inbound CoverageEligibilityResponse is
  // already rupee-denominated; downstream code converts at the
  // service boundary.
  walletRemainingRupees?: number;
  walletUsedRupees?: number;
  // P2.16 — Coverage.class[] entries (PMJAY surfaces hospital tier
  // and beneficiary group here). Each entry is a {type, value}
  // pair the operator UI surfaces verbatim — we don't parse
  // semantics, we relay.
  coverageClasses?: Array<{ type: string; value: string }>;
  // P2.16 — MAND-* mandatory document checklist the payer returned.
  // Each entry is a documented short code; the UI maps each to a
  // human label via reference/pmjay-mand-docs.ts. We don't enforce
  // the checklist here — the operator workflow does, on the
  // claim-submit page.
  mandatoryDocs?: string[];
}

// P2.16 — typed benefits from a private-rail eligibility callback.
// All amounts in rupees (gateway native unit). The InsurancePlan
// service converts to paise at the storage boundary.
export interface ParsedBenefits {
  deductibleRupees?: number;
  // PMJAY rail is mandated to be 0; private rails may carry any
  // non-negative integer 0–100. The parser DOES enforce the PMJAY
  // invariant via clamping (P2.21).
  coPayPercent?: number;
  coPayRupees?: number;
  roomRentLimitRupees?: number;
}

export interface ParsedPreauthDecision {
  kind: 'approved' | 'rejected' | 'partially_approved' | 'query_received';
  approvedAmount?: number;
  reason?: string;
  queryText?: string;
  // P2.17 — Optional structured audit trail extracted from the
  // pipe-delimited payer extension. Empty array when the payer
  // didn't include one.
  auditTrail?: ParsedAuditTrailEntry[];
}

export type ParsedClaimDecision = ParsedPreauthDecision;

// P2.17 — PMJAY pipe-delimited audit trail. Surfaced from a
// ClaimResponse.extension entry, each entry parsed into a structured
// row so the operator audit trail tab can render it without
// pipe-string parsing in the UI layer.
export interface ParsedAuditTrailEntry {
  // 'submitted' | 'reviewed' | 'queried' | 'partial' | 'approved' | 'rejected' | ...
  event: string;
  // IST date string (gateway-native format YYYY-MM-DD HH:mm:ss).
  occurredAt: string;
  // Free-form actor handle from the payer side.
  actor: string;
}

export interface ParsedCommunication {
  // 'query' = inbound query from payer (creates a PreauthQuery row).
  // 'response' = inbound response to a query we sent (recorded but
  // doesn't drive a state transition — the state transition happened
  // when we sent the original query response outbound).
  kind: 'query' | 'response';
  text: string;
}

// Slice BD — gateway-pushed coverage update. Operators see this in
// the integration_message ledger; we don't yet auto-trigger an
// eligibility re-verification (no operational pressure), so the
// parser surfaces just the identifying fields ops need to
// triage / cross-reference.
export interface ParsedInsurancePlan {
  // The plan's stable identifier, when the gateway provides one.
  planId?: string;
  // Human-readable display, e.g. "Star Health Gold 2026".
  name?: string;
  // 'active' | 'retired' | 'draft' — pass-through from the resource.
  status?: string;
  // Type code (e.g. 'medical' / 'dental') if the gateway tags it.
  type?: string;
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
    // P2.16 — extract typed benefits + wallet + Coverage.class + MAND docs.
    // Whether to clamp coPayPercent to 0 depends on the rail; the
    // parser detects PMJAY from the Coverage.type coding or from the
    // CoverageEligibilityResponse.contained[] coverage reference.
    const isPmjay = detectPmjayRail(bundle, r);
    const benefits = extractBenefits(r, isPmjay);
    const wallet = extractWalletAmounts(r);
    const coverageClasses = extractCoverageClasses(bundle);
    const mandatoryDocs = extractMandatoryDocs(r);
    return {
      verified: true,
      ...(planName !== undefined ? { planName } : {}),
      ...(sumInsured !== undefined ? { sumInsured } : {}),
      ...(benefits !== undefined ? { benefits } : {}),
      ...(wallet.remaining !== undefined ? { walletRemainingRupees: wallet.remaining } : {}),
      ...(wallet.used !== undefined ? { walletUsedRupees: wallet.used } : {}),
      ...(coverageClasses.length > 0 ? { coverageClasses } : {}),
      ...(mandatoryDocs.length > 0 ? { mandatoryDocs } : {}),
    };
  }
  // 'error' or anything else — treat as failed; surface disposition
  // so ops can read the reason without scrubbing the raw bundle.
  const disposition = typeof r['disposition'] === 'string' ? r['disposition'] : 'unknown';
  return { verified: false, failureReason: disposition };
}

// P2.16 — PMJAY rail detection. We check the bundle's Coverage
// resource for type.coding == 'PMJAY' OR the EligibilityResponse's
// insurance[].coverage.identifier.system contains 'pmjay'. Either
// signal alone is sufficient; both are kept for robustness across
// the gateway's varying response shapes.
function detectPmjayRail(bundle: unknown, eligibilityResponse: Record<string, unknown>): boolean {
  const coverage = findResource<{ resourceType: 'Coverage' }>(bundle, 'Coverage') as Record<string, unknown> | null;
  if (coverage) {
    const type = coverage['type'];
    if (isObject(type)) {
      const coding = type['coding'];
      if (Array.isArray(coding)) {
        for (const c of coding) {
          if (isObject(c) && typeof c['code'] === 'string' && c['code'].toUpperCase() === 'PMJAY') {
            return true;
          }
        }
      }
    }
  }
  const insurance = eligibilityResponse['insurance'];
  if (Array.isArray(insurance) && insurance.length > 0 && isObject(insurance[0])) {
    const cov = (insurance[0] as Record<string, unknown>)['coverage'];
    if (isObject(cov)) {
      const ident = cov['identifier'];
      if (isObject(ident) && typeof ident['system'] === 'string') {
        if (ident['system'].toLowerCase().includes('pmjay')) return true;
      }
    }
  }
  return false;
}

// P2.16 + P2.21 — extract Coverage.benefit[] typed amounts.
// P2.21 enforces the PMJAY invariant: every PMJAY beneficiary
// is by-policy zero-copay; we clamp coPayPercent to 0 when the
// rail is PMJAY, regardless of what the payer returned. This
// protects against payer-side data-entry bugs that would
// silently bill PMJAY beneficiaries.
function extractBenefits(
  r: Record<string, unknown>,
  isPmjay: boolean,
): ParsedBenefits | undefined {
  const insurance = r['insurance'];
  if (!Array.isArray(insurance) || insurance.length === 0) return undefined;
  const result: ParsedBenefits = {};
  for (const ins of insurance) {
    if (!isObject(ins)) continue;
    const items = ins['item'];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!isObject(item)) continue;
      const benefits = item['benefit'];
      if (!Array.isArray(benefits)) continue;
      for (const b of benefits) {
        if (!isObject(b)) continue;
        const code = benefitTypeCode(b);
        if (code === undefined) continue;
        if (/deduct/i.test(code)) {
          const v = readAllowedMoney(b);
          if (v !== undefined) result.deductibleRupees = v;
        } else if (/co[- ]?pay/i.test(code)) {
          const pct = readAllowedPercent(b);
          if (pct !== undefined) result.coPayPercent = pct;
          const rs = readAllowedMoney(b);
          if (rs !== undefined) result.coPayRupees = rs;
        } else if (/room/i.test(code)) {
          const v = readAllowedMoney(b);
          if (v !== undefined) result.roomRentLimitRupees = v;
        }
      }
    }
  }
  if (Object.keys(result).length === 0) return undefined;
  // P2.21 — PMJAY zero-copay invariant.
  if (isPmjay) {
    if (result.coPayPercent !== undefined && result.coPayPercent !== 0) {
      result.coPayPercent = 0;
    }
    if (result.coPayRupees !== undefined && result.coPayRupees !== 0) {
      result.coPayRupees = 0;
    }
  }
  return result;
}

function benefitTypeCode(b: Record<string, unknown>): string | undefined {
  const type = b['type'];
  if (!isObject(type)) return undefined;
  const coding = type['coding'];
  if (!Array.isArray(coding)) return undefined;
  for (const c of coding) {
    if (isObject(c) && typeof c['code'] === 'string') return c['code'];
  }
  return undefined;
}

function readAllowedMoney(b: Record<string, unknown>): number | undefined {
  const am = b['allowedMoney'];
  if (isObject(am)) {
    const v = am['value'];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  }
  return undefined;
}

function readAllowedPercent(b: Record<string, unknown>): number | undefined {
  // Some payers stamp the percent into allowedUnsignedInt, others
  // into allowedString as "20%". Accept both shapes.
  const ui = b['allowedUnsignedInt'];
  if (typeof ui === 'number' && Number.isFinite(ui) && ui >= 0 && ui <= 100) return ui;
  const s = b['allowedString'];
  if (typeof s === 'string') {
    const m = s.match(/^(\d{1,3})\s*%?$/);
    if (m) {
      const pct = Number(m[1]);
      if (pct >= 0 && pct <= 100) return pct;
    }
  }
  return undefined;
}

// P2.16 — wallet usedMoney / remaining for PMJAY. The gateway
// returns these under insurance[0].balance[] with category coding
// 'used' / 'remaining'. Returns rupees.
function extractWalletAmounts(r: Record<string, unknown>): {
  remaining?: number;
  used?: number;
} {
  const insurance = r['insurance'];
  if (!Array.isArray(insurance) || insurance.length === 0) return {};
  const first = insurance[0];
  if (!isObject(first)) return {};
  const balance = first['balance'];
  if (!Array.isArray(balance)) return {};
  const out: { remaining?: number; used?: number } = {};
  for (const b of balance) {
    if (!isObject(b)) continue;
    const term = (b['term'] as Record<string, unknown> | undefined)?.['coding'];
    let code: string | undefined;
    if (Array.isArray(term)) {
      for (const c of term) {
        if (isObject(c) && typeof c['code'] === 'string') {
          code = c['code'];
          break;
        }
      }
    }
    const valueMoney = b['valueMoney'];
    const value = isObject(valueMoney) ? valueMoney['value'] : undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (code === 'remaining' || code === 'available') out.remaining = Math.round(value);
    if (code === 'used' || code === 'consumed') out.used = Math.round(value);
  }
  return out;
}

// P2.16 — Coverage.class[] entries. PMJAY beneficiaries get a tier
// + group entry (e.g. SECC vs RSBY); the operator UI shows these
// verbatim.
function extractCoverageClasses(bundle: unknown): Array<{ type: string; value: string }> {
  const cov = findResource<{ resourceType: 'Coverage' }>(bundle, 'Coverage') as Record<string, unknown> | null;
  if (!cov) return [];
  const classes = cov['class'];
  if (!Array.isArray(classes)) return [];
  const out: Array<{ type: string; value: string }> = [];
  for (const c of classes) {
    if (!isObject(c)) continue;
    const type = c['type'];
    const value = c['value'];
    if (!isObject(type) || typeof value !== 'string') continue;
    const coding = type['coding'];
    if (!Array.isArray(coding)) continue;
    for (const inner of coding) {
      if (isObject(inner) && typeof inner['code'] === 'string') {
        out.push({ type: inner['code'], value });
        break;
      }
    }
  }
  return out;
}

// P2.16 — MAND-* mandatory documents the payer's adjudication
// pipeline requires. Returned as a flat list of short codes.
function extractMandatoryDocs(r: Record<string, unknown>): string[] {
  const ext = r['extension'];
  if (!Array.isArray(ext)) return [];
  const out: string[] = [];
  for (const e of ext) {
    if (!isObject(e)) continue;
    if (e['url'] !== 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/PmjayMandatoryDocs') {
      continue;
    }
    const code = e['valueString'];
    if (typeof code === 'string' && code.startsWith('MAND-')) out.push(code);
  }
  return out;
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
  // P2.17 — payer-side reason coding. PMJAY ships 'queried' as a
  // separate `reasonCode` extension when they want us to respond
  // mid-flow without flipping the outcome. We detect it explicitly
  // so the 'partial' branch below doesn't get false-positives.
  const reasonCode = extractReasonCode(r);
  const auditTrail = extractAuditTrail(r);
  const auditTrailField = auditTrail.length > 0 ? { auditTrail } : {};

  if (outcome === 'queued') {
    // Some payers return queued + a question in disposition rather
    // than emitting a separate Communication. Surface as a query
    // with disposition as the query text.
    return {
      kind: 'query_received',
      queryText: typeof r['disposition'] === 'string' ? r['disposition'] : 'Payer query',
      ...auditTrailField,
    };
  }

  // P2.17 — PMJAY's `outcome='partial'` with `reasonCode='queried'`
  // is functionally the same as `outcome='queued'`: the payer wants
  // a response before they finalize. Route to query_received so the
  // claim flips into CLAIM_QUERY_RAISED rather than the partial
  // approval branch below.
  if (outcome === 'partial' && reasonCode === 'queried') {
    return {
      kind: 'query_received',
      queryText: typeof r['disposition'] === 'string' ? r['disposition'] : 'Payer query',
      ...auditTrailField,
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
        ...auditTrailField,
      };
    }
    return {
      kind: 'approved',
      ...(approvedAmount !== undefined ? { approvedAmount } : {}),
      ...(typeof r['disposition'] === 'string' ? { reason: r['disposition'] } : {}),
      ...auditTrailField,
    };
  }

  if (disposition.includes('approved')) {
    return {
      kind: 'approved',
      ...(approvedAmount !== undefined ? { approvedAmount } : {}),
      ...(typeof r['disposition'] === 'string' ? { reason: r['disposition'] } : {}),
      ...auditTrailField,
    };
  }

  return {
    kind: 'rejected',
    ...(typeof r['disposition'] === 'string' ? { reason: r['disposition'] } : {}),
    ...auditTrailField,
  };
}

// P2.17 — payer-side reason coding extracted from a documented
// FHIR extension. Returns lowercase string for case-insensitive
// matching. Returns undefined when the extension is absent.
function extractReasonCode(r: Record<string, unknown>): string | undefined {
  const ext = r['extension'];
  if (!Array.isArray(ext)) return undefined;
  for (const e of ext) {
    if (!isObject(e)) continue;
    if (
      e['url'] === 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimResponseReasonCode' ||
      e['url'] === 'https://hcx.pmjay.nha.gov.in/StructureDefinition/reasonCode'
    ) {
      const v = e['valueString'] ?? e['valueCode'];
      if (typeof v === 'string') return v.toLowerCase();
    }
  }
  return undefined;
}

// P2.17 — PMJAY pipe-delimited audit-trail parser. The payer puts
// the case's processing history in a single string extension shaped
// as `event|YYYY-MM-DD HH:mm:ss|actor` rows separated by newlines.
// Returns an empty array when the extension is absent or the rows
// don't match the documented shape.
function extractAuditTrail(r: Record<string, unknown>): ParsedAuditTrailEntry[] {
  const ext = r['extension'];
  if (!Array.isArray(ext)) return [];
  let raw: string | undefined;
  for (const e of ext) {
    if (!isObject(e)) continue;
    if (
      e['url'] === 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimResponseAuditTrail' ||
      e['url'] === 'https://hcx.pmjay.nha.gov.in/StructureDefinition/auditTrail'
    ) {
      const v = e['valueString'];
      if (typeof v === 'string') {
        raw = v;
        break;
      }
    }
  }
  if (!raw) return [];
  const out: ParsedAuditTrailEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 3) continue;
    const [event, occurredAt, actor] = parts;
    if (!event || !occurredAt || !actor) continue;
    out.push({ event, occurredAt, actor });
  }
  return out;
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
  return out;
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
