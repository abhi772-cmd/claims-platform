'use client';

import {
  type TenantCommsConfig,
  type TenantCommsConfigSummary,
  type TenantSmsProvider,
} from '@claims/contracts';
import { useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { CommsConfigApi } from '../../../../lib/api/comms-config.api';

export default function CommsConfigPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [summary, setSummary] = useState<TenantCommsConfigSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // SMTP form state.
  const [smtpEnabled, setSmtpEnabled] = useState(false);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpUsername, setSmtpUsername] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpIgnoreTls, setSmtpIgnoreTls] = useState(false);

  // SMS form state.
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsProvider, setSmsProvider] = useState<TenantSmsProvider>('console');
  const [smsApiKey, setSmsApiKey] = useState('');
  const [smsSenderId, setSmsSenderId] = useState('');

  useEffect(() => {
    let cancelled = false;
    CommsConfigApi.get()
      .then((s) => {
        if (cancelled) return;
        setSummary(s);
        if (s.smtp && s.smtp.source === 'tenant') {
          setSmtpEnabled(true);
          setSmtpHost(s.smtp.host);
          setSmtpPort(String(s.smtp.port));
          setSmtpFrom(s.smtp.from);
          setSmtpUsername(s.smtp.username ?? '');
          setSmtpSecure(Boolean(s.smtp.secure));
          setSmtpIgnoreTls(Boolean(s.smtp.ignoreTls));
        }
        if (s.sms && s.sms.source === 'tenant') {
          setSmsEnabled(true);
          setSmsProvider(s.sms.provider);
          setSmsSenderId(s.sms.senderId ?? '');
        }
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
    setSaving(true);
    try {
      const patch: TenantCommsConfig = {};
      if (smtpEnabled) {
        patch.smtp = {
          host: smtpHost.trim(),
          port: Number(smtpPort),
          from: smtpFrom.trim(),
          ...(smtpUsername.trim() ? { username: smtpUsername.trim() } : {}),
          ...(smtpPassword ? { password: smtpPassword } : {}),
          secure: smtpSecure,
          ignoreTls: smtpIgnoreTls,
        };
      } else {
        patch.smtp = null;
      }
      if (smsEnabled) {
        patch.sms = {
          provider: smsProvider,
          ...(smsApiKey ? { apiKey: smsApiKey } : {}),
          ...(smsSenderId.trim() ? { senderId: smsSenderId.trim() } : {}),
        };
      } else {
        patch.sms = null;
      }
      const next = await CommsConfigApi.patch(patch);
      setSummary(next);
      setSmtpPassword('');
      setSmsApiKey('');
      setSavedAt(new Date());
    } catch (err) {
      showApiError(err);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="glass max-w-md rounded-xl p-6">
        <p className="text-body text-on-surface-variant">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="glass rounded-xl p-6">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">forum</span>
          <h2 className="text-h2 font-h2 text-on-surface">Communication channels</h2>
        </div>
        <p className="mt-2 text-body text-on-surface-variant">
          Configure your tenant&apos;s SMTP relay and SMS provider. Leaving a section disabled
          falls back to the platform defaults.
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        {/* SMTP block */}
        <section className="glass space-y-4 rounded-xl p-6">
          <header className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">mail</span>
              <h3 className="text-h3 font-h3 text-on-surface">SMTP</h3>
            </div>
            <span className="rounded-full border border-outline-variant/50 bg-surface-container-low px-3 py-1 text-body-sm font-medium text-on-surface-variant">
              source: {summary?.smtp?.source ?? '—'}
            </span>
          </header>
          <label className="flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-outline-variant/40 bg-surface-container-lowest/60 px-3 py-2 text-body-sm text-on-surface">
            <input
              type="checkbox"
              checked={smtpEnabled}
              onChange={(e) => setSmtpEnabled(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Override platform defaults
          </label>
          {smtpEnabled ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Host">
                <input
                  type="text"
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  required
                  className="glass-input glass-input--sm"
                />
              </Field>
              <Field label="Port">
                <input
                  type="number"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(e.target.value)}
                  required
                  className="glass-input glass-input--sm font-mono tabular-nums"
                />
              </Field>
              <Field label="From address">
                <input
                  type="email"
                  value={smtpFrom}
                  onChange={(e) => setSmtpFrom(e.target.value)}
                  required
                  className="glass-input glass-input--sm"
                />
              </Field>
              <Field label="Username (optional)">
                <input
                  type="text"
                  value={smtpUsername}
                  onChange={(e) => setSmtpUsername(e.target.value)}
                  className="glass-input glass-input--sm"
                />
              </Field>
              <Field
                label={
                  summary?.smtp?.passwordSet
                    ? 'Password (leave blank to keep current)'
                    : 'Password'
                }
              >
                <input
                  type="password"
                  value={smtpPassword}
                  onChange={(e) => setSmtpPassword(e.target.value)}
                  className="glass-input glass-input--sm"
                />
              </Field>
              <div className="col-span-1 flex gap-4 text-body-sm text-on-surface sm:col-span-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={smtpSecure}
                    onChange={(e) => setSmtpSecure(e.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                  TLS (port 465)
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={smtpIgnoreTls}
                    onChange={(e) => setSmtpIgnoreTls(e.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                  Ignore TLS (dev relay only)
                </label>
              </div>
            </div>
          ) : null}
        </section>

        {/* SMS block */}
        <section className="glass space-y-4 rounded-xl p-6">
          <header className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">sms</span>
              <h3 className="text-h3 font-h3 text-on-surface">SMS</h3>
            </div>
            <span className="rounded-full border border-outline-variant/50 bg-surface-container-low px-3 py-1 text-body-sm font-medium text-on-surface-variant">
              source: {summary?.sms?.source ?? '—'}
            </span>
          </header>
          <label className="flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-outline-variant/40 bg-surface-container-lowest/60 px-3 py-2 text-body-sm text-on-surface">
            <input
              type="checkbox"
              checked={smsEnabled}
              onChange={(e) => setSmsEnabled(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Override platform defaults
          </label>
          {smsEnabled ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Provider">
                <div className="relative">
                  <select
                    value={smsProvider}
                    onChange={(e) => setSmsProvider(e.target.value as TenantSmsProvider)}
                    className="glass-input glass-input--sm appearance-none pr-10"
                  >
                    <option value="console">Console (logs only)</option>
                    <option value="textguru">TextGuru</option>
                  </select>
                  <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
                    expand_more
                  </span>
                </div>
              </Field>
              <Field label="Sender ID (6-character alpha)">
                <input
                  type="text"
                  value={smsSenderId}
                  onChange={(e) => setSmsSenderId(e.target.value)}
                  className="glass-input glass-input--sm"
                />
              </Field>
              <Field
                label={
                  summary?.sms?.apiKeySet
                    ? 'API key (leave blank to keep current)'
                    : 'API key'
                }
              >
                <input
                  type="password"
                  value={smsApiKey}
                  onChange={(e) => setSmsApiKey(e.target.value)}
                  className="glass-input glass-input--sm"
                />
              </Field>
            </div>
          ) : null}
        </section>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="btn-primary"
            style={{ padding: '12px 24px', fontSize: '13px' }}
          >
            <span className="material-symbols-outlined text-[18px]">save</span>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {savedAt ? (
            <span className="flex items-center gap-1 text-body-sm font-medium text-green-700">
              <span className="material-symbols-outlined text-[16px]">check_circle</span>
              Saved at {savedAt.toLocaleTimeString()}
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </span>
      {children}
    </label>
  );
}
