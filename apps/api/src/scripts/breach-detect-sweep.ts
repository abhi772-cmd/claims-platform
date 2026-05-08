#!/usr/bin/env node
// Slice BS — operator-triggered breach anomaly detection sweep.
// Usage:
//   pnpm --filter @claims/api breach:scan
//   pnpm --filter @claims/api breach:scan -- --window-minutes=120
//
// Wraps BreachDetectorService.scan() for cron-driven invocation.
// Production wiring is the same as audit:retention-sweep — an
// external scheduler (k8s CronJob, cloud cron, pg_cron) calls this
// on a cadence (10–15min for tight detection, hourly for steady
// state). We don't ship an in-app cron because Redis is deferred
// and a naive setInterval would race across replicas.
//
// Boots the same NestJS app the API uses but exits as soon as the
// scan finishes — no HTTP listener, no scheduler. Prints the
// structured scan result on stdout.

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { BreachDetectorService } from '../modules/breach/breach-detector.service';

interface CliOpts {
  windowMinutes?: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--window-minutes=(\d+)$/);
    if (m) opts.windowMinutes = Number(m[1]);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  try {
    const detector = app.get(BreachDetectorService);
    const result = await detector.scan(
      opts.windowMinutes !== undefined ? { windowMinutes: opts.windowMinutes } : {},
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`breach detection sweep failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
