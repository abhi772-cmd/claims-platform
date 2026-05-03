'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuthApi } from '../../../lib/api/auth.api';
import { ApiError } from '../../../lib/api/client';

export default function DashboardPage(): JSX.Element {
  const router = useRouter();
  const { showApiError } = useErrorModal();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => AuthApi.me(signal),
  });

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.problem.status === 401) {
      router.replace('/login');
      return;
    }
    if (me.error) showApiError(me.error);
  }, [me.error, router, showApiError]);

  if (me.isLoading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }
  if (!me.data) return <></>;

  return (
    <section className="space-y-2">
      <h2 className="text-2xl font-semibold text-neutral-800">
        Welcome, {me.data.firstName} {me.data.lastName}.
      </h2>
      <p className="text-sm text-neutral-500">
        {me.data.tenantDisplayName} · roles: {me.data.roles.join(', ') || '—'}
      </p>
      {me.data.mustChangePassword ? (
        <p className="rounded-sm bg-warning-50 px-3 py-2 text-sm text-warning-700">
          You should change your password before continuing real work.
        </p>
      ) : null}
    </section>
  );
}
