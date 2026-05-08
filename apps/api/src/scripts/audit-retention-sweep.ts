#!/usr/bin/env node
// Slice BP — operator-triggered audit retention sweep. Wraps the
// AuditRetentionSweeperService for invocation via:
//   pnpm --filter @claims/api audit:retention-sweep
//
// The expected production wiring is an external scheduler — k8s
// CronJob, cloud cron, or pg_cron — invoking this script (or hitting
// the function directly via SQL) on a nightly cadence. We don't ship
// an in-app cron because Redis is deferred and a naive setInterval
// would race across replicas.
//
// Boots the same NestJS app the API uses but exits as soon as the
// sweep finishes — no HTTP listener, no scheduler. Prints a
// per-class summary on stdout for the operator's log + the
// downstream cron's exit-code-driven alerting.

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { AuditRetentionSweeperService } from '../modules/audit/audit-retention-sweeper.service';

async function main(): Promise<void> {
  // bufferLogs lets us suppress Nest's startup chatter and only
  // print the structured sweep result. The sweeper logs its own
  // line via Logger; we add a stdout summary that's parseable by
  // shell tooling.
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  try {
    const sweeper = app.get(AuditRetentionSweeperService);
    const result = await sweeper.sweepAll();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`audit retention sweep failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
