import { EnvSchema, type Env } from './env.schema';

export class ConfigError extends Error {
  constructor(public readonly issues: unknown) {
    super('Invalid environment configuration. See issues.');
    this.name = 'ConfigError';
  }
}

export interface AppConfig extends Env {
  jwtPrivateKeyPem: string;
  jwtPublicKeyPem: string;
  // NHCX real-mode keys. Decoded eagerly at config load so a misconfigured
  // PEM fails the boot rather than the first request. Null when MODE=stub.
  // The v2 slot enables rotation: while NHCX still ships ciphertext
  // addressed to v1, the v2 key is also resolvable so we don't drop
  // inbound during the cutover.
  nhcxPrivateKeyPem: string | null;
  nhcxPrivateKeyPemV2: string | null;
  nhcxGatewayPublicKeyPem: string | null;
}

export function loadConfig(raw: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.flatten());
  }
  const env = parsed.data;

  // Slice AQ — when VIRUS_SCAN_MODE='real' the clamd endpoint must be
  // configured. We surface this at boot rather than at first scan so a
  // production deploy can't silently fall back to dropping uploads.
  if (env.VIRUS_SCAN_MODE === 'real' && !env.VIRUS_SCAN_ENDPOINT) {
    throw new ConfigError({
      VIRUS_SCAN_MODE: ['real mode requires VIRUS_SCAN_ENDPOINT (host:port of clamd)'],
    });
  }

  // Slice AX — same shape: real EOB OCR needs an inference endpoint
  // or every extract returns failed. Catch the misconfig at boot.
  if (env.EOB_OCR_MODE === 'real' && !env.EOB_OCR_INFERENCE_URL) {
    throw new ConfigError({
      EOB_OCR_MODE: [
        'real mode requires EOB_OCR_INFERENCE_URL (URL of a PaddleOCR/Surya + Qwen2-VL inference service that accepts POST multipart /extract)',
      ],
    });
  }

  // Slice BF — real-mode biometric auth needs the ABDM endpoint or
  // every init / verify returns failed. Catch the misconfig at boot
  // rather than at first PMJAY case.
  if (env.BIOMETRIC_AUTH_MODE === 'real' && !env.BIOMETRIC_AUTH_BASE_URL) {
    throw new ConfigError({
      BIOMETRIC_AUTH_MODE: [
        'real mode requires BIOMETRIC_AUTH_BASE_URL (e.g. https://apisbx.abdm.gov.in for the ABDM sandbox)',
      ],
    });
  }

  // When STORAGE_MODE=real, the S3 connection settings must be present.
  if (env.STORAGE_MODE === 'real') {
    const missing: string[] = [];
    if (!env.OVH_S3_ENDPOINT) missing.push('OVH_S3_ENDPOINT');
    if (!env.OVH_S3_REGION) missing.push('OVH_S3_REGION');
    if (!env.OVH_S3_BUCKET) missing.push('OVH_S3_BUCKET');
    if (!env.OVH_S3_ACCESS_KEY) missing.push('OVH_S3_ACCESS_KEY');
    if (!env.OVH_S3_SECRET_KEY) missing.push('OVH_S3_SECRET_KEY');
    if (missing.length > 0) {
      throw new ConfigError({ STORAGE_MODE: [`real mode requires: ${missing.join(', ')}`] });
    }
  }

  // PII KMS — production must have the root key set; non-prod can boot
  // without it and fail at first PatientService use instead. This keeps
  // existing dev + integration flows that don't touch PII working
  // without forcing every test harness to mint a 32-byte key.
  if (env.NODE_ENV === 'production' && env.PII_KMS_MODE === 'stub' && !env.PII_KMS_ROOT_KEY_BASE64) {
    throw new ConfigError({
      PII_KMS_MODE: ['stub mode in production requires PII_KMS_ROOT_KEY_BASE64 (32 bytes, base64)'],
    });
  }
  if (env.PII_KMS_MODE === 'real') {
    throw new ConfigError({
      PII_KMS_MODE: ['real mode (OVH KMS) is not implemented yet — use stub'],
    });
  }

  // When HPR_MODE=real, the ABDM connection settings must be present.
  if (env.HPR_MODE === 'real') {
    const missing: string[] = [];
    if (!env.ABDM_BASE_URL) missing.push('ABDM_BASE_URL');
    if (!env.ABDM_CLIENT_ID) missing.push('ABDM_CLIENT_ID');
    if (!env.ABDM_CLIENT_SECRET) missing.push('ABDM_CLIENT_SECRET');
    if (missing.length > 0) {
      throw new ConfigError({ HPR_MODE: [`real mode requires: ${missing.join(', ')}`] });
    }
  }

  // When NHCX_MODE=real, the connection settings + keys must be present.
  // Surface the misconfiguration as a single ConfigError up front.
  if (env.NHCX_MODE === 'real') {
    const missing: string[] = [];
    if (!env.NHCX_GATEWAY_URL) missing.push('NHCX_GATEWAY_URL');
    if (!env.NHCX_PARTICIPANT_CODE) missing.push('NHCX_PARTICIPANT_CODE');
    if (!env.NHCX_PRIVATE_KEY_BASE64) missing.push('NHCX_PRIVATE_KEY_BASE64');
    if (!env.NHCX_GATEWAY_PUBLIC_KEY_BASE64) missing.push('NHCX_GATEWAY_PUBLIC_KEY_BASE64');
    // P0.1 — session-token is non-negotiable for real-mode. Without it
    // every outbound call would 401.
    if (!env.NHCX_SESSION_TOKEN_URL) missing.push('NHCX_SESSION_TOKEN_URL');
    if (!env.NHCX_CLIENT_ID) missing.push('NHCX_CLIENT_ID');
    if (!env.NHCX_CLIENT_SECRET) missing.push('NHCX_CLIENT_SECRET');
    if (missing.length > 0) {
      throw new ConfigError({ NHCX_MODE: [`real mode requires: ${missing.join(', ')}`] });
    }
  }

  // Slice AO — production must verify HTTP Signature on inbound. The
  // env-gate is permissive in dev / test (so integration tests can
  // POST without minting signatures); production cannot silently fall
  // back to the permissive default. Also requires the gateway public
  // key, which we already use for outbound JWE encryption.
  if (env.NODE_ENV === 'production') {
    if (!env.NHCX_INBOUND_VERIFY_SIGNATURE) {
      throw new ConfigError({
        NHCX_INBOUND_VERIFY_SIGNATURE: [
          'must be true in production — leaving it false would accept unsigned callbacks on the public `/nhcx/inbound` webhook',
        ],
      });
    }
    if (!env.NHCX_GATEWAY_PUBLIC_KEY_BASE64) {
      throw new ConfigError({
        NHCX_GATEWAY_PUBLIC_KEY_BASE64: [
          'required in production — needed to verify HTTP Signature on inbound callbacks',
        ],
      });
    }
  }

  return {
    ...env,
    jwtPrivateKeyPem: decodeBase64Pem(env.JWT_PRIVATE_KEY_BASE64, 'JWT_PRIVATE_KEY_BASE64'),
    jwtPublicKeyPem: decodeBase64Pem(env.JWT_PUBLIC_KEY_BASE64, 'JWT_PUBLIC_KEY_BASE64'),
    nhcxPrivateKeyPem: env.NHCX_PRIVATE_KEY_BASE64
      ? decodeBase64Pem(env.NHCX_PRIVATE_KEY_BASE64, 'NHCX_PRIVATE_KEY_BASE64')
      : null,
    nhcxPrivateKeyPemV2: env.NHCX_PRIVATE_KEY_BASE64_V2
      ? decodeBase64Pem(env.NHCX_PRIVATE_KEY_BASE64_V2, 'NHCX_PRIVATE_KEY_BASE64_V2')
      : null,
    nhcxGatewayPublicKeyPem: env.NHCX_GATEWAY_PUBLIC_KEY_BASE64
      ? decodeBase64Pem(
          env.NHCX_GATEWAY_PUBLIC_KEY_BASE64,
          'NHCX_GATEWAY_PUBLIC_KEY_BASE64',
        )
      : null,
  };
}

function decodeBase64Pem(value: string, name: string): string {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (!decoded.includes('-----BEGIN') || !decoded.includes('-----END')) {
      throw new Error('Decoded value does not look like a PEM block.');
    }
    return decoded;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError({ [name]: [`Could not decode base64 PEM: ${message}`] });
  }
}
