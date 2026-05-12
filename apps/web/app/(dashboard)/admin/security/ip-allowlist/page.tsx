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
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header className="glass rounded-xl p-6">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">shield_lock</span>
          <h2 className="text-h2 font-h2 text-on-surface">IP allowlist</h2>
        </div>
        <p className="mt-2 text-body text-on-surface-variant">
          Restrict sign-in to specific networks. Empty list = no restriction. Platform admins
          always bypass this.
        </p>
      </header>

      <section className="glass rounded-xl p-6">
        {loading ? (
          <p className="text-body text-on-surface-variant">Loading…</p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <label htmlFor="cidrs" className="block">
              <span className="mb-2 block text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                CIDR ranges — one per line, IPv4 or IPv6
              </span>
              <textarea
                id="cidrs"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                placeholder="203.0.113.0/24&#10;2001:db8::/32"
                className="glass-input glass-input--sm resize-none font-mono"
              />
            </label>
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="btn-primary"
                style={{ padding: '10px 22px', fontSize: '13px' }}
              >
                <span className="material-symbols-outlined text-[18px]">save</span>
                {saving ? 'Saving…' : 'Save'}
              </button>
              {savedAt ? (
                <span className="flex items-center gap-1 text-body-sm font-medium text-green-700">
                  <span className="material-symbols-outlined text-[16px]">check_circle</span>
                  Saved at {savedAt.toLocaleTimeString()}
                </span>
              ) : null}
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
