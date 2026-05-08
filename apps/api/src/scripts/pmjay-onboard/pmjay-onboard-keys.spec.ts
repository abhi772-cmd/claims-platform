// Slice BN — keypair helper unit tests. Generates real RSA keys (it's
// fast at 2048) so the assertions cover actual PEM output, not a mock.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureKeypair, readPublicKeyAsBase64Pem } from './pmjay-onboard-keys';

describe('pmjay-onboard-keys', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pmjay-keys-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates a 2048-bit RSA keypair and writes PEM files', () => {
    const prefix = join(dir, 'hospital');
    const out = ensureKeypair({ pathPrefix: prefix });
    expect(out.privateKeyPath).toBe(`${prefix}.private.pem`);
    expect(out.publicKeyPath).toBe(`${prefix}.public.pem`);
    expect(existsSync(out.privateKeyPath)).toBe(true);
    expect(existsSync(out.publicKeyPath)).toBe(true);
    const priv = readFileSync(out.privateKeyPath, 'utf8');
    const pub = readFileSync(out.publicKeyPath, 'utf8');
    expect(priv).toMatch(/-----BEGIN PRIVATE KEY-----/);
    expect(pub).toMatch(/-----BEGIN PUBLIC KEY-----/);
  });

  it('skips regeneration when both files already exist', () => {
    const prefix = join(dir, 'hospital');
    const first = ensureKeypair({ pathPrefix: prefix });
    const privBefore = readFileSync(first.privateKeyPath, 'utf8');
    const second = ensureKeypair({ pathPrefix: prefix });
    expect(readFileSync(second.privateKeyPath, 'utf8')).toBe(privBefore);
  });

  it('refuses to generate when only one file exists (avoid clobbering)', () => {
    const prefix = join(dir, 'hospital');
    writeFileSync(`${prefix}.private.pem`, 'pre-existing-private', 'utf8');
    expect(() => ensureKeypair({ pathPrefix: prefix })).toThrow(/Refusing to generate/);
  });

  it('readPublicKeyAsBase64Pem returns base64(pem-text)', () => {
    const prefix = join(dir, 'hospital');
    const out = ensureKeypair({ pathPrefix: prefix });
    const b64 = readPublicKeyAsBase64Pem(out.publicKeyPath);
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).toBe(readFileSync(out.publicKeyPath, 'utf8'));
    expect(decoded).toMatch(/-----BEGIN PUBLIC KEY-----/);
  });
});
