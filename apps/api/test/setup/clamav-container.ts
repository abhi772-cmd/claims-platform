// Spins up an ephemeral ClamAV daemon via testcontainers and returns
// the host:port the adapter should connect to.
//
// We use the official `clamav/clamav:1.4` image which ships a
// pre-built signature database alongside the daemon, so EICAR is
// detected from the first request. The slimmer `_base` images skip
// signatures and clamd refuses to start without at least one DB
// loaded — that path needs a mounted DB volume which adds CI
// surface for marginal benefit. The full image takes ~30-45s to
// finish loading signatures + start the listener; the wait strategy
// blocks until clamd's "started" / "listening" log line lands.
//
// Used by the Slice AU real-clamd e2e test as the production-path
// validator on top of the `node:net` mock-server unit tests
// (which prove protocol correctness against a wire-format-faithful
// fake; this proves the same code talks to a real clamd).

import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export interface ClamAvHandles {
  container: StartedTestContainer;
  endpoint: string;
  shutdown: () => Promise<void>;
}

const CLAMD_PORT = 3310;

export async function startClamAv(): Promise<ClamAvHandles> {
  const container = await new GenericContainer('clamav/clamav:1.4')
    .withExposedPorts(CLAMD_PORT)
    // clamd reports several "started" lines after signatures load and
    // the listener binds. Match any of them — the daemon is ready
    // for INSTREAM as soon as the listener is up.
    .withWaitStrategy(
      Wait.forLogMessage(/clamd[^\n]*started|Listening daemon|socket found/i, 1),
    )
    // Loading the full signature DB on first start can take a minute
    // on a cold runner; pad the deadline so flaky scheduling doesn't
    // bin the test.
    .withStartupTimeout(180_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(CLAMD_PORT);
  return {
    container,
    endpoint: `${host}:${port}`,
    shutdown: async () => {
      await container.stop();
    },
  };
}
