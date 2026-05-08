// Slice BN — onboarding state file IO unit tests. Round-trips,
// schema rejection on a corrupt file, and resume after a partial run.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  emptyState,
  loadState,
  saveState,
  type OnboardingState,
} from './pmjay-onboard-state';

describe('pmjay-onboard-state', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pmjay-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadState returns null when file absent', () => {
    expect(loadState(join(dir, 'missing.json'))).toBeNull();
  });

  it('round-trips a fresh empty state', () => {
    const path = join(dir, 'state.json');
    const initial = emptyState('https://gw.test/v2/');
    saveState(path, initial);
    const round = loadState(path);
    expect(round).not.toBeNull();
    expect(round!.step).toBe('pending_create');
    expect(round!.baseUrl).toBe('https://gw.test/v2/');
  });

  it('round-trips a partially-completed state', () => {
    const path = join(dir, 'state.json');
    const partial: OnboardingState = {
      step: 'awaiting_update_otp',
      baseUrl: 'https://gw.test/v2/',
      registryid: 'IN1234',
      mobilenumber: '9876543210',
      email: 'ops@hospital.test',
      participantid: 'pmjay-001',
      createTransactionId: 'txn-1',
      privateKeyPath: '/keys/p.pem',
      publicKeyPath: '/keys/p.public.pem',
      endpointurl: 'https://hospital.test/inbound',
      updateTransactionId: 'txn-2',
    };
    saveState(path, partial);
    const round = loadState(path);
    expect(round).toMatchObject(partial);
    expect(round!.lastUpdatedAt).toBeDefined();
  });

  it('rejects a corrupt state file via schema validation', () => {
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify({ step: 'NOT_A_REAL_STEP' }), 'utf8');
    expect(() => loadState(path)).toThrow();
  });

  it('saveState stamps lastUpdatedAt and reflects the latest step', () => {
    const path = join(dir, 'state.json');
    const initial = emptyState('https://gw.test/v2/');
    saveState(path, initial);
    const a = loadState(path)!;
    expect(a.lastUpdatedAt).toBeDefined();

    const next: OnboardingState = { ...a, step: 'awaiting_create_otp' };
    saveState(path, next);
    const b = loadState(path)!;
    expect(b.step).toBe('awaiting_create_otp');
    expect(b.lastUpdatedAt).toBeDefined();
    // Don't assert b.lastUpdatedAt strictly differs from a's — on a
    // fast runner the two saveState calls can land in the same
    // millisecond. Date.now() resolution made this flaky on CI.
  });
});
