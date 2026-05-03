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
}

export function loadConfig(raw: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.flatten());
  }
  const env = parsed.data;
  return {
    ...env,
    jwtPrivateKeyPem: decodeBase64Pem(env.JWT_PRIVATE_KEY_BASE64, 'JWT_PRIVATE_KEY_BASE64'),
    jwtPublicKeyPem: decodeBase64Pem(env.JWT_PUBLIC_KEY_BASE64, 'JWT_PUBLIC_KEY_BASE64'),
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
