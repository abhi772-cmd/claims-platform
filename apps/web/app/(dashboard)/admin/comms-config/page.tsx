'use client';

import {
  type TenantCommsConfig,
  type TenantCommsConfigSummary,
  type TenantSmsProvider,
} from '@claims/contracts';
import { useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { CommsConfigApi } from '../../../../lib/api/comms-config.api';

// Per-tenant SMTP + SMS configuration. The summary GET response
// redacts secrets — `passwordSet`/`apiKeySet` flags drive the
// "leave unchanged" vs. "type a new value" UX so admins don't have
// to retype an existing password just to edit, say, the SMTP host.

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
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }

  return (
    <div className="space-y-6 rounded-md bg-neutral-0 p-8 shadow-md">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-800">
          Communication channels
        </h1>
        <p className="text-sm text-neutral-500">
          Configure your tenant&apos;s SMTP relay and SMS provider. Leaving
          a section disabled falls back to the platform defaults.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-8">
        {/* SMTP block */}
        <section className="space-y-3 rounded-sm border border-neutral-200 p-4">
          <header className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700">SMTP</h2>
            <span className="text-xs text-neutral-500">
              Current source: {summary?.smtp?.source ?? '—'}
            </span>
          </header>
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={smtpEnabled}
              onChange={(e) => setSmtpEnabled(e.target.checked)}
            />
            Override platform defaults
          </label>
          {smtpEnabled ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Host">
                <input
                  type="text"
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  required
                  className={inputCls}
                />
              </Field>
              <Field label="Port">
                <input
                  type="number"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(e.target.value)}
                  required
                  className={inputCls}
                />
              </Field>
              <Field label="From address">
                <input
                  type="email"
                  value={smtpFrom}
                  onChange={(e) => setSmtpFrom(e.target.value)}
                  required
                  className={inputCls}
                />
              </Field>
              <Field label="Username (optional)">
                <input
                  type="text"
                  value={smtpUsername}
                  onChange={(e) => setSmtpUsername(e.target.value)}
                  className={inputCls}
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
                  className={inputCls}
                />
              </Field>
              <div className="col-span-2 flex gap-4 text-sm text-neutral-700">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={smtpSecure}
                    onChange={(e) => setSmtpSecure(e.target.checked)}
                  />
                  TLS (port 465)
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={smtpIgnoreTls}
                    onChange={(e) => setSmtpIgnoreTls(e.target.checked)}
                  />
                  Ignore TLS (dev relay only)
                </label>
              </div>
            </div>
          ) : null}
        </section>

        {/* SMS block */}
        <section className="space-y-3 rounded-sm border border-neutral-200 p-4">
          <header className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700">SMS</h2>
            <span className="text-xs text-neutral-500">
              Current source: {summary?.sms?.source ?? '—'}
            </span>
          </header>
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={smsEnabled}
              onChange={(e) => setSmsEnabled(e.target.checked)}
            />
            Override platform defaults
          </label>
          {smsEnabled ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Provider">
                <select
                  value={smsProvider}
                  onChange={(e) => setSmsProvider(e.target.value as TenantSmsProvider)}
                  className={inputCls}
                >
                  <option value="console">Console (logs only)</option>
                  <option value="textguru">TextGuru</option>
                </select>
              </Field>
              <Field label="Sender ID (6-character alpha)">
                <input
                  type="text"
                  value={smsSenderId}
                  onChange={(e) => setSmsSenderId(e.target.value)}
                  className={inputCls}
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
                  className={inputCls}
                />
              </Field>
            </div>
          ) : null}
        </section>

        <div className="flex items-center gap-3">
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
        </div>
      </form>
    </div>
  );
}

const inputCls =
  'w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none';

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block space-y-1 text-sm text-neutral-700">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}
