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
});

export type Env = z.infer<typeof EnvSchema>;
