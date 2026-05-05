import { isIP } from 'node:net';

// Lightweight CIDR / IP matcher. Built on Node's net.isIP (which is in
// stdlib, no extra dep). Handles both IPv4 and IPv6.
//
// Why hand-roll instead of pulling in `ip` or `cidr-match`:
//   * v4 is 32 bits — trivial bigint masking.
//   * v6 is 128 bits — also trivial bigint masking once parsed.
//   * The `ip` npm package has been deprecated for security issues.
//   * Avoids one more transitive dependency on the auth path.

export interface CidrRange {
  raw: string;
  family: 4 | 6;
  network: bigint;
  prefix: number;
}

export function parseCidr(input: string): CidrRange | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const slashIdx = trimmed.indexOf('/');
  const ipPart = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
  const family = isIP(ipPart);
  if (family === 0) return null;
  const fam = family === 4 ? 4 : 6;
  const max = fam === 4 ? 32 : 128;
  let prefix = max;
  if (slashIdx !== -1) {
    const p = Number.parseInt(trimmed.slice(slashIdx + 1), 10);
    if (!Number.isInteger(p) || p < 0 || p > max) return null;
    prefix = p;
  }
  const ipBig = ipToBigInt(ipPart, fam);
  if (ipBig === null) return null;
  const mask = prefix === 0 ? 0n : (~0n >> BigInt(max - prefix)) << BigInt(max - prefix);
  return {
    raw: trimmed,
    family: fam,
    network: ipBig & mask,
    prefix,
  };
}

export function ipMatches(ip: string, range: CidrRange): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  const fam = family === 4 ? 4 : 6;
  if (fam !== range.family) return false;
  const ipBig = ipToBigInt(ip, fam);
  if (ipBig === null) return false;
  const max = fam === 4 ? 32 : 128;
  const mask = range.prefix === 0 ? 0n : (~0n >> BigInt(max - range.prefix)) << BigInt(max - range.prefix);
  return (ipBig & mask) === range.network;
}

export function ipMatchesAny(ip: string, ranges: readonly CidrRange[]): boolean {
  for (const r of ranges) {
    if (ipMatches(ip, r)) return true;
  }
  return false;
}

function ipToBigInt(ip: string, family: 4 | 6): bigint | null {
  if (family === 4) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let acc = 0n;
    for (const p of parts) {
      const n = Number.parseInt(p, 10);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      acc = (acc << 8n) | BigInt(n);
    }
    return acc;
  }
  // IPv6 — expand any "::" then parse 8 16-bit groups.
  const expanded = expandIpv6(ip);
  if (!expanded) return null;
  const parts = expanded.split(':');
  if (parts.length !== 8) return null;
  let acc = 0n;
  for (const p of parts) {
    const n = Number.parseInt(p, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    acc = (acc << 16n) | BigInt(n);
  }
  return acc;
}

function expandIpv6(ip: string): string | null {
  // Reject embedded IPv4 form for simplicity — rare in our enterprise-IP
  // allowlist use case. If we ever need it, pull in a proper parser.
  if (ip.includes('.')) return null;
  if (!ip.includes('::')) return ip;
  const [head, tail] = ip.split('::') as [string, string];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  const middle = new Array<string>(missing).fill('0');
  return [...headParts, ...middle, ...tailParts].join(':');
}
