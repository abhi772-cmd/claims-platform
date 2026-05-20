'use client';

// Room rate catalog — admin CRUD.
//
// The tenant's own catalog of room categories with default rates.
// Per-payer overrides are managed elsewhere (in the commercial terms
// drawer at /admin/onboarding/payer-commercial-terms) — this page
// only manages the underlying catalog rows.
//
// Soft-delete via active=false so historical cases that captured a
// rate against a category keep their audit context.

import { type RoomCategory } from '@claims/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { LoadingShimmer } from '../../../../components/ui/LoadingShimmer';
import { useToast } from '../../../../components/toast/ToastProvider';
import { RoomCategoryApi } from '../../../../lib/api/room-category.api';

interface EditState {
  // Null = creating; non-null = editing the row with that id.
  id: string | null;
  code: string;
  name: string;
  category: string;
  dailyRateRupees: string;
  sortOrder: string;
}

const EMPTY_EDIT: EditState = {
  id: null,
  code: '',
  name: '',
  category: '',
  dailyRateRupees: '',
  sortOrder: '0',
};

export default function RoomCategoriesPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<RoomCategory[]>([]);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await RoomCategoryApi.listAdmin();
      setRows(res.categories);
    } catch (err) {
      showApiError(err);
    } finally {
      setLoading(false);
    }
  }, [showApiError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!edit) return;
    setSaving(true);
    try {
      const rupees = Number(edit.dailyRateRupees);
      if (!Number.isFinite(rupees) || rupees < 0) {
        showApiError(new Error('Daily rate must be a non-negative number.'));
        return;
      }
      const dailyRatePaise = Math.round(rupees * 100);
      const sortOrder = Number(edit.sortOrder) || 0;

      if (edit.id === null) {
        await RoomCategoryApi.create({
          code: edit.code.trim().toUpperCase(),
          name: edit.name.trim(),
          category: edit.category.trim(),
          dailyRatePaise,
          sortOrder,
        });
        showToast({ tone: 'success', message: 'Category created.' });
      } else {
        await RoomCategoryApi.update(edit.id, {
          name: edit.name.trim(),
          category: edit.category.trim(),
          dailyRatePaise,
          sortOrder,
        });
        showToast({ tone: 'success', message: 'Category updated.' });
      }
      setEdit(null);
      await refresh();
    } catch (err) {
      showApiError(err);
    } finally {
      setSaving(false);
    }
  }

  async function onDeactivate(row: RoomCategory): Promise<void> {
    if (!row.active) return;
    try {
      await RoomCategoryApi.deactivate(row.id);
      showToast({
        tone: 'success',
        message: `Deactivated "${row.name}". Existing cases keep their captured rate.`,
      });
      await refresh();
    } catch (err) {
      showApiError(err);
    }
  }

  async function onReactivate(row: RoomCategory): Promise<void> {
    if (row.active) return;
    try {
      await RoomCategoryApi.update(row.id, { active: true });
      showToast({ tone: 'success', message: `Reactivated "${row.name}".` });
      await refresh();
    } catch (err) {
      showApiError(err);
    }
  }

  if (loading) {
    return <LoadingShimmer variant="page" label="Loading room catalog" />;
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 text-body-sm text-on-surface-variant">
          <Link href="/admin/onboarding" className="hover:text-primary">
            Onboarding
          </Link>
          <span>/</span>
          <span className="text-on-surface">Room catalog</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <div>
            <h2 className="text-h2 font-h2 text-primary">Room catalog</h2>
            <p className="mt-1 max-w-2xl text-body text-on-surface-variant">
              The hospital&apos;s room categories with default cash rates. Per-payer
              negotiated rates are configured in the{' '}
              <Link
                href="/admin/onboarding/payer-commercial-terms"
                className="text-primary hover:underline"
              >
                commercial terms drawer
              </Link>{' '}
              for each payer.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEdit({ ...EMPTY_EDIT })}
            className="btn-cta whitespace-nowrap"
          >
            <span
              className="material-symbols-outlined mr-1 text-[18px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              add
            </span>
            New category
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="glass overflow-hidden rounded-xl">
        <table className="w-full text-left">
          <thead className="border-b border-outline-variant/40 bg-surface-container-lowest/50 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            <tr>
              <th className="px-5 py-3">Code</th>
              <th className="px-5 py-3">Name</th>
              <th className="px-5 py-3">Category</th>
              <th className="px-5 py-3 text-right">Default rate</th>
              <th className="px-5 py-3 text-center">Sort</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-5 py-12 text-center text-body-sm text-on-surface-variant"
                >
                  No room categories yet. Add your first one to enable the room-rate
                  dropdown on intake.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-outline-variant/30 last:border-b-0 transition-colors hover:bg-primary-fixed/5"
                >
                  <td className="px-5 py-3 font-mono text-[12px] text-on-surface">{row.code}</td>
                  <td className="px-5 py-3 text-body text-on-surface">{row.name}</td>
                  <td className="px-5 py-3 text-body-sm text-on-surface-variant">
                    {row.category}
                  </td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-body text-on-surface">
                    ₹{(row.dailyRatePaise / 100).toLocaleString('en-IN')}
                  </td>
                  <td className="px-5 py-3 text-center tabular-nums text-body-sm text-on-surface-variant">
                    {row.sortOrder}
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={`inline-flex items-center gap-2 text-body-sm ${
                        row.active ? 'text-on-surface' : 'text-on-surface-variant'
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${
                          row.active ? 'bg-primary' : 'bg-outline'
                        }`}
                      />
                      {row.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="inline-flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          setEdit({
                            id: row.id,
                            code: row.code,
                            name: row.name,
                            category: row.category,
                            dailyRateRupees: String(
                              Math.round(row.dailyRatePaise / 100),
                            ),
                            sortOrder: String(row.sortOrder),
                          })
                        }
                        className="text-body-sm font-semibold text-primary hover:underline"
                      >
                        Edit
                      </button>
                      {row.active ? (
                        <button
                          type="button"
                          onClick={() => void onDeactivate(row)}
                          className="text-body-sm font-semibold text-on-surface-variant hover:text-error"
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void onReactivate(row)}
                          className="text-body-sm font-semibold text-on-surface-variant hover:text-primary"
                        >
                          Reactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Edit / create dialog */}
      {edit ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setEdit(null)}
            className="absolute inset-0 bg-on-surface/40 backdrop-blur-sm"
          />
          <form
            onSubmit={onSubmit}
            className="relative z-10 w-full max-w-[540px] rounded-xl bg-surface p-6 shadow-2xl"
          >
            <h3 className="text-h3 font-h3 text-on-surface">
              {edit.id === null ? 'New room category' : 'Edit room category'}
            </h3>
            <div className="mt-4 flex flex-col gap-4">
              <FormField
                label="Code"
                hint="Upper-snake; unique per tenant. Cannot be changed after creation."
              >
                <input
                  required
                  disabled={edit.id !== null}
                  value={edit.code}
                  onChange={(e) =>
                    setEdit({ ...edit, code: e.target.value.toUpperCase() })
                  }
                  placeholder="GENERAL_WARD"
                  className="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 font-mono text-body text-on-surface outline-none focus:border-primary disabled:opacity-60"
                />
              </FormField>
              <FormField label="Name" hint="Free text — shown on the intake dropdown.">
                <input
                  required
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                  placeholder="General ward"
                  className="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-body text-on-surface outline-none focus:border-primary"
                />
              </FormField>
              <FormField
                label="Category"
                hint="Free text used to group on the dropdown (e.g. ward / private / icu)."
              >
                <input
                  required
                  value={edit.category}
                  onChange={(e) => setEdit({ ...edit, category: e.target.value })}
                  placeholder="ward"
                  className="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-body text-on-surface outline-none focus:border-primary"
                />
              </FormField>
              <div className="grid grid-cols-2 gap-4">
                <FormField label="Default rate (₹/day)" hint="Cash / un-negotiated rate.">
                  <input
                    required
                    inputMode="numeric"
                    value={edit.dailyRateRupees}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        dailyRateRupees: e.target.value.replace(/[^0-9.]/g, ''),
                      })
                    }
                    placeholder="5000"
                    className="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 font-mono text-body tabular-nums text-on-surface outline-none focus:border-primary"
                  />
                </FormField>
                <FormField label="Sort order" hint="Lower numbers appear first.">
                  <input
                    inputMode="numeric"
                    value={edit.sortOrder}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        sortOrder: e.target.value.replace(/[^0-9]/g, ''),
                      })
                    }
                    className="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 font-mono text-body tabular-nums text-on-surface outline-none focus:border-primary"
                  />
                </FormField>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setEdit(null)}
                className="rounded-full border border-outline-variant px-5 py-2 text-body-sm text-on-surface transition-colors hover:bg-on-surface/5"
              >
                Cancel
              </button>
              <button type="submit" disabled={saving} className="btn-cta disabled:opacity-50">
                {saving ? 'Saving…' : edit.id === null ? 'Create' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11px] text-on-surface-variant">{hint}</p> : null}
    </div>
  );
}
