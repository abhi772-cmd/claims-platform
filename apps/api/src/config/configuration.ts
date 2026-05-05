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
  nhcxPrivateKeyPem: string | null;
  nhcxGatewayPublicKeyPem: string | null;
}

export function loadConfig(raw: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.flatten());
  }
  const env = parsed.data;

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
    if (missing.length > 0) {
      throw new ConfigError({ NHCX_MODE: [`real mode requires: ${missing.join(', ')}`] });
    }
  }

  return {
    ...env,
    jwtPrivateKeyPem: decodeBase64Pem(env.JWT_PRIVATE_KEY_BASE64, 'JWT_PRIVATE_KEY_BASE64'),
    jwtPublicKeyPem: decodeBase64Pem(env.JWT_PUBLIC_KEY_BASE64, 'JWT_PUBLIC_KEY_BASE64'),
    nhcxPrivateKeyPem: env.NHCX_PRIVATE_KEY_BASE64
      ? decodeBase64Pem(env.NHCX_PRIVATE_KEY_BASE64, 'NHCX_PRIVATE_KEY_BASE64')
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
