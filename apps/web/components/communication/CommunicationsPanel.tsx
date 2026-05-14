'use client';

import { type CommunicationEntry } from '@claims/contracts';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { CommunicationApi } from '../../lib/api/communication.api';

// Stage 5 — case-detail communications timeline.
//
// Reads /cases/:caseId/communications and renders both directions on
// a chronological timeline (outbound = teal, inbound = neutral with
// amber pip). The form posts to
// /cases/:caseId/claims/:claimId/communications. Visual language
// mirrors the login page: glass card, teal primary CTA, sentence
// case throughout, no third color.

interface Props {
  caseId: string;
  claimId: string | null;
}

export function CommunicationsPanel({ caseId, claimId }: Props): JSX.Element {
  const { showApiError } = useErrorModal();
  const [entries, setEntries] = useState<CommunicationEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  async function reload(): Promise<void> {
    try {
      const res = await CommunicationApi.listForCase(caseId);
      setEntries(res.entries);
      setLoaded(true);
    } catch (err) {
      showApiError(err);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!claimId) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    setSending(true);
    try {
      await CommunicationApi.send(caseId, claimId, { text: trimmed });
      setText('');
      await reload();
    } catch (err) {
      showApiError(err);
    } finally {
      setSending(false);
    }
  }

  const grouped = useMemo(() => groupByDay(entries), [entries]);
  const canSend = Boolean(claimId) && text.trim().length > 0 && !sending;

  return (
    <section className="glass space-y-5 rounded-xl p-6">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">forum</span>
        <h3 className="text-h3 font-h3 text-on-surface">Communications</h3>
      </div>
      <p className="text-body-sm text-on-surface-variant">
        Send a free-form note to the payer or read messages they have sent. Use this for
        clarifications on partial approvals, variance questions, or to flag a deferred
        enhancement after discharge.
      </p>

      {/* Timeline */}
      <div className="space-y-4">
        {!loaded ? (
          <p className="text-body-sm text-on-surface-variant">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant">
            No messages yet. Start the conversation below.
          </p>
        ) : (
          grouped.map(([day, items]) => (
            <div key={day} className="space-y-3">
              <div className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                {day}
              </div>
              <ul className="space-y-3">
                {items.map((entry) => (
                  <TimelineRow key={entry.id} entry={entry} />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>

      {/* Composer */}
      {claimId ? (
        <form onSubmit={onSubmit} className="space-y-3 border-t border-outline-variant pt-5">
          <label
            htmlFor="comm-text"
            className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant"
          >
            New message to payer
          </label>
          <textarea
            id="comm-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={5000}
            placeholder="Ask about a deduction, share a clarification, flag a pending enhancement…"
            className="w-full rounded-lg border border-white bg-surface-container-lowest/50 px-4 py-3 text-body-sm text-on-surface placeholder:text-outline-variant shadow-sm outline-none transition-all focus:border-primary-container focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary-container"
          />
          <div className="flex items-center justify-between">
            <span className="text-body-sm text-on-surface-variant">
              {text.length}/5000
            </span>
            <button
              type="submit"
              disabled={!canSend}
              className="btn-primary"
              style={{ padding: '12px 22px', fontSize: '13px' }}
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
              >
                send
              </span>
              {sending ? 'Sending…' : 'Send to payer'}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function TimelineRow({ entry }: { entry: CommunicationEntry }): JSX.Element {
  const isOutbound = entry.direction === 'outbound';
  const time = new Date(entry.occurredAt).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="mt-1 inline-flex h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: isOutbound ? 'var(--mat-sys-primary)' : '#FAA719' }}
      />
      <div className="flex-1">
        <div className="flex items-center gap-2 text-body-sm text-on-surface-variant">
          <span className="font-medium text-on-surface">
            {isOutbound ? 'You sent' : 'Payer sent'}
          </span>
          <span>·</span>
          <span>{time}</span>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-body text-on-surface">{entry.text}</p>
      </div>
    </li>
  );
}

function groupByDay(entries: CommunicationEntry[]): Array<[string, CommunicationEntry[]]> {
  const buckets = new Map<string, CommunicationEntry[]>();
  for (const e of entries) {
    const day = new Date(e.occurredAt).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
    const arr = buckets.get(day) ?? [];
    arr.push(e);
    buckets.set(day, arr);
  }
  return Array.from(buckets.entries());
}
