// Slice BM — pure FHIR Bundle validator. Walks an inbound (or
// outbound, but inbound is the production caller) Bundle, collects
// every unique `system` URI from `coding[]` and `identifier[]`
// entries, and classifies them against the whitelists in
// `known-code-systems.ts`. Returns a structured report the dispatcher
// can log; v1 does not reject on findings.
//
// This is deliberately pure (no DI, no state) so the dispatcher can
// call it inline and unit tests stay trivial.

import {
  KNOWN_NDHM_IDENTIFIER_TYPE_CODES,
  NDHM_IDENTIFIER_TYPE_SYSTEM,
  NHCX_SYSTEMS,
  PMJAY_SYSTEMS,
  UNIVERSAL_SYSTEMS,
} from './known-code-systems';

export type SystemBucket = 'universal' | 'nhcx' | 'pmjay' | 'unknown';

export interface BundleValidationReport {
  // Every unique `system` URI we found, classified.
  classified: Record<SystemBucket, string[]>;
  // Codes seen under the ndhm-identifier-type-code system that aren't
  // in our known list. PMJAY is in the known list, so this surfaces
  // truly unknown codes (e.g. a payer-specific extension).
  unknownIdentifierTypeCodes: string[];
  // True if the bundle uses the PMJAY `PMJAY` identifier-type code.
  // Useful for cross-checks (e.g. flag if pmjayMode is off but the
  // bundle carries a PMJAY identifier — likely a misrouted callback).
  usesPmjayIdentifierType: boolean;
}

// Recursively walk the bundle and collect every coding/identifier
// `system` value plus identifier-type codes. We deliberately walk
// the JSON tree generically rather than typing every FHIR resource
// — the bundle shape varies across resource types and the gateway
// occasionally emits non-standard fields. The walker is liberal in
// what it inspects (any object with a `system` string under a
// `coding`/`identifier` ancestor counts).
export function validateBundle(bundle: unknown): BundleValidationReport {
  const systems = new Set<string>();
  const identifierTypeCodes = new Set<string>();

  function walk(node: unknown, parentKey: string | null): void {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, parentKey);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    // `coding` and `identifier` arrays carry `system` URIs at their
    // direct entries. Direct `system` strings on those entries are
    // what FHIR uses for terminology binding.
    const sys = obj['system'];
    if (typeof sys === 'string' && sys.length > 0) {
      systems.add(sys);
    }

    // identifier.type.coding[].code under NDHM identifier-type system.
    if (parentKey === 'coding' && obj['system'] === NDHM_IDENTIFIER_TYPE_SYSTEM) {
      const code = obj['code'];
      if (typeof code === 'string' && code.length > 0) {
        identifierTypeCodes.add(code);
      }
    }

    for (const [k, v] of Object.entries(obj)) {
      // Track the nearest ancestor that names a coding/identifier
      // array so we can recognise identifier-type-code entries.
      const childParentKey = k === 'coding' || k === 'identifier' ? k : parentKey;
      walk(v, childParentKey);
    }
  }

  walk(bundle, null);

  const classified: Record<SystemBucket, string[]> = {
    universal: [],
    nhcx: [],
    pmjay: [],
    unknown: [],
  };
  for (const sys of systems) {
    if (UNIVERSAL_SYSTEMS.has(sys)) classified.universal.push(sys);
    else if (NHCX_SYSTEMS.has(sys)) classified.nhcx.push(sys);
    else if (PMJAY_SYSTEMS.has(sys)) classified.pmjay.push(sys);
    else classified.unknown.push(sys);
  }
  for (const k of Object.keys(classified) as SystemBucket[]) {
    classified[k].sort();
  }

  const unknownIdentifierTypeCodes: string[] = [];
  for (const code of identifierTypeCodes) {
    if (!KNOWN_NDHM_IDENTIFIER_TYPE_CODES.has(code)) {
      unknownIdentifierTypeCodes.push(code);
    }
  }
  unknownIdentifierTypeCodes.sort();

  return {
    classified,
    unknownIdentifierTypeCodes,
    usesPmjayIdentifierType: identifierTypeCodes.has('PMJAY'),
  };
}

// Convenience for the dispatcher: produce a one-line summary string
// for inclusion in the existing structured log lines. Empty when
// nothing surprising was found, so logs stay quiet on the happy path.
export function summariseFindings(
  report: BundleValidationReport,
  opts: { pmjayMode: 'on' | 'off' },
): string | null {
  const parts: string[] = [];
  if (report.classified.unknown.length > 0) {
    parts.push(`unknown-systems=${report.classified.unknown.join(',')}`);
  }
  if (report.unknownIdentifierTypeCodes.length > 0) {
    parts.push(
      `unknown-identifier-type-codes=${report.unknownIdentifierTypeCodes.join(',')}`,
    );
  }
  // PMJAY systems / identifier appearing on a non-PMJAY-mode tenant
  // is a likely misrouted callback (or a misconfigured tenant).
  // We surface the signal but don't reject — the rest of the
  // pipeline is shape-tolerant and operators can investigate.
  if (
    opts.pmjayMode === 'off' &&
    (report.classified.pmjay.length > 0 || report.usesPmjayIdentifierType)
  ) {
    parts.push('pmjay-systems-on-non-pmjay-tenant=true');
  }
  return parts.length === 0 ? null : parts.join(' ');
}
