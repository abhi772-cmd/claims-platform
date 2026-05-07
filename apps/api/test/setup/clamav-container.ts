// Spins up an ephemeral ClamAV daemon via testcontainers and returns
// the host:port the adapter should connect to.
//
// We use the official `clamav/clamav:1.4` image which ships a
// pre-built signature database alongside the daemon, so EICAR is
// detected from the first request. The slimmer `_base` images skip
// signatures and clamd refuses to start without at least one DB
// loaded — that path needs a mounted DB volume which adds CI
// surface for marginal benefit.
//
// Readiness: clamd binds the listener (and logs "Listening daemon")
// well *before* the signature DB finishes loading. Connecting in
// that window gets the connection reset (ECONNRESET). The
// authoritative "ready" signal is a successful PING/PONG round-trip,
// not a log line — so after the container starts we open a socket
// and send `zPING\0` until clamd answers `PONG\0`. Found the hard
// way in CI on the first AU run.
//
// Used by the Slice AU real-clamd e2e test as the production-path
// validator on top of the `node:net` mock-server unit tests.

import { connect } from 'node:net';

import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export interface ClamAvHandles {
  container: StartedTestContainer;
  endpoint: string;
  shutdown: () => Promise<void>;
}

const CLAMD_PORT = 3310;
const PING_TIMEOUT_MS = 2_000;
const READY_DEADLINE_MS = 180_000;
const READY_POLL_MS = 1_000;

export async function startClamAv(): Promise<ClamAvHandles> {
  const container = await new GenericContainer('clamav/clamav:1.4')
    .withExposedPorts(CLAMD_PORT)
    // The log strategy is just a coarse "container is alive" gate;
    // it tolerates either the early "Listening" line OR the later
    // "Self checking" line. The real readiness gate is the PING
    // loop below.
    .withWaitStrategy(
      Wait.forLogMessage(/Listening daemon|Self checking|clamd started/i, 1),
    )
    // Cold-cache image pull + signature-DB load can take a minute or
    // more on a fresh CI runner; pad the deadline.
    .withStartupTimeout(READY_DEADLINE_MS)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(CLAMD_PORT);

  // Block until clamd actually answers PING. Anything before that
  // gets ECONNRESET because the daemon is still loading the DB.
  await waitForPong(host, port);

  return {
    container,
    endpoint: `${host}:${port}`,
    shutdown: async () => {
      await container.stop();
    },
  };
}

async function waitForPong(host: string, port: number): Promise<void> {
  const deadline = Date.now() + READY_DEADLINE_MS;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      await ping(host, port);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }
  throw new Error(
    `clamd at ${host}:${port} did not answer PING within ${READY_DEADLINE_MS}ms (last error: ${lastErr?.message ?? 'unknown'})`,
  );
}

function ping(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let buf = '';
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      action();
    };
    socket.setTimeout(PING_TIMEOUT_MS);
    socket.once('timeout', () => finish(() => reject(new Error('ping timeout'))));
    socket.once('error', (err) => finish(() => reject(err)));
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (buf.includes('PONG')) finish(() => resolve());
    });
    socket.once('connect', () => {
      socket.write(Buffer.from('zPING\0', 'utf8'));
    });
  });
}
