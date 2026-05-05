import { z } from 'zod';

const trim = (s: unknown): unknown => (typeof s === 'string' ? s.trim() : s);

const NonEmptyString = z.preprocess(trim, z.string().min(1));
const OptionalString = z.preprocess(trim, z.string().optional());
const BooleanLike = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1';
  return v;
}, z.boolean());

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MODE: z.enum(['api', 'worker']).default('api'),
  // 0 is a valid value meaning "auto-assigned" — used by tests that call
  // app.init() without listen(). Reject negatives only.
  PORT: z.coerce.number().int().nonnegative().default(3001),

  DATABASE_URL: NonEmptyString,
  DATABASE_URL_MIGRATOR: NonEmptyString,

  JWT_PRIVATE_KEY_BASE64: NonEmptyString,
  JWT_PUBLIC_KEY_BASE64: NonEmptyString,
  JWT_ACCESS_TTL: NonEmptyString.default('15m'),
  JWT_REFRESH_TTL: NonEmptyString.default('7d'),
  JWT_ISSUER: NonEmptyString.default('claims-platform'),
  JWT_AUDIENCE: NonEmptyString.default('claims-platform-web'),

  COOKIE_DOMAIN: NonEmptyString.default('localhost'),
  COOKIE_SECURE: BooleanLike.default(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // PII encryption (Slice R).
  //   stub = static base64 root key from PII_KMS_ROOT_KEY_BASE64
  //   real = OVH KMS-wrapped DEKs (Sprint 5 hardening)
  PII_KMS_MODE: z.enum(['stub', 'real']).default('stub'),
  // 32-byte root key encoded as base64. Required when MODE=stub. Used
  // to derive a per-tenant DEK via HKDF — the DEK never leaves memory.
  PII_KMS_ROOT_KEY_BASE64: OptionalString,
  // Identifier embedded into each ciphertext blob's keyVersion field so
  // we can rotate keys without re-encrypting old rows atomically.
  PII_KMS_KEY_VERSION: NonEmptyString.default('v1'),
  // Real OVH KMS settings (deferred to Sprint 5).
  OVH_KMS_ENDPOINT: OptionalString,
  OVH_KMS_REGION: OptionalString,
  OVH_KMS_KEY_ID: OptionalString,
  OVH_KMS_ACCESS_KEY: OptionalString,
  OVH_KMS_SECRET_KEY: OptionalString,

  // Object storage adapter selection.
  //   stub = StubStorageAdapter (synthesizes references, no real upload)
  //   real = S3StorageAdapter   (presigned PUTs to OVH/AWS-compatible S3)
  STORAGE_MODE: z.enum(['stub', 'real']).default('stub'),
  // OVH S3 endpoint config (also works for any S3-compatible service:
  // MinIO, AWS S3 itself, etc.). Required when STORAGE_MODE=real.
  OVH_S3_ENDPOINT: OptionalString,
  OVH_S3_REGION: OptionalString,
  OVH_S3_BUCKET: OptionalString,
  OVH_S3_ACCESS_KEY: OptionalString,
  OVH_S3_SECRET_KEY: OptionalString,
  // Force path-style addressing (required by MinIO + many self-hosted S3
  // implementations; OVH supports both). When false, AWS virtual-hosted
  // style is used.
  S3_FORCE_PATH_STYLE: BooleanLike.default(true),
  // Presigned URL TTL for upload PUTs (seconds). 15 minutes is the default
  // — enough for slow connections, short enough that an intercepted URL
  // expires quickly.
  S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Maximum allowed upload size (bytes). 50 MiB matches the existing
  // UploadDocumentStubRequest cap.
  S3_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(52_428_800),
  // Virus-scan adapter (Slice S).
  //   off  — never scan; rows finalize directly to scanStatus='skipped'
  //   stub — synchronous in-process check (EICAR-pattern detection)
  //   real — ClamAV / cloud scanner over TCP (deferred to Sprint 5)
  // The default 'off' matches existing dev / test environments that
  // don't have a scanner running locally.
  VIRUS_SCAN_MODE: z.enum(['off', 'stub', 'real']).default('off'),
  // When real-mode arrives this is the ClamAV INSTREAM endpoint
  // (host:port). Optional in stub/off modes.
  VIRUS_SCAN_ENDPOINT: OptionalString,
  // Lifecycle worker for stale `pending` document rows. Pending uploads
  // older than this become 'failed' so the discharge / claim-submit
  // checklist no longer surfaces them as "still uploading".
  DOC_PENDING_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  DOC_LIFECYCLE_TICK_MS: z.coerce.number().int().positive().default(60_000),

  REDIS_URL: NonEmptyString.default('redis://localhost:6379'),

  CORS_ORIGIN: NonEmptyString.default('http://localhost:3000'),

  // Public base URL of the web app — used to build links inside email/SMS.
  WEB_BASE_URL: NonEmptyString.default('http://localhost:3000'),

  // SMTP for outbound email. Dev points at Mailhog (localhost:1025).
  SMTP_HOST: NonEmptyString.default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_FROM: NonEmptyString.default('no-reply@digisparsh.in'),

  // Invitation flow
  INVITE_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(168), // 7 days
  INVITE_RESEND_LIMIT_PER_DAY: z.coerce.number().int().positive().default(3),

  // Password reset flow (Slice C)
  PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  PASSWORD_RESET_RATE_LIMIT_PER_DAY: z.coerce.number().int().positive().default(5),

  // Sessions / trusted devices / concurrent cap (Slice E)
  CONCURRENT_SESSION_LIMIT: z.coerce.number().int().positive().default(5),
  TRUSTED_DEVICE_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Doctor short-token (Slice F)
  DOCTOR_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  // HPR adapter mode (Slice F stub + Slice P3 real ABDM).
  //   stub = HprStubAdapter (allowlist + fixed OTP)
  //   real = HprRealAdapter (ABDM Sandbox HTTP calls)
  HPR_MODE: z.enum(['stub', 'real']).default('stub'),
  // Stub knobs.
  HPR_STUB_ALLOWLIST: z.preprocess(trim, z.string().default('')),
  HPR_STUB_OTP: NonEmptyString.default('000000'),
  // Real-mode ABDM connection. Required when HPR_MODE=real.
  ABDM_BASE_URL: OptionalString,
  ABDM_CLIENT_ID: OptionalString,
  ABDM_CLIENT_SECRET: OptionalString,
  ABDM_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // NHCX adapter (Slice K stub + Slice P real JWE).
  //   stub = NhcxStubAdapter (env-driven outcomes, no external calls)
  //   real = NhcxJweAdapter  (FHIR Bundle → JWE → POST to gateway)
  NHCX_MODE: z.enum(['stub', 'real']).default('stub'),
  // Outcome knobs for the stub mode.
  NHCX_STUB_VERIFY_DEFAULT: BooleanLike.default(true),
  NHCX_STUB_MRN_FAIL_LIST: z.preprocess(trim, z.string().default('')),
  // Real-mode connection. Required when NHCX_MODE=real; optional in stub.
  // The participant code identifies us on the gateway. The keys are
  // PEM-encoded in base64 — same handling pattern as JWT_PRIVATE_KEY_BASE64.
  // PUBLIC keys are gateway / payer keys we encrypt outbound to; PRIVATE
  // is ours, used to decrypt inbound + sign outbound.
  NHCX_GATEWAY_URL: OptionalString,
  NHCX_PARTICIPANT_CODE: OptionalString,
  NHCX_PRIVATE_KEY_BASE64: OptionalString,
  NHCX_GATEWAY_PUBLIC_KEY_BASE64: OptionalString,
  // Active private key version. Embedded as the JWE 'kid' header on
  // outbound encryption. Defaults to "v1" so existing deployments
  // don't have to set it. Rotation = issue v2 to NHCX, set
  // NHCX_PRIVATE_KEY_BASE64_V2 + NHCX_PRIVATE_KEY_VERSION=v2 in env,
  // restart. Old NHCX-side ciphertext addressed to v1 still decrypts
  // because the resolver still has v1 in NHCX_PRIVATE_KEY_BASE64.
  NHCX_PRIVATE_KEY_VERSION: NonEmptyString.default('v1'),
  NHCX_PRIVATE_KEY_BASE64_V2: OptionalString,
  // Default request timeout for real-mode HTTP calls (ms).
  NHCX_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

export type Env = z.infer<typeof EnvSchema>;
