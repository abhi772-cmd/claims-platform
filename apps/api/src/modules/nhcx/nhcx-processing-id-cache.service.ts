import { Injectable, Logger } from '@nestjs/common';

/**
 * P0.6 — processingID indirection cache for PMJAY get/policies.
 *
 * NHCX returns a pseudonymized `processingId` from the first
 * `participant/get/policies` lookup. Per NHCX PMJAY Integration
 * Handbook §5.6, every subsequent eligibility/preauth/claim call
 * for the same beneficiary MUST cite this `processingId` rather
 * than the raw ABHA / Aadhaar / mobile number. Two reasons:
 *   1. PII protection — the gateway audit trail records the
 *      processingId in cleartext logs; the underlying ABHA stays
 *      in our DB only.
 *   2. Cross-payer correlation — PMJAY's actuarial pipeline
 *      uses the processingId as the join key when reconciling
 *      claims that crossed multiple payer instances.
 *
 * The cache is scoped per tenant + identifier so two tenants
 * looking up the same ABHA don't share processing IDs (each
 * gateway lookup gets its own pseudonym).
 *
 * Storage is in-process for V1 — a single API replica is the
 * norm and the cache only protects against duplicate get/policies
 * calls in the same admission window. Sprint 6 backlog: move to
 * Redis so a multi-replica deploy doesn't replay get/policies
 * once per replica.
 */

export type ProcessingIdIdentifierType = 'abha' | 'mobile' | 'aadhaar';

interface CachedEntry {
  processingId: string;
  // Absolute expiry in epoch ms. NHCX processingIds are valid for
  // 24 hours per the integration handbook — we expire ours at
  // the same point so a stale ID doesn't survive into a new
  // admission window.
  expiresAt: number;
}

// 24 hours per NHCX PMJAY handbook §5.6.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class NhcxProcessingIdCacheService {
  private readonly log = new Logger(NhcxProcessingIdCacheService.name);

  // Key shape: `${tenantId}:${identifierType}:${identifier}`. The
  // identifier itself is the raw value the operator typed in — the
  // cache is in-process and never written to disk, so this is the
  // one place we keep the cleartext.
  private readonly entries = new Map<string, CachedEntry>();

  private key(
    tenantId: string,
    identifierType: ProcessingIdIdentifierType,
    identifier: string,
  ): string {
    return `${tenantId}:${identifierType}:${identifier}`;
  }

  /**
   * Returns the cached processingId for this identifier or null
   * when missing / expired. Callers issue a fresh get/policies
   * call on null and pass the result into {@link remember}.
   */
  lookup(
    tenantId: string,
    identifierType: ProcessingIdIdentifierType,
    identifier: string,
  ): string | null {
    const entry = this.entries.get(this.key(tenantId, identifierType, identifier));
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(this.key(tenantId, identifierType, identifier));
      return null;
    }
    return entry.processingId;
  }

  /**
   * Stores a freshly-issued processingId. Idempotent for the same
   * tenant+identifier — re-issuing the cache call within the TTL
   * just slides the expiry forward without changing the ID.
   */
  remember(
    tenantId: string,
    identifierType: ProcessingIdIdentifierType,
    identifier: string,
    processingId: string,
    ttlMs: number = DEFAULT_TTL_MS,
  ): void {
    const expiresAt = Date.now() + ttlMs;
    this.entries.set(this.key(tenantId, identifierType, identifier), {
      processingId,
      expiresAt,
    });
    this.log.log(
      `nhcx processingId cached tenant=${tenantId} type=${identifierType} ttl=${Math.round(ttlMs / 1000)}s`,
    );
  }

  /**
   * Explicit invalidation — used by the cancel / CRC paths where
   * the operator deliberately wants to re-issue the cache call
   * (e.g. PMJAY rotated the processing ID after a payer policy
   * change). Returns true when an entry was actually removed.
   */
  invalidate(
    tenantId: string,
    identifierType: ProcessingIdIdentifierType,
    identifier: string,
  ): boolean {
    return this.entries.delete(this.key(tenantId, identifierType, identifier));
  }

  /**
   * Test-only hook. Production callers must NOT clear the entire
   * cache — it would force the gateway into a thundering-herd
   * re-lookup for every active admission.
   */
  _resetForTests(): void {
    this.entries.clear();
  }
}
