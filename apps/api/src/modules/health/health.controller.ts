import { connect } from 'node:net';

import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';

import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';

interface ReadinessChecks {
  database: boolean;
  // True when no _prisma_migrations rows are unfinished. False if a
  // migration is mid-flight or rolled back; null on probe failure.
  migrations: boolean | null;
}

interface ReadinessResponse {
  status: 'ok' | 'degraded';
  checks: ReadinessChecks;
  // Adapter modes — handy for ops dashboards to confirm what's wired
  // without round-tripping to env.
  adapters: {
    nhcx: 'stub' | 'real';
    hpr: 'stub' | 'real';
    storage: 'stub' | 'real';
  };
  // Build provenance, mirrors /health/version. Helpful when the
  // readiness endpoint is the only thing your load balancer can hit.
  build: {
    commit: string;
    builtAt: string;
  };
}

// Slice BE — deep-readiness probe. /health/ready stays cheap (DB +
// migrations); deep adds adapter-level probes that go over the wire.
// Each check returns `'ok' | 'skipped' | 'failed'` with an optional
// reason. `skipped` means the adapter is in stub/off mode, which is
// the right answer for dev / test deployments — we don't want a
// degraded LB drain because clamd isn't deployed locally.
type DeepCheckStatus = 'ok' | 'skipped' | 'failed';

interface DeepCheck {
  status: DeepCheckStatus;
  reason?: string;
  latencyMs?: number;
}

interface DeepReadinessResponse extends ReadinessResponse {
  deep: {
    clamav: DeepCheck;
    eobOcr: DeepCheck;
  };
}

const DEEP_PROBE_TIMEOUT_MS = 2_000;

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<ReadinessResponse> {
    const dbOk = await this.pingDb();
    const migrationsOk = dbOk ? await this.checkMigrations() : null;
    const allOk = dbOk && migrationsOk === true;
    return {
      status: allOk ? 'ok' : 'degraded',
      checks: { database: dbOk, migrations: migrationsOk },
      adapters: {
        nhcx: this.config.get('NHCX_MODE', { infer: true }),
        hpr: this.config.get('HPR_MODE', { infer: true }),
        storage: this.config.get('STORAGE_MODE', { infer: true }),
      },
      build: {
        commit: process.env['GIT_SHA'] ?? 'dev',
        builtAt: process.env['BUILT_AT'] ?? new Date(0).toISOString(),
      },
    };
  }

  // Slice BE — deep-readiness probe. Same shape as /ready plus an
  // adapter-level `deep` block. Each probe runs in parallel with a
  // 2s ceiling so the response stays bounded even when one
  // dependency is wedged. Don't wire this onto the load-balancer's
  // probe path — /ready stays the cheap one. /ready/deep is for ops
  // dashboards + manual-triggered diagnostics.
  @Get('ready/deep')
  async readyDeep(): Promise<DeepReadinessResponse> {
    const cheap = await this.ready();
    const [clamav, eobOcr] = await Promise.all([this.probeClamAv(), this.probeEobOcr()]);
    const deepDegraded = clamav.status === 'failed' || eobOcr.status === 'failed';
    return {
      ...cheap,
      status: cheap.status === 'degraded' || deepDegraded ? 'degraded' : 'ok',
      deep: { clamav, eobOcr },
    };
  }

  @Get('version')
  version(): { name: string; commit: string; builtAt: string } {
    return {
      name: '@claims/api',
      commit: process.env['GIT_SHA'] ?? 'dev',
      builtAt: process.env['BUILT_AT'] ?? new Date(0).toISOString(),
    };
  }

  private async pingDb(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  // Slice BE — open a TCP socket to clamd and run zPING/PONG. Same
  // protocol as the AU testcontainer-readiness gate. Skipped when
  // VIRUS_SCAN_MODE != 'real' so dev / test deployments don't show
  // as degraded. Bounded by DEEP_PROBE_TIMEOUT_MS.
  private async probeClamAv(): Promise<DeepCheck> {
    const mode = this.config.get('VIRUS_SCAN_MODE', { infer: true });
    if (mode !== 'real') return { status: 'skipped' };
    const endpoint = this.config.get('VIRUS_SCAN_ENDPOINT', { infer: true });
    if (!endpoint) {
      return { status: 'failed', reason: 'VIRUS_SCAN_ENDPOINT not configured' };
    }
    const [host, portStr] = endpoint.split(':');
    const port = Number.parseInt(portStr ?? '3310', 10);
    if (!host || !Number.isFinite(port) || port <= 0) {
      return { status: 'failed', reason: `Invalid VIRUS_SCAN_ENDPOINT: ${endpoint}` };
    }
    const start = Date.now();
    return new Promise<DeepCheck>((resolve) => {
      const socket = connect({ host, port });
      let buf = '';
      let settled = false;
      const finish = (check: DeepCheck): void => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve({ ...check, latencyMs: Date.now() - start });
      };
      socket.setTimeout(DEEP_PROBE_TIMEOUT_MS);
      socket.once('timeout', () => finish({ status: 'failed', reason: 'clamd ping timeout' }));
      socket.once('error', (err) =>
        finish({ status: 'failed', reason: `clamd connect: ${err.message}` }),
      );
      // Close-before-PONG counts as failure. clamd that died mid-handshake,
      // or a misconfigured proxy that hangs up, hits this path on Windows
      // (RST → 'error') and on Linux (clean FIN → 'close' without error).
      socket.once('close', () =>
        finish({ status: 'failed', reason: 'clamd closed connection before PONG' }),
      );
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        if (buf.includes('PONG')) finish({ status: 'ok' });
      });
      socket.once('connect', () => {
        socket.write(Buffer.from('zPING\0', 'utf8'));
      });
    });
  }

  // Slice BE — HEAD request against the inference service so we
  // confirm reachability without loading a model run. Skipped when
  // EOB_OCR_MODE != 'real'. We accept any 2xx/3xx/4xx as a sign the
  // server is alive — even a 405 (Method Not Allowed on /, which is
  // common for inference services) tells us the process is up.
  // Hard 5xx + network errors fail the check.
  private async probeEobOcr(): Promise<DeepCheck> {
    const mode = this.config.get('EOB_OCR_MODE', { infer: true });
    if (mode !== 'real') return { status: 'skipped' };
    const baseUrl = this.config.get('EOB_OCR_INFERENCE_URL', { infer: true });
    if (!baseUrl) {
      return { status: 'failed', reason: 'EOB_OCR_INFERENCE_URL not configured' };
    }
    const start = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DEEP_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(baseUrl.replace(/\/$/, ''), {
        method: 'HEAD',
        signal: ac.signal,
      });
      const latencyMs = Date.now() - start;
      if (res.status >= 500) {
        return {
          status: 'failed',
          reason: `inference HEAD HTTP ${res.status}`,
          latencyMs,
        };
      }
      return { status: 'ok', latencyMs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        reason: `inference HEAD: ${message}`,
        latencyMs: Date.now() - start,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // Inspect prisma's _prisma_migrations bookkeeping. Each migration
  // row has finished_at + rolled_back_at; we want every applied
  // migration to be finished and not rolled back. A degraded migration
  // state (mid-application or rolled back) means the schema doesn't
  // match what the code expects — pull the instance out of rotation.
  private async checkMigrations(): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ unfinished: bigint; rolled_back: bigint; total: bigint }>
      >`
        SELECT
          COUNT(*) FILTER (WHERE finished_at IS NULL) AS unfinished,
          COUNT(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back,
          COUNT(*) AS total
        FROM _prisma_migrations
      `;
      const row = rows[0];
      if (!row) return false;
      const total = Number(row.total);
      const unfinished = Number(row.unfinished);
      const rolledBack = Number(row.rolled_back);
      return total > 0 && unfinished === 0 && rolledBack === 0;
    } catch {
      return false;
    }
  }
}
