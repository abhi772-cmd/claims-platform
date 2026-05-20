'use client';

// Room rate matrix sub-form. One row per active room category;
// admin types the negotiated rupee rate for THIS payer. Empty input
// means "no override for this payer" — intake falls back to the
// catalog default. Category default rate is shown as a hint so the
// admin can see the unmodified rate while keying.

import { type RoomCategory } from '@claims/contracts';

interface Props {
  categories: RoomCategory[];
  rates: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

export function RoomRateMatrix({ categories, rates, onChange }: Props): JSX.Element {
  if (categories.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-outline-variant bg-surface-container-lowest/40 p-4 text-body-sm text-on-surface-variant">
        No active room categories yet.{' '}
        <a href="/admin/room-categories" className="text-primary hover:underline">
          Add categories first
        </a>{' '}
        — every active payer needs a rate per active category to complete this step.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-outline-variant/40">
      <table className="w-full text-left">
        <thead className="bg-surface-container-lowest/60 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
          <tr>
            <th className="px-4 py-2.5">Category</th>
            <th className="px-4 py-2.5">Default rate</th>
            <th className="px-4 py-2.5">Payer-negotiated rate (₹/day)</th>
          </tr>
        </thead>
        <tbody>
          {categories.map((c) => (
            <tr
              key={c.id}
              className="border-t border-outline-variant/30 transition-colors hover:bg-primary-fixed/5"
            >
              <td className="px-4 py-3">
                <div className="font-medium text-on-surface">{c.name}</div>
                <div className="text-[12px] text-on-surface-variant">{c.category}</div>
              </td>
              <td className="px-4 py-3 font-mono tabular-nums text-body-sm text-on-surface-variant">
                ₹{(c.dailyRatePaise / 100).toLocaleString('en-IN')}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-on-surface-variant">₹</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={rates[c.id] ?? ''}
                    onChange={(e) =>
                      onChange({
                        ...rates,
                        [c.id]: e.target.value.replace(/[^0-9.]/g, ''),
                      })
                    }
                    placeholder="default applies"
                    className="w-40 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-1.5 text-body tabular-nums text-on-surface outline-none focus:border-primary"
                  />
                  <span className="text-body-sm text-on-surface-variant">/day</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
