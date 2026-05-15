'use client';

// T2-15 — IRDAI SLA pill. Renders the live state of a single phase
// (preauth or claim) with colour, time remaining, and an icon. Used
// on the case-detail hero and the case-list cards.
//
// Visual rules:
//   on_track → primary teal, clock icon, "Xm left"
//   at_risk  → amber, timelapse icon, "Xm left"
//   breached → error red, alarm icon, "Xm overdue"
//   met      → primary teal w/ check, "Met"
//   missed   → error red w/ alarm, "Missed by Xm"
//
// Ticks every 30s while pending so the operator sees the timer drain
// without refreshing. Pure-React; no API calls. The deadlineAt comes
// from the server (computed at request time) and the pill recomputes
// msUntilDeadline locally.

import { type SlaState } from '@claims/contracts';
import { useEffect, useState } from 'react';

interface Props {
  sla: SlaState;
  // Compact mode for case-list cards (icon + minutes only).
  compact?: boolean;
}

function fmtMinutes(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const PHASE_LABEL = {
  preauth: 'Preauth',
  claim: 'Claim',
} as const;

export function SlaPill({ sla, compact = false }: Props): JSX.Element {
  // Live tick: re-render every 30s for pending statuses so the timer
  // visibly drains. Settled statuses (met / missed) are static.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (sla.status === 'met' || sla.status === 'missed') return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [sla.status]);

  // Recompute msUntilDeadline locally so the pill ticks even though
  // the API value is from request-time.
  const liveMs =
    sla.status === 'met' || sla.status === 'missed'
      ? null
      : new Date(sla.deadlineAt).getTime() - Date.now();

  const { tone, icon, label } = derive(sla, liveMs);

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] tabular-nums ${tone}`}
        title={`${PHASE_LABEL[sla.phase]} SLA: ${label}`}
      >
        <span className="material-symbols-outlined text-[14px]">{icon}</span>
        {label}
      </span>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-body-sm ${tone}`}
    >
      <span className="material-symbols-outlined text-[16px]">{icon}</span>
      <span className="font-medium">{PHASE_LABEL[sla.phase]} SLA</span>
      <span className="font-mono tabular-nums">{label}</span>
    </div>
  );
}

function derive(
  sla: SlaState,
  liveMs: number | null,
): { tone: string; icon: string; label: string } {
  switch (sla.status) {
    case 'on_track': {
      const remaining = liveMs ?? 0;
      return {
        tone: 'border-primary/30 bg-primary/10 text-primary',
        icon: 'schedule',
        label: `${fmtMinutes(remaining)} left`,
      };
    }
    case 'at_risk': {
      const remaining = liveMs ?? 0;
      return {
        tone: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
        icon: 'timelapse',
        label: `${fmtMinutes(remaining)} left`,
      };
    }
    case 'breached': {
      const overdue = Math.abs(liveMs ?? 0);
      return {
        tone: 'border-error/30 bg-error/10 text-error',
        icon: 'alarm',
        label: `${fmtMinutes(overdue)} overdue`,
      };
    }
    case 'met':
      return {
        tone: 'border-primary/30 bg-primary/10 text-primary',
        icon: 'task_alt',
        label: 'Met',
      };
    case 'missed': {
      const decidedMs = sla.decidedAt
        ? new Date(sla.decidedAt).getTime() - new Date(sla.deadlineAt).getTime()
        : 0;
      return {
        tone: 'border-error/30 bg-error/10 text-error',
        icon: 'alarm_off',
        label: `Missed by ${fmtMinutes(decidedMs)}`,
      };
    }
  }
}
