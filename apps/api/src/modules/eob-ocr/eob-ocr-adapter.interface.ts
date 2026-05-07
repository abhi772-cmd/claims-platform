// EobOcrAdapter abstracts EOB structured-field extraction. Three modes
// via EOB_OCR_MODE:
//   off  — DisabledEobOcrAdapter: every result is 'skipped'. Operators
//          key the values in by hand on the settlement screen.
//   stub — StubEobOcrAdapter: deterministic fixtures matched against
//          sentinel strings in the buffer or by filename hint, so
//          integration tests can drive the "auto-extracted fields show
//          up on the settlement form" UX without an OCR engine.
//   real — DEFERRED. Will route to a PaddleOCR / Surya pipeline with a
//          Qwen2-VL / GOT-OCR2.0 multimodal pass for structured fields.
//          The interface below is what that adapter has to satisfy.
//
// Shape parallels VirusScanAdapter intentionally — both consume the
// same `(buffer | (storageBucket, storageKey))` document handle that
// document.service hands its post-finalize hooks. The eventual real
// adapter will pull bytes via StorageAdapter.getObject the same way
// ClamAvScanAdapter does (Slice AS).

export const EOB_OCR_ADAPTER = Symbol('EOB_OCR_ADAPTER');

export interface ExtractInput {
  // The bytes to OCR. Either a buffer (for in-memory checks) or
  // (storageBucket, storageKey) so the real adapter can stream from
  // S3. The current adapters only consume `buffer`; the real adapter
  // will support both like ClamAv does.
  buffer?: Buffer;
  storageBucket?: string;
  storageKey?: string;
  // MIME type hint — multimodal models behave differently on PDF vs
  // single-page image vs multi-page TIFF.
  contentType?: string;
  // Original filename. The stub uses this to pick a fixture; real
  // adapters may use it to log under a stable identifier.
  originalFilename?: string;
}

export interface ExtractedDeduction {
  // Free-form bucket the payer used ("co-pay", "exclusions", "non-payable
  // items"). Operators normalise these against tenant-defined
  // categories on the settlement screen.
  category: string;
  amount: number;
  // Reason copy from the EOB. Often the most variable field.
  reason?: string;
}

// All fields are optional — the adapter returns whatever it could
// confidently extract. Operators see the rest as blanks they need to
// fill in. The settlement screen will badge auto-extracted values so
// reviewers can spot OCR mistakes before saving.
export interface ExtractedEob {
  claimRefNum?: string;
  receivedAmount?: number;
  deductionAmount?: number;
  deductions: ExtractedDeduction[];
  shortPaymentReasons: string[];
  bankTxnId?: string;
  receivedAt?: string;
  // Optional per-field confidence in [0, 1]. The settlement UI uses
  // these to decide which fields to badge "auto-extracted, please
  // verify" vs "auto-extracted, high confidence". Real OCR engines
  // produce these natively; the stub fills them with 1.0.
  confidence?: ExtractedConfidence;
}

export interface ExtractedConfidence {
  claimRefNum?: number;
  receivedAmount?: number;
  deductionAmount?: number;
  bankTxnId?: number;
  receivedAt?: number;
}

export type ExtractStatus =
  // OCR ran and produced fields above the engine's confidence floor.
  | 'extracted'
  // OCR ran but every confidence was too low to surface — operator
  // sees an empty form and a hint to extract manually.
  | 'low_confidence'
  // The 'off' adapter, or any caller that asked for OCR on something
  // the engine doesn't accept (wrong content type, etc.).
  | 'skipped'
  // Engine error: timeout, bad PDF, model crash. Caller decides whether
  // to retry. `error` is populated.
  | 'failed';

export interface ExtractResult {
  status: ExtractStatus;
  // Free-form engine identifier ('disabled', 'stub', 'paddle+qwen2vl',
  // 'surya+got-ocr2', etc.). Persisted alongside the row so we can
  // tell which engine produced which extraction during model rotation.
  engine: string;
  // Populated when status='extracted' or 'low_confidence'. The two
  // statuses differ only in whether we surface the fields by default;
  // the data is the same shape.
  fields?: ExtractedEob;
  // Free-form on status='failed'. Permanent vs transient distinction
  // is the worker's call.
  error?: string;
}

export interface EobOcrAdapter {
  extract(input: ExtractInput): Promise<ExtractResult>;
}
