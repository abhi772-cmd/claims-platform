import Link from 'next/link';

export default function UsersAdminPage(): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      <header className="glass flex flex-col items-start justify-between gap-4 rounded-xl p-6 md:flex-row md:items-center">
        <div>
          <h2 className="text-h2 font-h2 text-on-surface">Users</h2>
          <p className="mt-1 text-body text-on-surface-variant">
            Invite teammates and assign roles. A full user list view ships in a follow-up slice.
          </p>
        </div>
        <Link href="/admin/users/invite" className="btn-cta" style={{ padding: '10px 22px' }}>
          <span
            className="material-symbols-outlined"
            style={{ fontSize: 20, fontVariationSettings: "'FILL' 1" }}
          >
            person_add
          </span>
          Invite a user
        </Link>
      </header>

      <section className="glass rounded-xl p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-fixed-dim/30 text-primary">
            <span className="material-symbols-outlined">group</span>
          </div>
          <div>
            <h3 className="text-body font-semibold text-on-surface">User directory — coming soon</h3>
            <p className="mt-1 text-body-sm text-on-surface-variant">
              For now, invite users via the button above. Invitees get an email (and SMS if a
              mobile number is provided) to accept and set their password.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
