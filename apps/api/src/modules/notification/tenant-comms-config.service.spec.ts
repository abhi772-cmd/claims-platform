// Resolver-level unit tests for TenantCommsConfigService. The real
// integration test (tenant-comms-config.e2e-spec.ts) covers the
// end-to-end HTTP flow against Postgres; here we focus on:
//   - env fallback when no override is present
//   - tenant override wins when set
//   - cache TTL + invalidate behaviour
//   - corrupted JSON falls back gracefully

import { TenantCommsConfigService } from './tenant-comms-config.service';

interface FakePrisma {
  runInTenantContext: jest.Mock;
}

function makeConfig(values: Record<string, string | number>): {
  get: jest.Mock;
} {
  return {
    get: jest.fn((key: string) => values[key]),
  };
}

function makePrisma(rowFor: (tenantId: string) => unknown): FakePrisma {
  return {
    runInTenantContext: jest.fn(async (tenantId: string, _role: string, cb) => {
      const tx = {
        tenant: {
          findUnique: jest.fn().mockResolvedValue({
            commsConfig: rowFor(tenantId),
          }),
          update: jest.fn().mockResolvedValue(undefined),
        },
      };
      return cb(tx);
    }),
  };
}

describe('TenantCommsConfigService', () => {
  const envValues = {
    SMTP_HOST: 'mailhog.platform.local',
    SMTP_PORT: 1025,
    SMTP_FROM: 'no-reply@platform.local',
  };

  it('falls back to env defaults when tenant has no override', async () => {
    const prisma = makePrisma(() => ({}));
    const config = makeConfig(envValues);
    const svc = new TenantCommsConfigService(prisma as never, config as never);

    const smtp = await svc.resolveSmtp('tenant-1');
    expect(smtp.source).toBe('env');
    expect(smtp.host).toBe('mailhog.platform.local');
    expect(smtp.port).toBe(1025);
    expect(smtp.from).toBe('no-reply@platform.local');
    expect(smtp.password).toBeNull();
    expect(smtp.ignoreTls).toBe(true); // dev-default

    const sms = await svc.resolveSms('tenant-1');
    expect(sms.source).toBe('env');
    expect(sms.provider).toBe('console');
    expect(sms.apiKey).toBeNull();
  });

  it('uses tenant override when set', async () => {
    const prisma = makePrisma(() => ({
      smtp: {
        host: 'smtp.tenant.example',
        port: 587,
        from: 'no-reply@tenant.example',
        username: 'tenant-user',
        password: 'tenant-pw',
        secure: true,
      },
      sms: { provider: 'textguru', apiKey: 'k', senderId: 'TENANT' },
    }));
    const config = makeConfig(envValues);
    const svc = new TenantCommsConfigService(prisma as never, config as never);

    const smtp = await svc.resolveSmtp('tenant-1');
    expect(smtp.source).toBe('tenant');
    expect(smtp.host).toBe('smtp.tenant.example');
    expect(smtp.password).toBe('tenant-pw');
    expect(smtp.secure).toBe(true);
    // ignoreTls defaults to false when only secure is supplied.
    expect(smtp.ignoreTls).toBe(false);

    const sms = await svc.resolveSms('tenant-1');
    expect(sms.source).toBe('tenant');
    expect(sms.provider).toBe('textguru');
    expect(sms.apiKey).toBe('k');
  });

  it('caches per-tenant — repeat resolves do not hit the DB', async () => {
    const prisma = makePrisma(() => ({}));
    const config = makeConfig(envValues);
    const svc = new TenantCommsConfigService(prisma as never, config as never);

    await svc.resolveSmtp('tenant-1');
    await svc.resolveSmtp('tenant-1');
    await svc.resolveSms('tenant-1');
    expect(prisma.runInTenantContext).toHaveBeenCalledTimes(1);
  });

  it('invalidate forces a re-fetch', async () => {
    const prisma = makePrisma(() => ({}));
    const config = makeConfig(envValues);
    const svc = new TenantCommsConfigService(prisma as never, config as never);

    await svc.resolveSmtp('tenant-1');
    svc.invalidate('tenant-1');
    await svc.resolveSmtp('tenant-1');
    expect(prisma.runInTenantContext).toHaveBeenCalledTimes(2);
  });

  it('redacts secrets in the summary', async () => {
    const prisma = makePrisma(() => ({
      smtp: { host: 'h', port: 25, from: 'a@b.test', password: 'pw', secure: false },
      sms: { provider: 'textguru', apiKey: 'k' },
    }));
    const config = makeConfig(envValues);
    const svc = new TenantCommsConfigService(prisma as never, config as never);

    const summary = await svc.getSummary('tenant-1');
    expect(summary.smtp).toMatchObject({ host: 'h', passwordSet: true, source: 'tenant' });
    expect(summary.sms).toMatchObject({ provider: 'textguru', apiKeySet: true, source: 'tenant' });
    expect(JSON.stringify(summary)).not.toContain('pw');
    expect(JSON.stringify(summary)).not.toContain('"k"');
  });

  it('falls back to env when tenant blob is malformed', async () => {
    const prisma = makePrisma(() => ({ smtp: { wrongShape: true } }));
    const config = makeConfig(envValues);
    const svc = new TenantCommsConfigService(prisma as never, config as never);

    const smtp = await svc.resolveSmtp('tenant-1');
    expect(smtp.source).toBe('env');
    expect(smtp.host).toBe('mailhog.platform.local');
  });
});
