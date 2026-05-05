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

  OVH_KMS_ENDPOINT: OptionalString,
  OVH_KMS_REGION: OptionalString,
  OVH_KMS_KEY_ID: OptionalString,
  OVH_KMS_ACCESS_KEY: OptionalString,
  OVH_KMS_SECRET_KEY: OptionalString,

  OVH_S3_ENDPOINT: OptionalString,
  OVH_S3_REGION: OptionalString,
  OVH_S3_BUCKET: OptionalString,
  OVH_S3_ACCESS_KEY: OptionalString,
  OVH_S3_SECRET_KEY: OptionalString,

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
  // Comma-separated HPR ids the stub treats as valid. The real HPR
  // verification calls ABDM in a later sprint. The stub also requires
  // HPR_STUB_OTP to match exactly (any 6-digit string by default).
  HPR_STUB_ALLOWLIST: z.preprocess(trim, z.string().default('')),
  HPR_STUB_OTP: NonEmptyString.default('000000'),

  // NHCX stub adapter (Slice K). Replaced by the real adapter in Slice P.
  NHCX_STUB_VERIFY_DEFAULT: BooleanLike.default(true),
  NHCX_STUB_MRN_FAIL_LIST: z.preprocess(trim, z.string().default('')),
});

export type Env = z.infer<typeof EnvSchema>;
