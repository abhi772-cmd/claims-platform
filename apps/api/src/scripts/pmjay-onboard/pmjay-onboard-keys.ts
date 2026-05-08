// Slice BN — RSA keypair helpers for PMJAY onboarding. The participant
// update call (step 3) takes a base64-encoded X.509 PEM public key.
// The private key stays with the hospital and is used later to
// decrypt JWE-wrapped inbound bundles from the gateway. We generate
// it locally and never transmit it.

import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface KeyPaths {
  privateKeyPath: string;
  publicKeyPath: string;
}

// Generate a 2048-bit RSA keypair (PMJAY default; 4096 is also
// supported but slows JWE decryption noticeably). Writes the PEM
// files to disk with 0600 on POSIX and returns the paths. If both
// files already exist we don't overwrite — the operator may have
// generated keys via `openssl` themselves.
export function ensureKeypair(opts: {
  pathPrefix: string;
  modulusLength?: number;
}): KeyPaths {
  const privateKeyPath = `${opts.pathPrefix}.private.pem`;
  const publicKeyPath = `${opts.pathPrefix}.public.pem`;
  if (existsSync(privateKeyPath) && existsSync(publicKeyPath)) {
    return { privateKeyPath, publicKeyPath };
  }
  if (existsSync(privateKeyPath) || existsSync(publicKeyPath)) {
    throw new Error(
      `Refusing to generate keypair: only one of ${privateKeyPath} / ${publicKeyPath} exists. Delete the lone file or pick a different --keypair prefix.`,
    );
  }
  const dir = dirname(privateKeyPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: opts.modulusLength ?? 2048,
  });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  writeFileSync(privateKeyPath, privatePem, 'utf8');
  writeFileSync(publicKeyPath, publicPem, 'utf8');
  try {
    chmodSync(privateKeyPath, 0o600);
    chmodSync(publicKeyPath, 0o644);
  } catch {
    // Best-effort on platforms without POSIX chmod (Windows).
  }
  return { privateKeyPath, publicKeyPath };
}

// Read a PEM public key from disk and base64-encode it for the
// `encryptioncert` field on the participant/update call. The handbook
// is explicit: the field carries base64(pem-text), not the raw PEM,
// not the DER bytes.
export function readPublicKeyAsBase64Pem(publicKeyPath: string): string {
  const pem = readFileSync(publicKeyPath, 'utf8');
  return Buffer.from(pem, 'utf8').toString('base64');
}
