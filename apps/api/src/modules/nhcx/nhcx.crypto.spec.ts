import { generateKeyPairSync } from 'node:crypto';

import {
  _resetKeyCacheForTests,
  decryptFromParticipant,
  encryptToParticipant,
  readJweKid,
} from './nhcx.crypto';

describe('NHCX JWE crypto', () => {
  let publicPem: string;
  let privatePem: string;

  beforeEach(() => {
    _resetKeyCacheForTests();
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  });

  it('round-trip: encrypt + decrypt yields the same payload', async () => {
    const payload = {
      bundle: {
        resourceType: 'CoverageEligibilityRequest',
        patient: { mrn: 'MRN-123' },
        amount: 250_000,
      },
    };
    const compactJwe = await encryptToParticipant(payload, publicPem);
    expect(compactJwe).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const decrypted = await decryptFromParticipant<typeof payload>(compactJwe, privatePem);
    expect(decrypted).toEqual(payload);
  });

  it('decrypt with wrong key fails', async () => {
    const payload = { hello: 'world' };
    const compactJwe = await encryptToParticipant(payload, publicPem);
    const { privateKey: otherPriv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wrongPem = otherPriv.export({ type: 'pkcs8', format: 'pem' }).toString();
    await expect(decryptFromParticipant(compactJwe, wrongPem)).rejects.toThrow();
  });

  it('produces a different ciphertext on each encryption (fresh CEK)', async () => {
    const payload = { x: 1 };
    const a = await encryptToParticipant(payload, publicPem);
    const b = await encryptToParticipant(payload, publicPem);
    expect(a).not.toBe(b);
  });

  it('readJweKid returns the kid stamped on the protected header', async () => {
    const blob = await encryptToParticipant({ hello: 'world' }, publicPem, 'v2');
    expect(readJweKid(blob)).toBe('v2');
  });

  it('readJweKid returns null when no kid was set', async () => {
    const blob = await encryptToParticipant({ hello: 'world' }, publicPem);
    expect(readJweKid(blob)).toBeNull();
  });

  it('readJweKid returns null on malformed input', () => {
    expect(readJweKid('not.a.real.jwe.blob')).toBeNull();
    expect(readJweKid('')).toBeNull();
  });
});
