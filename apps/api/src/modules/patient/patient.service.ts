import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { decryptString, deriveTenantKey, encryptString, lookupHash } from './pii.crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';
import { type TenantPrisma } from '../../types/express';

export interface PatientPiiInput {
  fullName: string;
  dateOfBirth?: string; // YYYY-MM-DD
  gender?: 'male' | 'female' | 'other' | 'prefer_not_to_say';
  aadhaar?: string;
  abhaId?: string;
  policyNumber?: string;
  mobile?: string;
  email?: string;
}

export interface DecryptedPatient {
  id: string;
  fullName: string;
  dateOfBirth: string | null;
  gender: string | null;
  aadhaar: string | null;
  abhaId: string | null;
  policyNumber: string | null;
  mobile: string | null;
  email: string | null;
}

@Injectable()
export class PatientService {
  private readonly tenantKeyCache = new Map<string, Buffer>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // Per-tenant DEK is derived once and cached for the lifetime of the
  // process (small map, ~32 bytes per tenant). When real OVH KMS lands
  // the cache becomes a TTL'd LRU keyed on (tenantId, keyVersion).
  private tenantKey(tenantId: string): Buffer {
    const cached = this.tenantKeyCache.get(tenantId);
    if (cached) return cached;
    const rootKeyB64 = this.config.get('PII_KMS_ROOT_KEY_BASE64', { infer: true });
    if (!rootKeyB64) {
      throw new Error(
        'PII_KMS_ROOT_KEY_BASE64 missing — config loader should have rejected.',
      );
    }
    const rootKey = Buffer.from(rootKeyB64, 'base64');
    const key = deriveTenantKey(rootKey, tenantId);
    this.tenantKeyCache.set(tenantId, key);
    return key;
  }

  // Build the Prisma create payload for a Patient row from a PII input.
  // Caller is responsible for the surrounding tenant-context tx; this
  // helper is pure (no DB access) so it can be inlined into a wider tx.
  buildCreatePayload(
    tenantId: string,
    input: PatientPiiInput,
  ): {
    tenantId: string;
    fullName: string;
    dateOfBirth: Date | null;
    gender: string | null;
    aadhaarCipher: string | null;
    aadhaarKeyVersion: string | null;
    abhaIdCipher: string | null;
    abhaIdKeyVersion: string | null;
    policyNumberCipher: string | null;
    policyNumberKeyVersion: string | null;
    mobileCipher: string | null;
    mobileKeyVersion: string | null;
    emailCipher: string | null;
    emailKeyVersion: string | null;
    aadhaarHash: string | null;
    mobileHash: string | null;
  } {
    const key = this.tenantKey(tenantId);
    const version = this.config.get('PII_KMS_KEY_VERSION', { infer: true });

    const enc = (v?: string): { cipher: string | null; version: string | null } => {
      if (!v) return { cipher: null, version: null };
      const out = encryptString(v, key, version);
      return { cipher: out.cipher, version: out.keyVersion };
    };

    const aadhaar = enc(input.aadhaar);
    const abhaId = enc(input.abhaId);
    const policyNumber = enc(input.policyNumber);
    const mobile = enc(input.mobile);
    const email = enc(input.email);

    return {
      tenantId,
      fullName: input.fullName,
      dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
      gender: input.gender ?? null,
      aadhaarCipher: aadhaar.cipher,
      aadhaarKeyVersion: aadhaar.version,
      abhaIdCipher: abhaId.cipher,
      abhaIdKeyVersion: abhaId.version,
      policyNumberCipher: policyNumber.cipher,
      policyNumberKeyVersion: policyNumber.version,
      mobileCipher: mobile.cipher,
      mobileKeyVersion: mobile.version,
      emailCipher: email.cipher,
      emailKeyVersion: email.version,
      aadhaarHash: input.aadhaar ? lookupHash(input.aadhaar) : null,
      mobileHash: input.mobile ? lookupHash(input.mobile) : null,
    };
  }

  // Variant of buildCreatePayload that runs inside an existing
  // tenant-context tx — used by CaseService.create.
  async createWithTx(
    tx: TenantPrisma,
    tenantId: string,
    input: PatientPiiInput,
  ): Promise<{ id: string }> {
    const data = this.buildCreatePayload(tenantId, input);
    const row = await tx.patient.create({ data });
    return { id: row.id };
  }

  async getDecrypted(tenantId: string, patientId: string): Promise<DecryptedPatient | null> {
    const row = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.patient.findUnique({ where: { id: patientId } }),
    );
    if (!row || row.tenantId !== tenantId) return null;
    const key = this.tenantKey(tenantId);

    const dec = (cipher: string | null): string | null =>
      cipher ? decryptString(cipher, key) : null;

    return {
      id: row.id,
      fullName: row.fullName,
      dateOfBirth: row.dateOfBirth ? row.dateOfBirth.toISOString().slice(0, 10) : null,
      gender: row.gender,
      aadhaar: dec(row.aadhaarCipher),
      abhaId: dec(row.abhaIdCipher),
      policyNumber: dec(row.policyNumberCipher),
      mobile: dec(row.mobileCipher),
      email: dec(row.emailCipher),
    };
  }

  // Find a patient by exact-match on Aadhaar or mobile within a tenant.
  // Returns the patient id only — callers decrypt fields they need
  // explicitly so we don't accidentally surface PII through list paths.
  async findByLookup(
    tenantId: string,
    by: { aadhaar?: string; mobile?: string },
  ): Promise<{ id: string } | null> {
    if (!by.aadhaar && !by.mobile) return null;
    const aadhaarHash = by.aadhaar ? lookupHash(by.aadhaar) : undefined;
    const mobileHash = by.mobile ? lookupHash(by.mobile) : undefined;
    const row = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.patient.findFirst({
        where: {
          tenantId,
          ...(aadhaarHash !== undefined ? { aadhaarHash } : {}),
          ...(mobileHash !== undefined ? { mobileHash } : {}),
        },
        select: { id: true },
      }),
    );
    return row ?? null;
  }
}
