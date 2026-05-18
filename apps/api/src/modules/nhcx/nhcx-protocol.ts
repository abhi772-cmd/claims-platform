// NHCX HCX Protocol 0.7.1 — wire-envelope helpers.
//
// Every outbound protocol call must carry a 10-field protected header
// stamped into the JWE protected header (so the AEAD tag covers them),
// AND duplicated as `x-hcx-*` HTTP headers (so the gateway can route
// before decrypting). This module is the single source of truth for
// both surfaces.

import { randomUUID } from 'node:crypto';

// Underscore-style field names per HCX Protocol 0.7.1 §6.2. The same
// names are echoed inbound for ACKs/results.
export const HEADER_SENDER_CODE = 'x-hcx-sender_code';
export const HEADER_RECIPIENT_CODE = 'x-hcx-recipient_code';
export const HEADER_CORRELATION_ID = 'x-hcx-correlation_id';
export const HEADER_API_CALL_ID = 'x-hcx-api_call_id';
export const HEADER_TIMESTAMP = 'x-hcx-timestamp';
export const HEADER_WORKFLOW_ID = 'x-hcx-workflow_id';
export const HEADER_ENTITY_TYPE = 'x-hcx-entity_type';
export const HEADER_STATUS = 'x-hcx-status';
export const HEADER_DEBUG_FLAG = 'x-hcx-debug_flag';
export const HEADER_REDIRECT_TO = 'x-hcx-redirect_to';
export const HEADER_ERROR_DETAILS = 'x-hcx-error_details';

// Internal operation slug → workflow id mapping per HCX 0.7.1 §7.1.
// The slugs are what the adapter passes to `callOperation`; the IDs
// are what the gateway expects in `x-hcx-workflow_id`.
//
// 12  coverage-eligibility/check (validation + benefits)
// 121 coverage-eligibility/check (discovery purpose — PMJAY)
// 13  preauth/submit
// 14  preauth/query/respond  (back-and-forth on a preauth case)
// 141 communication/request   (free-form hospital → payer)
// 15  claim/submit
// 151 claim/reprocess          (PMJAY CRC)
// 16  discharge/submit
// 18  task/submit (cancel + reprocess umbrella)
// 19  payment-notice/notify    (incoming PMJAY payment notice)
// 20  payment-reconciliation   (incoming UTR/settlement)
// 21  insurance-plan/search    (PMJAY package master)
// 22  insurance-plan/on_search
// 23  participant/get/policies (PMJAY wallet)
// 30  paymentack
// 31  STG-questionnaire/respond
// 32  preauth/enhance
const WORKFLOW_ID_BY_OPERATION: Readonly<Record<string, string>> = {
  'coverage-eligibility/check': '12',
  'coverage-eligibility/check/discovery': '121',
  'preauth/submit': '13',
  'preauth/query/respond': '14',
  'preauth/enhance': '32',
  'communication/request': '141',
  'claim/submit': '15',
  'claim/reprocess': '151',
  'discharge/submit': '16',
  'task/submit': '18',
  'payment-notice/notify': '19',
  'payment-reconciliation': '20',
  'insurance-plan/search': '21',
  'insurance-plan/on_search': '22',
  'participant/get/policies': '23',
  paymentack: '30',
  'stg-questionnaire/respond': '31',
};

// Workflow IDs 20–33 the gap report calls out are emitted on the
// matching operation slug above. Anything not in the map falls back
// to '0' which makes a misconfig visible in gateway logs.
export function workflowIdFor(operation: string): string {
  return WORKFLOW_ID_BY_OPERATION[operation] ?? '0';
}

// HCX 0.7.1 §6.3 — the status field a hospital stamps on outbound
// initiates is 'request.queued'. On response we stamp 'response.complete'
// or 'response.error' for ACKs we relay back; the gateway itself rewrites
// the field on its way through to the payer.
export const STATUS_REQUEST_QUEUED = 'request.queued';
export const STATUS_RESPONSE_COMPLETE = 'response.complete';
export const STATUS_RESPONSE_ERROR = 'response.error';
export const STATUS_RESPONSE_PARTIAL = 'response.partial';
export const STATUS_RESPONSE_FAIL = 'response.fail';

// Per HCX Protocol §6.4, payload timestamps are IST (Asia/Kolkata)
// epoch-seconds. The protected header uses ms-resolution unix epoch.
// IST is exactly UTC+5:30 with no DST so we don't pull in a tz library
// — we just stamp UTC ms and let payers interpret the offset.
export function nhcxTimestampMs(now: Date = new Date()): number {
  return now.getTime();
}

// IST naive ISO ("YYYY-MM-DDTHH:mm:ss+05:30") for FHIR resource
// `Bundle.timestamp`, `Claim.created`, `Communication.sent`, etc.
// NHCX rejects bare UTC ISO timestamps — they must carry the +05:30
// offset to be unambiguous.
export function nhcxIstIso(now: Date = new Date()): string {
  const offsetMin = 5 * 60 + 30;
  const local = new Date(now.getTime() + offsetMin * 60_000);
  const yyyy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(local.getUTCDate()).padStart(2, '0');
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mi = String(local.getUTCMinutes()).padStart(2, '0');
  const ss = String(local.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+05:30`;
}

export interface BuildProtocolHeaderInput {
  senderCode: string;
  recipientCode: string;
  correlationId: string;
  apiCallId?: string;
  operation: string;
  // Defaults to 'Bundle' — the entity type for every FHIR-wrapped
  // protocol call. Settlement / ACK paths can override.
  entityType?: string;
  // Defaults to 'request.queued'. Inbound ACK paths override.
  status?: string;
  // 'Error' | 'Info' | 'Off' — the default 'Off' leaves the field out.
  debugFlag?: 'Error' | 'Info' | 'Off';
  // Optional — used by the redirect/handoff flows. Empty → omitted.
  redirectTo?: string;
}

// Builds the 10-field NHCX protected header. Returns plain string-keyed
// records so callers can spread directly into both the JOSE protected
// header and the HTTP header object — same field names, same values.
export function buildNhcxProtocolHeader(
  input: BuildProtocolHeaderInput,
): Readonly<Record<string, string>> {
  const apiCallId = input.apiCallId ?? randomUUID();
  const header: Record<string, string> = {
    [HEADER_SENDER_CODE]: input.senderCode,
    [HEADER_RECIPIENT_CODE]: input.recipientCode,
    [HEADER_CORRELATION_ID]: input.correlationId,
    [HEADER_API_CALL_ID]: apiCallId,
    [HEADER_TIMESTAMP]: String(nhcxTimestampMs()),
    [HEADER_WORKFLOW_ID]: workflowIdFor(input.operation),
    [HEADER_ENTITY_TYPE]: input.entityType ?? 'Bundle',
    [HEADER_STATUS]: input.status ?? STATUS_REQUEST_QUEUED,
  };
  if (input.debugFlag !== undefined && input.debugFlag !== 'Off') {
    header[HEADER_DEBUG_FLAG] = input.debugFlag;
  }
  if (input.redirectTo) {
    header[HEADER_REDIRECT_TO] = input.redirectTo;
  }
  return header;
}

// HCX 0.7.1 §6.5 — outbound POST body is a JSON envelope wrapping the
// compact JWE in a single field. Gateways reject `application/jose`
// raw bodies; the body must be `application/json` with this shape.
export interface JwePayloadEnvelope {
  payload: string;
}

export function buildJwePayloadEnvelope(compactJwe: string): JwePayloadEnvelope {
  return { payload: compactJwe };
}

// Counterpart to JwePayloadEnvelope on the response side. Gateways
// return either:
//   { payload: <compact-jwe> }                     — success / queued
//   { error: { code: "...", message: "..." } }     — sync rejection
// The adapter calls {@link parseProtocolResponse} to discriminate
// before attempting JWE decrypt.
export interface ProtocolErrorEnvelope {
  error: {
    code: string;
    message: string;
    [extra: string]: unknown;
  };
}

export type ProtocolResponseShape = JwePayloadEnvelope | ProtocolErrorEnvelope;

export function isProtocolError(
  body: unknown,
): body is ProtocolErrorEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'object' &&
    (body as { error: { code?: unknown } }).error !== null &&
    typeof (body as { error: { code?: unknown } }).error.code === 'string'
  );
}

export function isProtocolPayload(body: unknown): body is JwePayloadEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    'payload' in body &&
    typeof (body as { payload: unknown }).payload === 'string'
  );
}
