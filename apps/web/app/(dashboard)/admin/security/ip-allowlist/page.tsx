'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuthApi } from '../../../../../lib/api/auth.api';

export default function IpAllowlistPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    AuthApi.getIpAllowlist()
      .then((out) => {
        if (!cancelled) setText(out.cidrs.join('\n'));
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showApiError]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const cidrs = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((l) => l.length > 0);
    setSaving(true);
    try {
      const out = await AuthApi.updateIpAllowlist({ cidrs });
      setText(out.cidrs.join('\n'));
      setSavedAt(new Date());
    } catch (err) {
      showApiError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-md bg-neutral-0 p-8 shadow-md">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-800">IP allowlist</h1>
        <p className="text-sm text-neutral-500">
          Restrict sign-in to specific networks. Empty list = no restriction. Platform admins always
          bypass this.
        </p>
      </header>
      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          <label htmlFor="cidrs" className="text-sm font-medium text-neutral-700">
            CIDR ranges (one per line — IPv4 or IPv6)
          </label>
          <textarea
            id="cidrs"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder="203.0.113.0/24&#10;2001:db8::/32"
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 font-mono text-xs focus:border-primary-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={saving}
            className="rounded-sm bg-primary-600 px-3 py-2 text-sm font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {savedAt ? (
            <p className="text-xs text-success-700">
              Saved at {savedAt.toLocaleTimeString()}.
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
