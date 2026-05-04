import Link from 'next/link';

export default function UsersAdminPage(): JSX.Element {
  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold text-neutral-800">Users</h2>
        <Link
          href="/admin/users/invite"
          className="rounded-sm bg-primary-600 px-3 py-1.5 text-sm font-medium text-neutral-0 hover:bg-primary-700"
        >
          Invite a user
        </Link>
      </header>
      <p className="text-sm text-neutral-500">
        User list view ships in a follow-up slice. For now, invite users via the button above.
      </p>
    </section>
  );
}
