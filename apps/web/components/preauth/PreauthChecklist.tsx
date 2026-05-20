'use client';

import {
  type ChecklistAdmissionType,
  type Document,
  type DocumentType,
  type ResolvedChecklistItem,
} from '@claims/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../toast/ToastProvider';
import { CaseApi } from '../../lib/api/case.api';
import { MasterDataApi } from '../../lib/api/master-data.api';
import { uploadDocument } from '../../lib/upload';

interface Props {
  caseId: string;
  claimId: string;
  rail: 'nhcx' | 'pmjay' | 'self_pay';
  // Narrow the resolved rule set exactly the way the backend gate does,
  // so what the operator sees matches what blocks submit.
  payerCode?: string;
  packageCode?: string;
  admissionType?: ChecklistAdmissionType;
  // Whether the operator can still act (claim is in a pre-submit state).
  editable: boolean;
  // Bubble up after an upload so the parent can re-evaluate submit-ability.
  onChanged: () => void;
}

// Mirrors the backend hasDocumentType gate: a completed upload that
// passed (or skipped) the virus scan counts; pending/infected do not.
function isSatisfied(docs: readonly Document[], type: DocumentType): boolean {
  return docs.some(
    (d) =>
      d.documentType === type &&
      d.uploadStatus === 'completed' &&
      (d.scanStatus === 'clean' || d.scanStatus === 'skipped'),
  );
}

// Humanise the snake_case contract code for display (the code itself is
// still shown in monospace so operators can match it to payer guidance).
function prettyType(type: string): string {
  return type
    .split('_')
    .map((w) => (w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function PreauthChecklist({
  caseId,
  claimId,
  rail,
  payerCode,
  packageCode,
  admissionType,
  editable,
  onChanged,
}: Props): JSX.Element | null {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [items, setItems] = useState<ResolvedChecklistItem[]>([]);
  const [docs, setDocs] = useState<Document[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [uploadingType, setUploadingType] = useState<DocumentType | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingType = useRef<DocumentType | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [checklist, docList] = await Promise.all([
        MasterDataApi.resolveChecklist({
          phase: 'preauth',
          rail,
          ...(payerCode ? { payerCode } : {}),
          ...(packageCode ? { packageCode } : {}),
          ...(admissionType ? { admissionType } : {}),
        }),
        CaseApi.listDocuments(caseId, claimId),
      ]);
      setItems(checklist.items.filter((i) => i.required));
      setDocs(docList.documents);
      setLoaded(true);
    } catch (err) {
      // A failed checklist fetch must not strand the operator on the
      // preauth panel — surface it but leave the panel hidden (the
      // backend gate is still authoritative on submit).
      showApiError(err);
    }
  }, [caseId, claimId, rail, payerCode, packageCode, admissionType, showApiError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function pickFileFor(type: DocumentType): void {
    pendingType.current = type;
    fileInputRef.current?.click();
  }

  async function onFileChosen(file: File | undefined): Promise<void> {
    const type = pendingType.current;
    pendingType.current = null;
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file || !type) return;
    setUploadingType(type);
    try {
      await uploadDocument(caseId, claimId, file, type);
      showToast({ tone: 'success', message: `Uploaded ${prettyType(type)}.` });
      await refresh();
      onChanged();
    } catch (err) {
      showApiError(err);
    } finally {
      setUploadingType(null);
    }
  }

  // No rules → nothing required → render nothing (matches the vacuous
  // backend gate, so environments without seeded rules see no panel).
  if (!loaded || items.length === 0) return null;

  const missing = items.filter((i) => !isSatisfied(docs, i.documentType)).length;

  return (
    <section className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">fact_check</span>
          <h4 className="text-h4 font-h4 text-on-surface">Required documents</h4>
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            missing === 0
              ? 'bg-emerald-500/15 text-emerald-300'
              : 'bg-amber-500/15 text-amber-300'
          }`}
        >
          {missing === 0 ? 'All uploaded' : `${missing} missing`}
        </span>
      </div>
      <p className="text-xs text-on-surface-variant">
        This payer requires these for pre-authorisation. Submit is blocked until each is
        uploaded.
      </p>
      <ul className="space-y-1.5">
        {items.map((item) => {
          const ok = isSatisfied(docs, item.documentType);
          const busy = uploadingType === item.documentType;
          return (
            <li
              key={item.documentType}
              className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.03] px-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={`material-symbols-outlined text-[18px] ${
                    ok ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  {ok ? 'check_circle' : 'radio_button_unchecked'}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm text-on-surface">
                    {prettyType(item.documentType)}
                  </span>
                  <span className="font-mono text-xs text-on-surface-variant">
                    {item.documentType}
                  </span>
                </span>
              </span>
              {ok ? (
                <span className="shrink-0 text-xs text-emerald-300">Uploaded</span>
              ) : editable ? (
                <button
                  type="button"
                  onClick={() => pickFileFor(item.documentType)}
                  disabled={busy}
                  className="btn-outline shrink-0"
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                >
                  <span className="material-symbols-outlined text-[16px]">upload</span>
                  {busy ? 'Uploading…' : 'Upload'}
                </button>
              ) : (
                <span className="shrink-0 text-xs text-amber-300">Missing</span>
              )}
            </li>
          );
        })}
      </ul>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.zip"
        className="hidden"
        onChange={(e) => void onFileChosen(e.target.files?.[0])}
      />
    </section>
  );
}
