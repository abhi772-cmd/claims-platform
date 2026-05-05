// VirusScanAdapter abstracts the AV layer. Three modes via VIRUS_SCAN_MODE:
//   off  — DisabledScanAdapter: every result is 'skipped'.
//   stub — StubScanAdapter:    EICAR test signature is detected,
//                              everything else is 'clean'. Useful for
//                              CI without a real scanner.
//   real — ClamAvScanAdapter:  ClamAV INSTREAM over TCP. Deferred to
//                              Sprint 5 hardening; the interface is
//                              ready so the swap is contained.

export const VIRUS_SCAN_ADAPTER = Symbol('VIRUS_SCAN_ADAPTER');

export interface ScanInput {
  // The bytes to scan. Either a buffer (for in-memory checks) or
  // (storageBucket, storageKey) so the real adapter can stream from S3.
  buffer?: Buffer;
  storageBucket?: string;
  storageKey?: string;
  // Hint — used by some scanners for content-type-aware rules.
  contentType?: string;
}

export interface ScanResult {
  // status mirrors the column on Document.scanStatus.
  status: 'clean' | 'infected' | 'skipped' | 'failed';
  engine: string;
  // Populated when status='infected' — the matching signature
  // (e.g. "Eicar-Test-Signature").
  signature?: string;
  // Free-form when status='failed'. Permanent vs transient distinction
  // is the worker's call (it retries failed N times).
  error?: string;
}

export interface VirusScanAdapter {
  scan(input: ScanInput): Promise<ScanResult>;
}
